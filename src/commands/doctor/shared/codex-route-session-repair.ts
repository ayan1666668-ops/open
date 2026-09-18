import fs from "node:fs";
import {
  normalizeOptionalLowercaseString as normalizeString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAgentEffectiveModelPrimary } from "../../../agents/agent-scope.js";
import { listCliRuntimeModelBackendBindings } from "../../../agents/cli-backends.js";
import { resolveDefaultModelForAgent } from "../../../agents/model-selection-config.js";
import { isLegacyCodexProviderId } from "../../../config/legacy-codex-provider.js";
import { getCliSessionBinding } from "../../../config/sessions/cli-session-binding.js";
import {
  applySessionEntryReplacements,
  iterateDoctorSessionKeyBatches,
  scanDoctorSessionEntriesStrict,
  scanDoctorSessionEntriesTolerant,
} from "../../../config/sessions/session-accessor.js";
import { normalizePersistedSessionEntryShape } from "../../../config/sessions/store-entry-shape.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../../../config/sessions/targets.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  loadLegacySessionStore,
  updateLegacySessionStore,
} from "../../../infra/state-migrations.legacy-session-store.js";
import { resolveExecutionSelectionExecutorKind } from "../../../model-picker/apply-session-model-selection.js";
import {
  readSessionExecutionRepairRef,
  admitAutomaticProviderlessModelRepair,
  repairSessionExecutionSelection,
} from "../../../model-picker/execution-selection-repair.js";
import type { ModelExecutionSelection } from "../../../model-picker/execution-selection.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { isValidAgentHarnessSessionStoreEntry } from "../../../sessions/agent-harness-session-key.js";
import {
  isOpenAICodexAuthProfileRef,
  isBlockedLegacyCodexModelPair,
  isBlockedLegacyCodexModelRef,
  isOpenAICodexModelRef,
  isProviderlessModelRef,
  normalizeRuntimeString,
  toCanonicalOpenAIModelRef,
  toOpenAIModelId,
  resolveRuntimeModelRef,
  type LegacyCodexModelIdentity,
} from "./codex-route-model-ref.js";
import type {
  CodexSessionRouteRepairSummary,
  SessionRouteRepairResult,
} from "./codex-route-types.js";
import {
  migrateLegacyRuntimeModelRef,
  resolveLegacyRuntimeModelProviderAlias,
} from "./legacy-runtime-model-providers.js";
import {
  createRetiredModelRefRepairResolver,
  type ModelRefRepairResolver,
} from "./retired-model-ref-repair.js";
import { repairRetiredSessionModelRef } from "./retired-session-model-repair.js";
import {
  repairSessionAuthProfileReferences,
  resolveVerifiedSessionAuthProfileIdMap,
} from "./session-auth-profile-repair.js";
import { migrateSessionExecutionSelection } from "./session-execution-selection.js";

type SessionModelRetirement = {
  cfg: OpenClawConfig;
  agentId: string;
  resolve: ModelRefRepairResolver;
  defaultModelRef?: string;
  warnings: string[];
};

function rewriteSessionModelPair(params: {
  provider?: string;
  model?: string;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): {
  changed: boolean;
  provider?: string;
  model?: string;
  selectionModel?: ModelExecutionSelection["model"];
  executor?: ModelExecutionSelection["executor"];
} {
  const provider = normalizeString(params.provider);
  const model = params.model;
  const legacyProviderModelRef =
    sessionProviderAllowsScopedModelRef(provider) && isOpenAICodexModelRef(model)
      ? model
      : undefined;
  const blockedIdentity =
    isBlockedLegacyCodexModelPair({
      providerId: provider,
      modelId: model,
      blockedModelIdentities: params.blockedModelIdentities,
    }) ||
    (legacyProviderModelRef
      ? isBlockedLegacyCodexModelRef({
          modelRef: legacyProviderModelRef,
          blockedModelIdentities: params.blockedModelIdentities,
        })
      : false);
  if (blockedIdentity) {
    return { changed: false };
  }
  if (isLegacyCodexProviderId(provider)) {
    const modelId = model ? (toOpenAIModelId(model) ?? model) : undefined;
    return {
      changed: true,
      provider: "openai",
      model: modelId ?? model,
      ...(modelId ? { selectionModel: { provider: "openai", id: modelId } } : {}),
      executor: { kind: "harness", id: "codex" },
    };
  }
  const canonicalModel =
    legacyProviderModelRef && toCanonicalOpenAIModelRef(legacyProviderModelRef);
  if (canonicalModel) {
    return {
      changed: true,
      provider: params.provider,
      model: canonicalModel,
      selectionModel: { provider: "openai", id: canonicalModel.slice("openai/".length) },
      executor: { kind: "harness", id: "codex" },
    };
  }
  const scopedRuntimeRef =
    model && (!provider || ["claude-cli", "google-gemini-cli"].includes(provider))
      ? migrateLegacyRuntimeModelRef(model)
      : null;
  const rawRef = scopedRuntimeRef ? model : provider && model ? `${provider}/${model}` : model;
  const migrated = scopedRuntimeRef ?? (rawRef ? migrateLegacyRuntimeModelRef(rawRef) : null);
  if (
    !migrated ||
    (rawRef &&
      isBlockedLegacyCodexModelRef({
        modelRef: rawRef,
        blockedModelIdentities: params.blockedModelIdentities,
      }))
  ) {
    return { changed: false };
  }
  return {
    changed: params.provider !== migrated.provider || params.model !== migrated.model,
    provider: migrated.provider,
    model: migrated.model,
    selectionModel: { provider: migrated.provider, id: migrated.model },
    executor: { kind: migrated.cli ? "cli" : "harness", id: migrated.runtime },
  };
}

function sessionProviderAllowsScopedModelRef(provider: string | undefined): boolean {
  // Canonical "openai" pairs keep raw model ids untouched: a configured
  // OpenAI-compatible model may legitimately be ID'd "codex/<x>". Only an
  // absent or legacy provider field marks the model string as a scoped ref.
  return !provider || isLegacyCodexProviderId(provider);
}

function clearStaleCodexFallbackNotice(
  entry: SessionEntry,
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
): boolean {
  const endpoints = [entry.fallbackNotice?.selectedModel, entry.fallbackNotice?.activeModel];
  const hasBlockedEndpoint = endpoints.some(
    (modelRef) =>
      isOpenAICodexModelRef(modelRef) &&
      isBlockedLegacyCodexModelRef({ modelRef, blockedModelIdentities }),
  );
  if (hasBlockedEndpoint || !endpoints.some(isOpenAICodexModelRef)) {
    return false;
  }
  delete entry.fallbackNotice;
  return true;
}

function resolveProviderlessCodexSessionOverride(
  entry: SessionEntry,
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
): ModelExecutionSelection | undefined {
  const model = admitAutomaticProviderlessModelRepair(entry);
  if (
    !isProviderlessModelRef(model) ||
    !isOpenAICodexAuthProfileRef(entry.authProfileOverride) ||
    entry.authProfileOverrideSource !== "auto" ||
    !model
  ) {
    return undefined;
  }
  const authProvider = normalizeString(entry.authProfileOverride)?.split(":", 1)[0];
  return isBlockedLegacyCodexModelPair({
    providerId: authProvider,
    modelId: model,
    blockedModelIdentities,
  })
    ? undefined
    : { model: { provider: "openai", id: model }, executor: { kind: "harness", id: "codex" } };
}

function resolveMigratedExecutor(id: string): ModelExecutionSelection["executor"] | undefined {
  const alias = resolveLegacyRuntimeModelProviderAlias(id);
  return alias ? { kind: alias.cli ? "cli" : "harness", id: alias.runtime } : undefined;
}

function migrateLegacyClaudeSessionField(
  entry: SessionEntry,
  sessionKey: string,
  warnings?: string[],
): boolean {
  if (entry.claudeCliSessionId === undefined) {
    return false;
  }
  if (!getCliSessionBinding(entry, "claude-cli")) {
    const sessionId = normalizeOptionalString(entry.claudeCliSessionId);
    // An incomplete binding can carry account/checkpoint metadata for another
    // conversation. Preserve it rather than attaching that metadata to a guessed ID.
    const hasUnboundMetadata = Object.entries(entry.cliSessionBindings?.["claude-cli"] ?? {}).some(
      ([key, value]) => key !== "sessionId" && value !== undefined,
    );
    if (!sessionId || hasUnboundMetadata) {
      const warning = `Session ${sessionKey}: legacy Claude CLI binding needs manual reconciliation; legacy binding state was preserved.`;
      if (warnings && !warnings.includes(warning)) {
        warnings.push(warning);
      }
      return false;
    }
    entry.cliSessionBindings = {
      ...entry.cliSessionBindings,
      "claude-cli": { sessionId },
    };
  }
  delete entry.claudeCliSessionId;
  return true;
}

/** Complete account renames or repair legacy session bindings and model routes. */
function repairCodexSessionStoreRoutes(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  store: Record<string, SessionEntry>;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  authProfileIdMap?: ReadonlyMap<string, string>;
  authProfileOnly?: boolean;
  retirement?: SessionModelRetirement;
  legacyEnv?: NodeJS.ProcessEnv;
  warnings?: string[];
}): SessionRouteRepairResult {
  const now = Date.now();
  const sessionKeys: string[] = [];
  const cfg = params.cfg ?? params.retirement?.cfg;
  const cliRuntimeProviders =
    params.legacyEnv && !params.authProfileOnly
      ? new Map(
          listCliRuntimeModelBackendBindings({
            config: cfg,
            env: params.legacyEnv,
            includeSetupRegistry: true,
          }).map(({ runtime, provider }) => [runtime, provider]),
        )
      : undefined;
  for (const [sessionKey, storedEntry] of Object.entries(params.store)) {
    let entry = storedEntry;
    if (!entry) {
      continue;
    }
    if (params.authProfileOnly) {
      if (
        !isValidAgentHarnessSessionStoreEntry(sessionKey, entry) &&
        repairSessionAuthProfileReferences(entry, params.authProfileIdMap)
      ) {
        entry.updatedAt = now;
        sessionKeys.push(sessionKey);
      }
      continue;
    }
    let changedLegacySelection = false;
    if (params.legacyEnv && !isValidAgentHarnessSessionStoreEntry(sessionKey, entry)) {
      try {
        const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? params.agentId;
        const migrated = migrateSessionExecutionSelection({
          entry,
          classifyExecutor: (id) => resolveExecutionSelectionExecutorKind(cfg, id),
          ...(cfg && agentId
            ? {
                defaultProvider: resolveDefaultModelForAgent({
                  cfg,
                  agentId,
                  allowPluginNormalization: false,
                }).provider,
              }
            : {}),
          cliRuntimeProviders,
        });
        const normalized = normalizePersistedSessionEntryShape(migrated.entry, { sessionKey });
        if (!normalized) {
          throw new Error("Session binding is invalid.");
        }
        entry = normalized;
        params.store[sessionKey] = entry;
        changedLegacySelection = migrated.changed;
      } catch {
        const warning = `Session ${sessionKey}: execution selection could not be migrated; original selection was retained.`;
        if (params.warnings && !params.warnings.includes(warning)) {
          params.warnings.push(warning);
        }
        continue;
      }
    }
    const changedCliBinding = migrateLegacyClaudeSessionField(entry, sessionKey, params.warnings);
    if (isValidAgentHarnessSessionStoreEntry(sessionKey, entry)) {
      // Only the binding representation changes; locked identity, route and recency stay owned.
      if (changedCliBinding) {
        sessionKeys.push(sessionKey);
      }
      continue;
    }
    const selected = readSessionExecutionRepairRef(entry);
    const beforeRoute = structuredClone(entry);
    const runtimeModelRoute = rewriteSessionModelPair({
      provider: entry.modelProvider,
      model: entry.model,
      blockedModelIdentities: params.blockedModelIdentities,
    });
    if (runtimeModelRoute.changed) {
      entry.modelProvider = runtimeModelRoute.provider;
      entry.model = runtimeModelRoute.model;
    }
    const overrideModelRoute = rewriteSessionModelPair({
      provider: selected.provider,
      model: selected.model,
      blockedModelIdentities: params.blockedModelIdentities,
    });
    const providerless = resolveProviderlessCodexSessionOverride(
      entry,
      params.blockedModelIdentities,
    );
    const executor = providerless?.executor ?? overrideModelRoute.executor;
    const model = providerless?.model ?? overrideModelRoute.selectionModel;
    const runtimeAliasChanged =
      selected.runtime &&
      resolveMigratedExecutor(selected.runtime)?.id !== selected.runtime &&
      resolveMigratedExecutor(selected.runtime) !== undefined;
    let changedSelection = false;
    if (overrideModelRoute.changed || providerless || executor || runtimeAliasChanged) {
      const repair = repairSessionExecutionSelection({
        entry,
        cfg,
        agentId:
          params.agentId ?? params.retirement?.agentId ?? parseAgentSessionKey(sessionKey)?.agentId,
        model,
        executor,
        runtimeMigration: resolveMigratedExecutor,
      });
      if (repair.status === "unresolved") {
        params.store[sessionKey] = beforeRoute;
        const warning = `Session ${sessionKey}: its executor could not be resolved; model and runtime repair state was retained.`;
        if (params.warnings && !params.warnings.includes(warning)) {
          params.warnings.push(warning);
        }
        const authChanged = repairSessionAuthProfileReferences(
          beforeRoute,
          params.authProfileIdMap,
        );
        if (changedLegacySelection || changedCliBinding || authChanged) {
          beforeRoute.updatedAt = now;
          sessionKeys.push(sessionKey);
        }
        continue;
      }
      changedSelection = repair.status === "repaired";
      if (changedSelection && providerless) {
        delete entry.model;
        delete entry.modelProvider;
        delete entry.contextTokens;
        delete entry.contextTokensSource;
        delete entry.contextBudgetStatus;
      }
    }
    const changedModelRoute = runtimeModelRoute.changed || changedSelection;
    const changedFallbackNotice = clearStaleCodexFallbackNotice(
      entry,
      params.blockedModelIdentities,
    );
    const changedCodexHarness = normalizeRuntimeString(entry.agentHarnessId) === "codex-cli";
    if (changedCodexHarness) {
      entry.agentHarnessId = "codex";
    }
    // Providerless route repair first needs the legacy profile prefix; only the
    // auth migration owner's exact collision-aware map may rewrite its identity.
    const changedAuthProfile = repairSessionAuthProfileReferences(entry, params.authProfileIdMap);
    const changedRetiredModel = params.retirement
      ? repairRetiredSessionModelRef(
          entry,
          params.retirement.agentId,
          params.retirement.resolve,
          params.retirement.defaultModelRef,
          params.retirement.warnings,
          params.retirement.cfg,
        )
      : false;
    if (
      !changedModelRoute &&
      !changedFallbackNotice &&
      !changedCodexHarness &&
      !changedLegacySelection &&
      !changedAuthProfile &&
      !changedRetiredModel &&
      !changedCliBinding
    ) {
      continue;
    }
    entry.updatedAt = now;
    sessionKeys.push(sessionKey);
  }
  return {
    changed: sessionKeys.length > 0,
    sessionKeys,
  };
}

function scanCodexSessionStoreRoutes(
  store: Record<string, SessionEntry>,
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>,
  authProfileIdMap?: ReadonlyMap<string, string>,
  retirement?: SessionModelRetirement,
  warnings?: string[],
  authProfileOnly = false,
  cfg?: OpenClawConfig,
  agentId?: string,
  legacyEnv?: NodeJS.ProcessEnv,
): string[] {
  // Preview executes the same repair against copies, so scanning and mutation
  // cannot disagree about a route, account pin, or retirement condition.
  return repairCodexSessionStoreRoutes({
    cfg,
    agentId,
    store: structuredClone(store),
    blockedModelIdentities,
    authProfileIdMap,
    authProfileOnly,
    retirement,
    warnings,
    legacyEnv,
  }).sessionKeys;
}

/** Scan or repair all configured agent session stores that still contain legacy Codex routes. */
export async function maybeRepairCodexSessionRoutes(params: {
  cfg: OpenClawConfig;
  retiredModelRefConfig?: Pick<OpenClawConfig, "agents" | "models">;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
  authProfileOnly?: boolean;
  codexRuntimeReady?: boolean;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  authProfileIdMap?: ReadonlyMap<string, string>;
}): Promise<CodexSessionRouteRepairSummary> {
  const env = params.env ?? process.env;
  const authProfileOnly = !params.shouldRepair && params.authProfileOnly === true;
  const shouldRepair = params.shouldRepair || authProfileOnly;
  const warnings: string[] = [];
  const sessionTargets = resolveAllAgentSessionStoreTargetsSync(params.cfg, { env });
  const resolveRetired = authProfileOnly
    ? undefined
    : createRetiredModelRefRepairResolver({
        cfg: params.cfg,
        checkModelPolicy: true,
        retiredModelRefConfig: params.retiredModelRefConfig,
        env,
        warnings,
        agentIds: [...new Set(sessionTargets.map((target) => target.agentId))],
      });
  const targets = sessionTargets.flatMap((target) => {
    const defaultModelRef = resolveRetired
      ? resolveAgentEffectiveModelPrimary(params.cfg, target.agentId)
      : undefined;
    const retirement = resolveRetired
      ? {
          cfg: params.cfg,
          agentId: target.agentId,
          resolve: resolveRetired,
          warnings,
          defaultModelRef: defaultModelRef
            ? resolveRuntimeModelRef({
                cfg: params.cfg,
                modelRef: defaultModelRef,
                agentId: target.agentId,
              })
            : undefined,
        }
      : undefined;
    const sessionScope = {
      storePath: target.storePath,
      agentId: target.agentId,
      env,
    };
    const authProfileIdMap = resolveVerifiedSessionAuthProfileIdMap({
      agentId: target.agentId,
      cfg: params.cfg,
      env,
      authProfileIdMap: params.authProfileIdMap,
    });
    if (authProfileOnly && !authProfileIdMap?.size) {
      return [];
    }
    const staleSqliteSessionKeys: string[] = [];
    const scanEntry = ({ entry, sessionKey }: { entry: SessionEntry; sessionKey: string }) => {
      if (
        scanCodexSessionStoreRoutes(
          { [sessionKey]: entry },
          params.blockedModelIdentities,
          authProfileIdMap,
          retirement,
          warnings,
          authProfileOnly,
          params.cfg,
          target.agentId,
        ).length > 0
      ) {
        staleSqliteSessionKeys.push(sessionKey);
      }
    };
    // Preview tolerates malformed legacy rows; repair mode uses strict canonical validation.
    const sqliteEntryCount = shouldRepair
      ? scanDoctorSessionEntriesStrict(sessionScope, scanEntry)
      : scanDoctorSessionEntriesTolerant(sessionScope, scanEntry);
    const hasLegacyStore = !target.storePath.endsWith(".sqlite") && fs.existsSync(target.storePath);
    return sqliteEntryCount > 0 || hasLegacyStore
      ? [
          {
            ...target,
            staleSqliteSessionKeys,
            hasLegacyStore,
            authProfileIdMap,
            retirement,
          },
        ]
      : [];
  });
  if (!shouldRepair) {
    const stale = targets.flatMap((target) => {
      const sessionKeys = new Set(target.staleSqliteSessionKeys);
      if (target.hasLegacyStore) {
        for (const sessionKey of scanCodexSessionStoreRoutes(
          loadLegacySessionStore(target.storePath),
          params.blockedModelIdentities,
          target.authProfileIdMap,
          target.retirement,
          warnings,
          authProfileOnly,
          params.cfg,
          target.agentId,
          env,
        )) {
          sessionKeys.add(sessionKey);
        }
      }
      return Array.from(sessionKeys, (sessionKey) => `${target.agentId}:${sessionKey}`);
    });
    return {
      scannedStores: targets.length,
      repairedStores: 0,
      repairedSessions: 0,
      warnings: [
        ...warnings,
        ...(stale.length > 0
          ? [
              [
                "- Legacy session bindings or retired session model route state detected.",
                `- Affected sessions: ${stale.length}.`,
                "- Run `openclaw doctor --fix` to migrate legacy bindings and stale session model/provider pins across all agent session stores.",
              ].join("\n"),
            ]
          : []),
      ],
      changes: [],
    };
  }
  let repairedStores = 0;
  let repairedSessions = 0;
  for (const target of targets) {
    const repairedSessionKeys = new Set<string>();
    const { staleSqliteSessionKeys } = target;
    for (const sessionKeys of iterateDoctorSessionKeyBatches(staleSqliteSessionKeys)) {
      const result = await applySessionEntryReplacements({
        agentId: target.agentId,
        storePath: target.storePath,
        sessionKeys,
        skipMaintenance: true,
        update: (entries) => {
          const store = Object.fromEntries(
            entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
          );
          const repair = repairCodexSessionStoreRoutes({
            cfg: params.cfg,
            agentId: target.agentId,
            store,
            blockedModelIdentities: params.blockedModelIdentities,
            authProfileIdMap: target.authProfileIdMap,
            authProfileOnly,
            retirement: target.retirement,
            warnings,
          });
          return {
            result: repair,
            replacements: repair.sessionKeys.map((sessionKey) => ({
              sessionKey,
              entry: store[sessionKey]!,
            })),
          };
        },
      });
      for (const sessionKey of result.sessionKeys) {
        repairedSessionKeys.add(sessionKey);
      }
    }

    if (target.hasLegacyStore) {
      const staleLegacySessionKeys = scanCodexSessionStoreRoutes(
        loadLegacySessionStore(target.storePath),
        params.blockedModelIdentities,
        target.authProfileIdMap,
        target.retirement,
        warnings,
        authProfileOnly,
        params.cfg,
        target.agentId,
        env,
      );
      if (staleLegacySessionKeys.length > 0) {
        const result = await updateLegacySessionStore(
          target.storePath,
          (store) =>
            repairCodexSessionStoreRoutes({
              cfg: params.cfg,
              agentId: target.agentId,
              store,
              blockedModelIdentities: params.blockedModelIdentities,
              authProfileIdMap: target.authProfileIdMap,
              authProfileOnly,
              retirement: target.retirement,
              warnings,
              legacyEnv: env,
            }),
          { skipMaintenance: true },
        );
        for (const sessionKey of result.sessionKeys) {
          repairedSessionKeys.add(sessionKey);
        }
      }
    }
    if (repairedSessionKeys.size > 0) {
      repairedStores += 1;
      repairedSessions += repairedSessionKeys.size;
    }
  }
  const repairedScope = `${repairedSessions} session${repairedSessions === 1 ? "" : "s"} across ${repairedStores} store${repairedStores === 1 ? "" : "s"}`;
  return {
    scannedStores: targets.length,
    repairedStores,
    repairedSessions,
    warnings,
    changes:
      repairedSessions > 0
        ? [
            authProfileOnly
              ? `Updated auth-profile references in ${repairedScope}.`
              : `Repaired legacy bindings or retired model routes in ${repairedScope} while preserving auth-profile pins.`,
          ]
        : [],
  };
}
