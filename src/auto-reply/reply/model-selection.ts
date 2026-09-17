/** Model selection state for reply runs, including catalog and override handling. */
import { resolveAgentConfig, resolveAgentDir } from "../../agents/agent-scope.js";
import { isStoredCredentialCompatibleWithAuthProvider } from "../../agents/auth-profiles/order.js";
import { clearSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import { resolveModelProviderAuthConfig } from "../../agents/model-auth-provider-route.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { ModelFallbackRouteResolution } from "../../agents/model-fallback.types.js";
import {
  type ModelAliasIndex,
  normalizeProviderId,
  resolveReasoningDefault,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import { resolveConfiguredThinkingDefault } from "../../agents/model-thinking-default.js";
import {
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "../../agents/model-visibility-policy.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../../agents/openai-routing.js";
import {
  needsThinkHydration,
  resolveEffectiveAgentRuntime,
} from "../../agents/thinking-runtime.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { SessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import { adoptPersistedSessionSnapshot } from "../../config/sessions/session-snapshot-merge.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isDiagnosticFlagEnabled } from "../../infra/diagnostic-flags.js";
import { getSessionExecutionSelection } from "../../model-picker/execution-selection.js";
import {
  isAcpExecutionSelection,
  isModelExecutionSelection,
  type ExecutionSelection,
  type SessionExecutionSelection,
} from "../../model-picker/execution-selection.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import type { ThinkLevel } from "../thinking.shared.js";
import {
  findSelectedCatalogEntry,
  mergePreparedConfiguredCatalog,
  resolveRuntimeNormalization,
} from "./model-runtime-normalization.js";
export {
  resolveModelDirectiveSelection,
  type ModelDirectiveSelection,
} from "./model-selection-directive.js";
export { resolveContextTokens } from "./model-selection-context.js";

type ModelCatalog = ModelCatalogEntry[];

type ThinkingDefaultSelection = {
  provider: string;
  model: string;
  agentRuntime?: string | null;
};

type ModelSelectionState = {
  provider: string;
  model: string;
  executionSelection?: ExecutionSelection;
  sessionExecutionSelection: SessionExecutionSelection | undefined;
  requestedRouteResolution: ModelFallbackRouteResolution;
  modelPolicy: ModelVisibilityPolicy;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: ModelCatalog;
  policyAliasIndex: ModelAliasIndex;
  modelPolicyConfigPath?: string;
  modelPolicyRepairConfigPath?: string;
  resolveThinkingCatalog: (
    selection?: ThinkingDefaultSelection,
  ) => Promise<ModelCatalog | undefined>;
  resolveDefaultThinkingLevel: (selection?: ThinkingDefaultSelection) => Promise<ThinkLevel>;
  hasConfiguredThinkingDefault?: boolean;
  /** Default reasoning level from model capability: "on" if model has reasoning, else "off". */
  resolveDefaultReasoningLevel: (selection?: ThinkingDefaultSelection) => Promise<"on" | "off">;
  needsModelCatalog: boolean;
  modelContextWindow?: number;
  modelContextTokens?: number;
};

const modelCatalogRuntimeLoader = createLazyImportLoader(
  () => import("../../agents/model-catalog.runtime.js"),
);
const sessionPersistenceRuntimeLoader = createLazyImportLoader(
  () => import("./session-entry-persistence.js"),
);

function loadPreparedModelCatalogRuntime() {
  return modelCatalogRuntimeLoader.load();
}

function loadSessionPersistenceRuntime() {
  return sessionPersistenceRuntimeLoader.load();
}

/** Resolves provider/model, allowlist, catalog, and thinking defaults for a reply run. */
export async function createModelSelectionState(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentCfg: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  parentSessionKey?: string;
  storePath?: string;
  defaultProvider: string;
  defaultModel: string;
  primaryProvider?: string;
  primaryModel?: string;
  provider: string;
  model: string;
  hasModelDirective: boolean;
  hasOneTurnModelOverride?: boolean;
  skipStoredModelOverride?: boolean;
  /** True when heartbeat.model was explicitly resolved for this run.
   *  In that case, skip session-stored overrides so the heartbeat selection wins. */
  hasResolvedHeartbeatModelOverride?: boolean;
  isHeartbeat?: boolean;
  preparedModelCatalog?: ModelCatalogSnapshot;
}): Promise<ModelSelectionState> {
  const timingEnabled = isDiagnosticFlagEnabled("ingress.timing", params.cfg);
  const startMs = timingEnabled ? Date.now() : 0;
  const logStage = (stage: string, extra?: string) => {
    if (!timingEnabled) {
      return;
    }
    const suffix = extra ? ` ${extra}` : "";
    console.log(
      `[model-selection] session=${params.sessionKey ?? "(no-session)"} stage=${stage} elapsedMs=${Date.now() - startMs}${suffix}`,
    );
  };
  const {
    cfg,
    agentCfg,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultProvider,
    defaultModel,
  } = params;
  const loadRuntimeCatalogSnapshot = async (): Promise<ModelCatalogSnapshot> =>
    params.preparedModelCatalog ??
    (await (
      await loadPreparedModelCatalogRuntime()
    ).loadPreparedModelCatalogSnapshot({
      config: cfg,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      readOnly: true,
    }));
  const runtimeModelNormalization = resolveRuntimeNormalization(cfg);

  let provider = params.provider;
  let model = params.model;
  const hasOneTurnModelOverride = params.hasOneTurnModelOverride === true;
  const agentEntry = params.agentId ? resolveAgentConfig(cfg, params.agentId) : undefined;

  let visibilityPolicy: ModelVisibilityPolicy = createModelVisibilityPolicy({
    cfg,
    catalog: [],
    defaultProvider,
    defaultModel: { provider: defaultProvider, model: defaultModel },
    agentId: params.agentId,
    ...runtimeModelNormalization,
  });
  const hasAllowlist = !visibilityPolicy.allowAny;
  const hasConfiguredModels =
    Object.keys(agentCfg?.models ?? {}).length > 0 ||
    Object.keys(agentEntry?.models ?? {}).length > 0;
  const defaultModelVisibleByWildcard = visibilityPolicy.allowsByWildcard({
    provider: defaultProvider,
    model: defaultModel,
  });
  const configuredModelCatalog = mergePreparedConfiguredCatalog({
    configured: [...visibilityPolicy.configuredCatalog],
    prepared: params.preparedModelCatalog?.entries,
  });
  const needsModelCatalog =
    params.hasModelDirective ||
    (hasAllowlist && visibilityPolicy.hasProviderWildcards && !defaultModelVisibleByWildcard);

  let allowedModelKeys = new Set<string>();
  let allowedModelCatalog: ModelCatalog = configuredModelCatalog;
  let modelCatalog: ModelCatalog | null = null;
  // Whether the loaded catalog is a complete/live snapshot. A degraded catalog
  // (discovery threw, static/empty fallback) must not destroy a pinned override.
  let catalogAuthoritative = true;
  const acceptedSelection = getSessionExecutionSelection(sessionEntry);
  if (needsModelCatalog) {
    const catalogSnapshot = await loadRuntimeCatalogSnapshot();
    modelCatalog = catalogSnapshot.entries;
    // Only an explicit false is degraded; absent means authoritative.
    catalogAuthoritative = catalogSnapshot.authoritative !== false;
    logStage(
      "catalog-loaded",
      `entries=${modelCatalog.length} authoritative=${catalogAuthoritative}`,
    );
    visibilityPolicy = createModelVisibilityPolicy({
      cfg,
      catalog: modelCatalog,
      defaultProvider,
      defaultModel: { provider: defaultProvider, model: defaultModel },
      agentId: params.agentId,
      ...runtimeModelNormalization,
    });
    allowedModelCatalog = visibilityPolicy.allowedCatalog;
    allowedModelKeys = visibilityPolicy.allowedKeys;
    logStage(
      "allowlist-built",
      `allowed=${allowedModelCatalog.length} keys=${allowedModelKeys.size}`,
    );
  } else if (hasAllowlist || hasConfiguredModels || configuredModelCatalog.length > 0) {
    visibilityPolicy = createModelVisibilityPolicy({
      cfg,
      catalog: configuredModelCatalog,
      defaultProvider,
      defaultModel: { provider: defaultProvider, model: defaultModel },
      agentId: params.agentId,
      ...runtimeModelNormalization,
    });
    allowedModelCatalog = visibilityPolicy.allowedCatalog;
    allowedModelKeys = visibilityPolicy.allowedKeys;
    logStage(
      "configured-allowlist-built",
      `allowed=${allowedModelCatalog.length} keys=${allowedModelKeys.size}`,
    );
  }

  const turnLocalSelection =
    params.skipStoredModelOverride === true ||
    hasOneTurnModelOverride ||
    params.hasResolvedHeartbeatModelOverride === true;
  let executionSelection =
    acceptedSelection && !isAcpExecutionSelection(acceptedSelection)
      ? acceptedSelection
      : undefined;
  if (executionSelection && isModelExecutionSelection(executionSelection) && !turnLocalSelection) {
    provider = executionSelection.model.provider;
    model = executionSelection.model.id;
  }
  if (!params.hasModelDirective) {
    const { prepareSessionExecutionSelection, commitSessionExecutionSelection } =
      await import("../../model-picker/apply-session-model-selection.js");
    const { resolveSessionAgentId } = await import("../../agents/agent-scope.js");
    const prepared = await prepareSessionExecutionSelection({
      cfg,
      agentId: resolveSessionAgentId({ config: cfg, agentId: params.agentId, sessionKey }),
      sessionKey,
      storePath: params.storePath,
      parentSessionKey: params.parentSessionKey,
      sessionEntry,
      modelCatalog: modelCatalog ?? allowedModelCatalog,
      manifestPlugins: runtimeModelNormalization.manifestPlugins,
      request: turnLocalSelection
        ? { kind: "model", model: { provider, id: model } }
        : { kind: "initialize", model: { provider, id: model } },
    });
    if (prepared.status !== "ready") {
      throw new Error(prepared.message);
    }
    if (isAcpExecutionSelection(prepared.selection)) {
      throw new Error("This reply requires its bound app to prepare the model.");
    }
    executionSelection = prepared.selection;
    if (isModelExecutionSelection(executionSelection)) {
      provider = executionSelection.model.provider;
      model = executionSelection.model.id;
    }
    if (!acceptedSelection && !turnLocalSelection && sessionEntry && sessionStore && sessionKey) {
      const initialEntry = { ...sessionEntry };
      const nextEntry = { ...sessionEntry };
      commitSessionExecutionSelection(nextEntry, executionSelection, {
        cause: { kind: "initialize", fallbackPermission: prepared.fallbackPermission },
      });
      if (storePath) {
        const { persistReplySessionEntry } = await loadSessionPersistenceRuntime();
        const persistence = await persistReplySessionEntry({
          storePath,
          sessionKey,
          initialEntry,
          entry: nextEntry,
          validateCommit: prepared.validateCommit,
        });
        if (
          persistence.status === "lifecycle-invalidated" ||
          persistence.status === "commit-rejected"
        ) {
          throw new SessionWorkStartInvalidatedError(persistence.error);
        }
        adoptPersistedSessionSnapshot(sessionEntry, persistence.entry);
      } else {
        const error = prepared.validateCommit?.();
        if (error) {
          throw new Error(error);
        }
        adoptPersistedSessionSnapshot(sessionEntry, nextEntry);
      }
      sessionStore[sessionKey] = sessionEntry;
    }
  }

  // Admission may wait after this choice; later snapshots must not move the comparison baseline.
  const sessionExecutionSelection = structuredClone(sessionEntry?.executionSelection);
  if (
    !params.skipStoredModelOverride &&
    executionSelection &&
    isModelExecutionSelection(executionSelection) &&
    sessionEntry &&
    sessionStore &&
    sessionKey &&
    sessionEntry.authProfileOverride &&
    resolveCollapsedSessionAuthPinSource(sessionEntry) === "auto"
  ) {
    const { ensureAuthProfileStore } = await import("../../agents/auth-profiles.runtime.js");
    const store = ensureAuthProfileStore(
      params.agentId ? resolveAgentDir(cfg, params.agentId) : undefined,
      {
        allowKeychainPrompt: false,
        profileId: sessionEntry.authProfileOverride,
      },
    );
    logStage("auth-profile-store-loaded", `profiles=${Object.keys(store.profiles).length}`);
    const profile = store.profiles[sessionEntry.authProfileOverride];
    const authConfig = resolveModelProviderAuthConfig({ config: cfg, provider, modelId: model });
    const harnessPolicy = resolveAgentHarnessPolicy({
      provider,
      modelId: model,
      config: cfg,
      agentId: params.agentId,
      sessionKey,
    });
    const acceptedAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime({
      provider,
      harnessRuntime: executionSelection?.executor.id ?? harnessPolicy.runtime,
      config: cfg,
    }).map(normalizeProviderId);
    // Provider aliases must preserve the same credential across native and embedded runtimes.
    const overrideStillEligible =
      profile != null &&
      acceptedAuthProviders.some((accepted) =>
        isStoredCredentialCompatibleWithAuthProvider({
          cfg: authConfig,
          provider: accepted,
          credential: profile,
        }),
      );
    // Admission rejects a missing personal account; clearing its pin here would bill the next participant.
    const missingPersonalProfile =
      !profile && isUserModelAuthProfileId(sessionEntry.authProfileOverride);
    if (!overrideStillEligible && !missingPersonalProfile) {
      await clearSessionAuthProfileOverride({
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      });
    }
  }

  const buildThinkingCatalog = (catalog: ModelCatalog): ModelCatalog =>
    createModelVisibilityPolicy({
      cfg,
      catalog,
      defaultProvider,
      defaultModel: { provider: defaultProvider, model: defaultModel },
      agentId: params.agentId,
      ...runtimeModelNormalization,
    }).catalog;
  const resolveThinkingSelection = (selection: ThinkingDefaultSelection) => {
    const selected = findSelectedCatalogEntry({ ...selection, catalog: visibilityPolicy.catalog });
    return {
      ...selection,
      agentRuntime:
        selection.agentRuntime ??
        resolveEffectiveAgentRuntime({
          cfg,
          provider: selection.provider,
          modelId: selection.model,
          modelApi: selected?.api,
          modelBaseUrl: selected?.baseUrl,
          agentId: params.agentId,
          sessionKey,
          sessionEntry,
        }),
    };
  };
  const thinkingCatalogs = new Map<string, ModelCatalog>();
  const resolveThinkingCatalog = async (
    selection: ThinkingDefaultSelection = { provider, model },
  ) => {
    const thinkingSelection = resolveThinkingSelection(selection);
    const { agentRuntime } = thinkingSelection;
    const key = JSON.stringify([selection.provider, selection.model, agentRuntime]);
    const cached = thinkingCatalogs.get(key);
    if (cached) {
      return cached.length > 0 ? cached : undefined;
    }
    let catalog = visibilityPolicy.catalog;
    if (needsThinkHydration(catalog, selection.provider, selection.model, agentRuntime)) {
      const { loadProviderScopedThinkingCatalog } = await loadPreparedModelCatalogRuntime();
      const preparedCatalog = await loadProviderScopedThinkingCatalog({
        config: cfg,
        agentId: params.agentId,
        provider: selection.provider,
        model: selection.model,
        agentRuntime,
      });
      // An empty refresh cannot replace the admitted owner with a configuration-only row.
      if (findSelectedCatalogEntry({ catalog: preparedCatalog, ...selection })) {
        catalog = buildThinkingCatalog(preparedCatalog);
      }
    }
    thinkingCatalogs.set(key, catalog);
    return catalog.length > 0 ? catalog : undefined;
  };

  const defaultThinkingLevels = new Map<string, ThinkLevel>();
  const resolveDefaultThinkingLevel = async (
    selection: ThinkingDefaultSelection = { provider, model },
  ) => {
    const thinkingSelection = resolveThinkingSelection(selection);
    const cacheKey = JSON.stringify([
      selection.provider,
      selection.model,
      thinkingSelection.agentRuntime,
    ]);
    const cached = defaultThinkingLevels.get(cacheKey);
    if (cached) {
      return cached;
    }
    const thinkingParams = { cfg, agentId: params.agentId, ...thinkingSelection };
    const resolved =
      resolveConfiguredThinkingDefault(thinkingParams) ??
      resolveThinkingDefault({
        ...thinkingParams,
        catalog: await resolveThinkingCatalog(thinkingSelection),
      });
    defaultThinkingLevels.set(cacheKey, resolved);
    return resolved;
  };

  const hasConfiguredThinkingDefault =
    resolveConfiguredThinkingDefault({
      cfg,
      agentId: params.agentId,
      provider,
      model,
    }) !== undefined;

  const resolveDefaultReasoningLevel = async (
    selection: ThinkingDefaultSelection = { provider, model },
  ): Promise<"on" | "off"> =>
    resolveReasoningDefault({
      provider: selection.provider,
      model: selection.model,
      catalog: await resolveThinkingCatalog(selection),
    });
  const selectedCatalogEntry = findSelectedCatalogEntry({
    catalog: visibilityPolicy.catalog,
    provider,
    model,
  });
  return {
    provider,
    model,
    executionSelection,
    sessionExecutionSelection,
    requestedRouteResolution: "resolved",
    modelPolicy: visibilityPolicy,
    allowedModelKeys,
    allowedModelCatalog,
    policyAliasIndex: visibilityPolicy.policyAliasIndex,
    modelPolicyConfigPath: visibilityPolicy.allowConfigPath ?? undefined,
    modelPolicyRepairConfigPath: visibilityPolicy.allowRepairConfigPath,
    resolveThinkingCatalog,
    resolveDefaultThinkingLevel,
    hasConfiguredThinkingDefault,
    resolveDefaultReasoningLevel,
    needsModelCatalog,
    modelContextWindow: selectedCatalogEntry?.contextWindow,
    modelContextTokens: selectedCatalogEntry?.contextTokens,
  };
}
