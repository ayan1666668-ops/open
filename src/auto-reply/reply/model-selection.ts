/** Model selection state for reply runs, including catalog and override handling. */
import { isDeepStrictEqual } from "node:util";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import {
  commitPreparedSessionAuthSelection,
  readSessionAuthProfileOverrideState,
  type PreparedSessionAuthSelection,
  type ReplySessionAuthContext,
} from "../../agents/auth-profiles/session-override.js";
import type { AcceptedCompactionSuccessor } from "../../agents/embedded-agent-runner/compaction-successor.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { ModelFallbackRouteResolution } from "../../agents/model-fallback.types.js";
import {
  type ModelAliasIndex,
  resolveReasoningDefault,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import { resolveConfiguredThinkingDefault } from "../../agents/model-thinking-default.js";
import {
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "../../agents/model-visibility-policy.js";
import {
  needsThinkHydration,
  resolveEffectiveAgentRuntimeCore,
} from "../../agents/thinking-runtime.js";
import {
  resolveSessionWorkStartError,
  SessionWorkStartInvalidatedError,
} from "../../config/sessions/lifecycle.js";
import { mergeSessionSnapshotChanges } from "../../config/sessions/session-snapshot-merge.js";
import { adoptPersistedSessionSnapshot } from "../../config/sessions/session-snapshot.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { isDiagnosticFlagEnabled } from "../../infra/diagnostic-flags.js";
import {
  getSessionExecutionSelection,
  isAcpExecutionSelection,
  isModelExecutionSelection,
  type ExecutionSelection,
  type SessionExecutionSelection,
  type PrepareSessionExecutionSelectionParams,
} from "../../model-picker/execution-selection.js";
import { ModelSelectionLockedError } from "../../sessions/model-overrides.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
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

export class ModelSelectionPreparationError extends Error {}

type ModelCatalog = ModelCatalogEntry[];

type ThinkingDefaultSelection = {
  provider: string;
  model: string;
  agentRuntime?: string | null;
};

export type ModelSelectionState = {
  provider: string;
  model: string;
  executionSelection?: ExecutionSelection;
  auth?: PreparedSessionAuthSelection;
  validateExecution?: () => string | undefined;
  onCommitted?: (accepted: AcceptedCompactionSuccessor) => void;
  refreshExecution: (
    entry: SessionEntry,
    validateCommit?: () => string | undefined,
    purpose?: "compaction",
  ) => Promise<ModelSelectionState>;
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
export async function createModelSelectionState(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    agentCfg: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
    sessionStore?: Record<string, SessionEntry>;
    parentSessionKey?: string;
    storePath?: string;
    defaultProvider: string;
    defaultModel: string;
    provider: string;
    model: string;
    hasModelDirective: boolean;
    prepareExecution: boolean;
    preparationPurpose?: "compaction";
    abortSignal?: AbortSignal;
    validateCommit?: () => string | undefined;
    hasOneTurnModelOverride?: boolean;
    skipStoredModelOverride?: boolean;
    /** True when heartbeat.model was explicitly resolved for this run.
     *  In that case, skip session-stored overrides so the heartbeat selection wins. */
    hasResolvedHeartbeatModelOverride?: boolean;
    preparedModelCatalog?: ModelCatalogSnapshot;
  } & (
    | { replyAuth?: undefined; sessionEntry?: SessionEntry; sessionKey?: string }
    | { replyAuth: ReplySessionAuthContext; sessionEntry: SessionEntry; sessionKey: string }
  ),
): Promise<ModelSelectionState> {
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
  const initialEntry = sessionEntry
    ? { ...sessionEntry, executionSelection: structuredClone(sessionEntry.executionSelection) }
    : undefined;
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
  const acceptedSelection = getSessionExecutionSelection(initialEntry);
  if (needsModelCatalog) {
    const catalogSnapshot = await loadRuntimeCatalogSnapshot();
    modelCatalog = catalogSnapshot.entries;
    // Only an explicit false is degraded; absent means authoritative.
    const catalogAuthoritative = catalogSnapshot.authoritative !== false;
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
  let auth: PreparedSessionAuthSelection | undefined;
  let validateExecution: (() => string | undefined) | undefined;
  let onCommitted: ((accepted: AcceptedCompactionSuccessor) => void) | undefined;
  if (params.prepareExecution) {
    const validateInvocation = () => {
      if (params.abortSignal?.aborted) {
        throw createAbortError("Reply canceled during model preparation", {
          cause: params.abortSignal.reason,
        });
      }
      return params.validateCommit?.();
    };
    const invocationError = validateInvocation();
    if (invocationError) {
      throw new SessionWorkStartInvalidatedError(invocationError);
    }
    const {
      prepareSessionExecutionSelection,
      prepareSessionCompactionExecutionSelection,
      commitSessionExecutionSelection,
      executionSelectionTransactionChanged,
    } = await import("../../model-picker/apply-session-model-selection.js");
    const { resolveSessionAgentId } = await import("../../agents/agent-scope.js");
    const agentId = resolveSessionAgentId({ config: cfg, agentId: params.agentId, sessionKey });
    const loadSessionEntry = storePath
      ? (await import("../../config/sessions/session-accessor.js")).loadSessionEntry
      : undefined;
    const readCurrentEntry = () =>
      loadSessionEntry && storePath && sessionKey
        ? loadSessionEntry({ agentId, storePath, sessionKey, readConsistency: "latest" })
        : sessionStore && sessionKey
          ? sessionStore[sessionKey]
          : sessionEntry;
    const preparation = {
      cfg,
      agentId,
      ...(params.replyAuth
        ? {
            replyAuth: params.replyAuth,
            sessionEntry: params.sessionEntry,
            sessionKey: params.sessionKey,
          }
        : { sessionEntry, sessionKey }),
      storePath: params.storePath,
      readSessionEntry: readCurrentEntry,
      parentSessionKey: params.parentSessionKey,
      modelCatalog: modelCatalog ?? allowedModelCatalog,
      manifestPlugins: runtimeModelNormalization.manifestPlugins,
      request: turnLocalSelection
        ? { kind: "model" as const, model: { provider, id: model } }
        : { kind: "initialize" as const, model: { provider, id: model } },
    } satisfies PrepareSessionExecutionSelectionParams;
    const compactionSource =
      params.preparationPurpose === "compaction" &&
      !turnLocalSelection &&
      acceptedSelection &&
      isModelExecutionSelection(acceptedSelection)
        ? acceptedSelection
        : undefined;
    const temporaryCompaction = Boolean(compactionSource && sessionEntry && sessionKey);
    const compactionPrepared =
      compactionSource && sessionEntry && sessionKey
        ? await prepareSessionCompactionExecutionSelection({
            ...preparation,
            sessionEntry,
            sessionKey,
            selection: compactionSource,
          })
        : undefined;
    const prepared = compactionPrepared ?? (await prepareSessionExecutionSelection(preparation));
    const invocationErrorAfterPreparation = validateInvocation();
    if (invocationErrorAfterPreparation) {
      throw new SessionWorkStartInvalidatedError(invocationErrorAfterPreparation);
    }
    if (prepared.status !== "ready") {
      if (prepared.status === "rejected" && prepared.reason === "locked") {
        throw new ModelSelectionLockedError(prepared.message);
      }
      throw new ModelSelectionPreparationError(prepared.message);
    }
    const validateCommit = () => validateInvocation() ?? prepared.validateCommit();
    const preparationError = validateCommit();
    if (preparationError) {
      throw new SessionWorkStartInvalidatedError(preparationError);
    }
    if (isAcpExecutionSelection(prepared.selection)) {
      throw new ModelSelectionPreparationError(
        "This reply requires its bound app to prepare the model.",
      );
    }
    if (initialEntry) {
      const current = readCurrentEntry();
      if (
        !current ||
        (sessionKey &&
          resolveSessionWorkStartError(sessionKey, current, {
            expectedSessionId: initialEntry.sessionId,
          })) ||
        current.sessionId !== initialEntry.sessionId ||
        executionSelectionTransactionChanged(initialEntry, current)
      ) {
        throw new SessionWorkStartInvalidatedError(
          "The session changed during model preparation. Try again.",
        );
      }
    }
    executionSelection = prepared.selection;
    auth = prepared.auth;
    if (compactionPrepared?.status === "ready") {
      validateExecution = compactionPrepared.validateCommit;
      onCommitted = compactionPrepared.onCommitted;
    }
    if (isModelExecutionSelection(executionSelection)) {
      provider = executionSelection.model.provider;
      model = executionSelection.model.id;
    }
    if (
      !turnLocalSelection &&
      !temporaryCompaction &&
      !params.replyAuth?.configuredProfileId &&
      initialEntry &&
      sessionEntry &&
      sessionStore &&
      sessionKey
    ) {
      const nextEntry = { ...initialEntry };
      const selectionChanged = !acceptedSelection;
      if (selectionChanged) {
        commitSessionExecutionSelection(nextEntry, executionSelection, {
          cause: { kind: "initialize", fallbackPermission: prepared.fallbackPermission },
        });
      }
      const authChanged = auth && commitPreparedSessionAuthSelection(nextEntry, auth);
      if (selectionChanged || authChanged) {
        if (storePath) {
          const { persistReplySessionEntry } = await loadSessionPersistenceRuntime();
          const persistence = await persistReplySessionEntry({
            agentId,
            storePath,
            sessionKey,
            initialEntry,
            entry: nextEntry,
            validateCommit,
          });
          if (
            persistence.status === "lifecycle-invalidated" ||
            persistence.status === "commit-rejected"
          ) {
            throw new SessionWorkStartInvalidatedError(persistence.error);
          }
          adoptPersistedSessionSnapshot(sessionEntry, persistence.entry);
        } else {
          const error = validateCommit();
          if (error) {
            throw new Error(error);
          }
          const current = sessionStore[sessionKey];
          if (
            !current ||
            resolveSessionWorkStartError(sessionKey, current, {
              expectedSessionId: initialEntry.sessionId,
            }) ||
            executionSelectionTransactionChanged(initialEntry, current)
          ) {
            throw new SessionWorkStartInvalidatedError(
              "The session changed during model preparation. Try again.",
            );
          }
          adoptPersistedSessionSnapshot(
            sessionEntry,
            mergeSessionSnapshotChanges({ initial: initialEntry, next: nextEntry, current }),
          );
        }
        sessionStore[sessionKey] = sessionEntry;
      }
    }
  }

  if (auth) {
    const preparedAuth = auth;
    const committedAuthState = readSessionAuthProfileOverrideState(sessionEntry);
    auth = {
      ...preparedAuth,
      validate: (current) => preparedAuth.validate(current, committedAuthState),
    };
  }

  // Admission may wait after this choice; later snapshots must not move the comparison baseline.
  const sessionExecutionSelection = structuredClone(sessionEntry?.executionSelection);
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
        resolveEffectiveAgentRuntimeCore({
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
    auth,
    validateExecution,
    onCommitted,
    refreshExecution: async (entry, validateCommit, purpose) => {
      if (
        params.prepareExecution &&
        !isDeepStrictEqual(sessionExecutionSelection, entry.executionSelection)
      ) {
        throw new SessionWorkStartInvalidatedError("The session changed while waiting. Try again.");
      }
      return createModelSelectionState({
        ...params,
        sessionEntry: entry,
        validateCommit,
        ...(params.replyAuth
          ? {
              replyAuth: {
                ...params.replyAuth,
                isNewSession: params.prepareExecution ? false : params.replyAuth.isNewSession,
              },
              sessionKey: params.sessionKey,
            }
          : { replyAuth: undefined }),
        hasModelDirective: false,
        preparationPurpose: purpose,
        prepareExecution: true,
      });
    },
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
