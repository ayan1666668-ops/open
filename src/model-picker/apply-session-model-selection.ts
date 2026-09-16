import { isDeepStrictEqual } from "node:util";
import type { SessionAcpMeta } from "@openclaw/acp-core/types";
import {
  resolveAgentDir,
  resolveSessionAgentId,
  resolveAgentModelFallbacksOverride,
  resolveSubagentSpawnModelFallbacksOverride,
  type AgentModelPrimaryWriteTarget,
  type ModelFallbackAvailability,
} from "../agents/agent-scope.js";
import { resolveModelProviderAuthConfig } from "../agents/model-auth-provider-route.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { resolveModelCandidateChain } from "../agents/model-fallback-candidates.js";
import { evaluatePublishedModelRuntimeChoice } from "../agents/model-runtime-choice.js";
import { modelKey, resolveDefaultModelForAgent } from "../agents/model-selection.js";
import {
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "../agents/model-visibility-policy.js";
import { resolveContextConfigProviderForRuntime } from "../agents/openai-routing.js";
import {
  persistStickyModelSelectionBestEffort,
  type StickyModelSelectionDispatchOutcome,
} from "../agents/sticky-model-selection.js";
import { findSelectedCatalogEntry } from "../auto-reply/reply/model-runtime-normalization.js";
import { resolveContextTokens } from "../auto-reply/reply/model-selection-context.js";
import { refreshQueuedFollowupSession } from "../auto-reply/reply/queue.js";
import { persistReplySessionEntry } from "../auto-reply/reply/session-entry-persistence.js";
import { resolveSupportedThinkingLevel } from "../auto-reply/thinking.js";
import type { ThinkLevel } from "../auto-reply/thinking.shared.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import { resolveCollapsedSessionAuthPinSource } from "../config/sessions/auth-profile-override-provenance.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import {
  adoptPersistedSessionSnapshot,
  mergeSessionSnapshotChanges,
  SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS,
  sessionModelOverrideChangesApplied,
} from "../config/sessions/session-snapshot-merge.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { triggerSessionPatchHook } from "../gateway/session-patch-hooks.js";
import { resolveSessionWorkerPlacementContext } from "../gateway/session-worker-placement-context.js";
import { resolveWorkerPlacementCapabilities } from "../gateway/worker-environments/placement-capabilities.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { shouldPreserveSessionAuthProfileOverride } from "../sessions/auth-profile-preservation.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
} from "../sessions/model-overrides.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  encodeAcpExecutionSelection,
  encodeSessionExecutionSelection,
  type ExecutionSelectionCommitCause,
  admitSessionExecutionFallback,
  admitSessionExecutionFallbacks,
  consumeLegacySessionExecutionSeed,
  executionSelectionTransactionChanged,
} from "./execution-selection-codec.js";
import { decodeSessionExecutionSelection } from "./execution-selection-codec.js";
import { resolveConfiguredExecutionSelection } from "./execution-selection-configured.js";
import { getSessionExecutionSelection } from "./execution-selection-state.js";
import { executionSelectionCodecMetadata } from "./execution-selection-state.js";
import {
  isAcpExecutionSelection,
  type AcpExecutionSelection,
  type ExecutionSelection,
  type ModelExecutionSelection,
} from "./execution-selection.js";

/** Resolve retry permission without exposing stored selection provenance to callers. */
export function resolveSessionExecutionFallbacks(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string | null;
  sessionEntry?: Partial<SessionEntry>;
  selection: ModelExecutionSelection;
  modelFallbacksOverride?: string[];
  subagentSpawnLineage?: boolean;
}): ModelFallbackAvailability {
  const agentId = resolveSessionAgentId({
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey ?? undefined,
  });
  const entry =
    params.sessionEntry ??
    (params.sessionKey
      ? loadSessionEntryReadOnly({ agentId, sessionKey: params.sessionKey })
      : undefined);
  const configured =
    isSubagentSessionKey(params.sessionKey) || params.subagentSpawnLineage
      ? resolveSubagentSpawnModelFallbacksOverride(params.cfg, agentId)
      : resolveAgentModelFallbacksOverride(params.cfg, agentId);
  const models =
    params.modelFallbacksOverride ??
    configured ??
    resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
  const candidates = resolveModelCandidateChain({
    cfg: params.cfg,
    agentId,
    provider: params.selection.model.provider,
    model: params.selection.model.id,
    requestedRouteResolution: "resolved",
    fallbacksOverride: models,
  })
    .slice(1)
    .map(({ provider, model }): ModelExecutionSelection => ({
      model: { provider, id: model },
      executor: params.selection.executor,
    }));
  const admitted = admitSessionExecutionFallbacks({
    entry,
    candidates,
    metadata: executionSelectionCodecMetadata(params.cfg),
    explicitModels:
      params.modelFallbacksOverride === undefined
        ? undefined
        : candidates.map((pair) => pair.model),
  });
  if (admitted.status === "rejected") {
    return {
      kind:
        admitted.reason === "model-selection-locked"
          ? "disabled_by_model_selection_lock"
          : "disabled_by_model_override",
    };
  }
  const source =
    params.modelFallbacksOverride !== undefined ||
    configured !== undefined ||
    getSessionExecutionSelection(entry, params.cfg)
      ? "explicit"
      : "inherited";
  return models.length ? { kind: "active", models, source } : { kind: "none_configured", source };
}

/** Synchronous selection mutation; callers retain their existing store transaction and authority. */
export function commitSessionExecutionSelection(
  entry: Partial<SessionEntry>,
  selection: ExecutionSelection,
  options: {
    cfg?: OpenClawConfig;
    markLiveSwitchPending?: boolean;
    cause?: ExecutionSelectionCommitCause;
  } = {},
): { changed: boolean } {
  const before = getSessionExecutionSelection(entry, options.cfg);
  const initial = { ...entry };
  const pairChanged = !isDeepStrictEqual(before, selection);
  encodeSessionExecutionSelection(entry, selection, options.cause ?? { kind: "user" });
  const changed = executionSelectionTransactionChanged(initial, entry);
  if (pairChanged) {
    delete entry.contextTokens;
    delete entry.contextTokensSource;
    delete entry.contextBudgetStatus;
  }
  if (changed && options.markLiveSwitchPending) {
    entry.liveModelSwitchPending = true;
  }
  return { changed };
}

/** ACP keeps lifecycle persistence and actor custody while this owner writes its accepted pair. */
export function commitAcpExecutionSelection(
  lifecycle: Omit<SessionAcpMeta, "backend" | "agent">,
  selection: AcpExecutionSelection,
): SessionAcpMeta {
  return encodeAcpExecutionSelection(lifecycle, selection);
}

export function consumeSessionExecutionSelectionSeed(
  entry: Partial<SessionEntry>,
  expected: Partial<SessionEntry>,
): boolean {
  return consumeLegacySessionExecutionSeed(entry, expected);
}

export function commitSessionModelSelectionWithAuth(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: SessionEntry;
  currentProvider: string;
  selection: ModelExecutionSelection;
  profileOverride?: string;
  markLiveSwitchPending?: boolean;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
  cause?: ExecutionSelectionCommitCause;
}): { changed: boolean } {
  const preserve =
    !params.profileOverride &&
    shouldPreserveSessionAuthProfileOverride({
      cfg: resolveModelProviderAuthConfig({
        config: params.cfg,
        provider: params.selection.model.provider,
        modelId: params.selection.model.id,
        metadataSnapshot: params.metadataSnapshot,
      }),
      agentDir: resolveAgentDir(params.cfg, params.agentId),
      entry: params.entry,
      currentProvider: params.currentProvider,
      provider: params.selection.model.provider,
      metadataSnapshot: params.metadataSnapshot,
    });
  const profile =
    params.profileOverride ?? (preserve ? params.entry.authProfileOverride : undefined);
  const source = params.profileOverride
    ? "user"
    : preserve
      ? params.entry.authProfileOverrideSource
      : undefined;
  const count = preserve ? params.entry.authProfileOverrideCompactionCount : undefined;
  const authChanged =
    params.entry.authProfileOverride !== profile ||
    params.entry.authProfileOverrideSource !== source ||
    params.entry.authProfileOverrideCompactionCount !== count;
  const applied = commitSessionExecutionSelection(params.entry, params.selection, params);
  if (profile) {
    params.entry.authProfileOverride = profile;
    params.entry.authProfileOverrideSource = source;
    params.entry.authProfileOverrideCompactionCount = count;
  } else {
    delete params.entry.authProfileOverride;
    delete params.entry.authProfileOverrideSource;
    delete params.entry.authProfileOverrideCompactionCount;
  }
  if (authChanged && params.markLiveSwitchPending) {
    params.entry.liveModelSwitchPending = true;
  }
  if (applied.changed || authChanged) {
    delete params.entry.fallbackNotice;
  }
  return { changed: applied.changed || authChanged };
}

export type ExecutionSelectionRequest =
  | {
      kind: "model";
      model: { provider: string; id: string };
      executor?: ModelExecutionSelection["executor"];
    }
  | { kind: "selection"; selection: ExecutionSelection }
  | { kind: "fallback"; selection: ModelExecutionSelection; explicitModels?: string[] }
  | { kind: "initialize"; model?: ModelExecutionSelection["model"] }
  | { kind: "reset"; model?: ModelExecutionSelection["model"] };

export type PreparedSessionExecutionSelection =
  | {
      status: "ready";
      selection: ExecutionSelection;
      before?: ExecutionSelection;
      reason: "initialized" | "model" | "explicit" | "reset" | "unsupported";
      message: string;
      catalogEntry?: ModelCatalogEntry;
      validateCommit: () => string | undefined;
    }
  | {
      status: "rejected";
      reason: "locked" | "not-allowed" | "unknown" | "unavailable" | "unsupported";
      message: string;
    };

function selectionDisplayNames(
  selection: ExecutionSelection,
  catalog: readonly ModelCatalogEntry[],
) {
  const registry = getPluginRegistryForContext();
  const model = selection.model
    ? (catalog.find(
        (entry) =>
          entry.id === selection.model?.id &&
          (isAcpExecutionSelection(selection) || entry.provider === selection.model.provider),
      )?.name ?? "the selected model")
    : "the app's default model";
  const executor = selection.executor;
  const app =
    executor.kind === "acp"
      ? "the selected app"
      : executor.id === "openclaw"
        ? "OpenClaw"
        : (registry?.agentHarnesses.find(({ harness }) => harness.id === executor.id)?.harness
            .label ??
          registry?.cliBackends.find(({ backend }) => backend.id === executor.id)?.backend.label ??
          "the selected app");
  return { model, app };
}

/** Prepare one accepted pair or one turn-local pair; persistence is an explicit later operation. */
export async function prepareSessionExecutionSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  sessionEntry?: Partial<SessionEntry>;
  storePath?: string;
  readSessionEntry?: () => Partial<SessionEntry> | undefined;
  modelCatalog?: readonly ModelCatalogEntry[];
  profileProvider?: string;
  request: ExecutionSelectionRequest;
  prepareAcp?: (selection: AcpExecutionSelection) => Promise<AcpExecutionSelection>;
}): Promise<PreparedSessionExecutionSelection> {
  const sessionSnapshot = params.sessionEntry ? { ...params.sessionEntry } : undefined;
  const configured = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  const metadata = executionSelectionCodecMetadata(params.cfg, configured.provider);
  const decoded = decodeSessionExecutionSelection(sessionSnapshot, metadata);
  const before = decoded.kind === "initialized" ? decoded.selection : undefined;
  const catalog = params.modelCatalog ?? [];
  const chooseConfigured = (model: ModelExecutionSelection["model"]) =>
    resolveConfiguredExecutionSelection({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      model,
      modelCatalog: catalog,
      metadata,
    });
  const seed =
    decoded.kind === "uninitialized" && decoded.model
      ? { provider: decoded.model.provider ?? configured.provider, id: decoded.model.id }
      : params.request.kind === "initialize" && params.request.model
        ? params.request.model
        : { provider: configured.provider, id: configured.model };
  const pinned = decoded.kind === "uninitialized" ? decoded.executor : undefined;
  const initial: ExecutionSelection | undefined =
    before ??
    (pinned?.kind === "acp"
      ? {
          model:
            decoded.kind === "uninitialized" && decoded.model ? { id: decoded.model.id } : null,
          executor: pinned,
        }
      : pinned
        ? { model: seed, executor: pinned }
        : chooseConfigured(seed));
  let selection: ExecutionSelection | undefined;
  let reason: Extract<PreparedSessionExecutionSelection, { status: "ready" }>["reason"];
  if (params.request.kind === "initialize") {
    selection = initial;
    reason = "initialized";
  } else if (params.request.kind === "selection" || params.request.kind === "fallback") {
    selection = params.request.selection;
    reason = params.request.kind === "fallback" ? "model" : "explicit";
  } else if (params.request.kind === "reset") {
    selection =
      initial && isAcpExecutionSelection(initial)
        ? { ...initial, model: params.request.model ? { id: params.request.model.id } : null }
        : chooseConfigured(
            params.request.model ?? { provider: configured.provider, id: configured.model },
          );
    reason = "reset";
  } else {
    selection =
      initial && isAcpExecutionSelection(initial)
        ? { ...initial, model: { id: params.request.model.id } }
        : params.request.executor
          ? { model: params.request.model, executor: params.request.executor }
          : initial
            ? { model: params.request.model, executor: initial.executor }
            : undefined;
    reason = params.request.executor ? "explicit" : before ? "model" : "initialized";
  }
  const unknown = (): PreparedSessionExecutionSelection => ({
    status: "rejected",
    reason: "unknown",
    message: `Could not confirm support for ${selection ? selectionDisplayNames(selection, catalog).model : "the selected model"}. Your selection is unchanged.`,
  });
  if (!selection) {
    return unknown();
  }
  const lockedSelection = before ?? (pinned ? initial : undefined);
  if (params.sessionEntry?.modelSelectionLocked && !isDeepStrictEqual(lockedSelection, selection)) {
    return { status: "rejected", reason: "locked", message: MODEL_SELECTION_LOCKED_MESSAGE };
  }
  const fallbackRequest = params.request.kind === "fallback" ? params.request : undefined;
  const explicitFallbackModels =
    fallbackRequest?.explicitModels === undefined
      ? undefined
      : resolveModelCandidateChain({
          cfg: params.cfg,
          agentId: params.agentId,
          provider:
            before && !isAcpExecutionSelection(before)
              ? before.model.provider
              : fallbackRequest.selection.model.provider,
          model:
            before && !isAcpExecutionSelection(before)
              ? before.model.id
              : fallbackRequest.selection.model.id,
          requestedRouteResolution: "resolved",
          fallbacksOverride: fallbackRequest.explicitModels,
        }).map(({ provider, model }) => ({ provider, id: model }));
  const validateFallback = () => {
    if (!fallbackRequest) return undefined;
    const current = params.readSessionEntry
      ? params.readSessionEntry()
      : params.sessionKey
        ? loadSessionEntryReadOnly({
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
          })
        : params.sessionEntry;
    if (
      sessionSnapshot &&
      (!current ||
        current.sessionId !== sessionSnapshot.sessionId ||
        current.lifecycleRevision !== sessionSnapshot.lifecycleRevision ||
        executionSelectionTransactionChanged(sessionSnapshot, current))
    ) {
      return "The session selection changed. Retry the turn.";
    }
    const admitted = admitSessionExecutionFallback({
      entry: current,
      candidate: fallbackRequest.selection,
      metadata,
      explicitModels: explicitFallbackModels,
    });
    return admitted.status === "rejected"
      ? "This session does not permit that model fallback."
      : undefined;
  };
  const fallbackError = validateFallback();
  if (fallbackError) return { status: "rejected", reason: "not-allowed", message: fallbackError };
  const validatePlacement = (candidate: ExecutionSelection) =>
    resolveActivePlacementModelSelectionError({
      sessionId: params.sessionEntry?.sessionId,
      selection: candidate,
    });
  const placementError = validatePlacement(selection);
  if (placementError) {
    return { status: "rejected", reason: "not-allowed", message: placementError };
  }
  if (isAcpExecutionSelection(selection)) {
    if (!params.prepareAcp) {
      return unknown();
    }
    selection = await params.prepareAcp(selection);
  } else {
    const policy = createModelVisibilityPolicy({
      cfg: params.cfg,
      agentId: params.agentId,
      catalog: [...catalog],
      defaultProvider: configured.provider,
      defaultModel: configured.model,
    });
    if (
      !(params.request.kind === "reset" && !params.request.model) &&
      params.request.kind !== "initialize" &&
      params.request.kind !== "fallback" &&
      !policy.allows({ provider: selection.model.provider, model: selection.model.id })
    ) {
      return {
        status: "rejected",
        reason: "not-allowed",
        message:
          "Could not change models. This model is not available for this agent. Your selection is unchanged.",
      };
    }
    const evaluate = (pair: ModelExecutionSelection) =>
      evaluatePublishedModelRuntimeChoice({
        cfg: params.cfg,
        agentId: params.agentId,
        workspaceDir: params.sessionEntry?.spawnedWorkspaceDir,
        provider: pair.model.provider,
        model: pair.model.id,
        runtimeId: pair.executor.id,
        sessionEntry: sessionSnapshot,
        profileProvider: params.profileProvider,
      });
    let evaluation = await evaluate(selection);
    if (
      evaluation.kind === "unsupported" &&
      ((params.request.kind === "model" && !params.request.executor) ||
        params.request.kind === "fallback" ||
        (params.request.kind === "initialize" &&
          decoded.kind === "uninitialized" &&
          decoded.executor !== undefined))
    ) {
      const alternative = chooseConfigured(selection.model);
      if (alternative && alternative.executor.id !== selection.executor.id) {
        const candidate = await evaluate(alternative);
        if (candidate.kind === "ready") {
          selection = alternative;
          evaluation = candidate;
          reason = "unsupported";
        }
      }
    }
    if (
      params.sessionEntry?.modelSelectionLocked &&
      !isDeepStrictEqual(lockedSelection, selection)
    ) {
      return { status: "rejected", reason: "locked", message: MODEL_SELECTION_LOCKED_MESSAGE };
    }
    const labels = selectionDisplayNames(
      selection,
      evaluation.kind === "ready" ? [evaluation.entry, ...catalog] : catalog,
    );
    if (evaluation.kind === "unknown") {
      return unknown();
    }
    if (evaluation.kind === "forbidden") {
      return { status: "rejected", reason: "not-allowed", message: evaluation.message };
    }
    if (evaluation.kind === "unsupported") {
      return {
        status: "rejected",
        reason: "unsupported",
        message: `${labels.app} cannot run ${labels.model}. Choose another model or app.`,
      };
    }
    if (evaluation.kind === "unavailable" && params.request.kind !== "reset") {
      return {
        status: "rejected",
        reason: "unavailable",
        message: `Could not change models. Sign in to ${labels.app}, then try again.`,
      };
    }
    let message =
      reason === "reset"
        ? `Using the configured default: ${labels.model} in ${labels.app}.`
        : reason === "unsupported" && initial
          ? `Now using ${labels.model} in ${labels.app}; ${selectionDisplayNames(initial, catalog).app} cannot run it.`
          : reason === "model" || reason === "initialized"
            ? `Model changed to ${labels.model}. Still using ${labels.app}.`
            : `Now using ${labels.model} in ${labels.app}.`;
    if (evaluation.kind === "unavailable") {
      message += ` Sign in to ${labels.app}, then try again.`;
    }
    const accepted = selection;
    const validateCommit = () =>
      (evaluation.kind === "ready" ? evaluation.validate() : undefined) ??
      validateFallback() ??
      validatePlacement(accepted);
    const commitError = validateCommit();
    if (commitError) {
      return { status: "rejected", reason: "not-allowed", message: commitError };
    }
    return {
      status: "ready",
      selection,
      before,
      reason,
      message,
      catalogEntry: evaluation.kind === "ready" ? evaluation.entry : undefined,
      validateCommit,
    };
  }
  const accepted = selection;
  const labels = selectionDisplayNames(selection, catalog);
  return {
    status: "ready",
    selection,
    before,
    reason,
    validateCommit: () => validatePlacement(accepted),
    message:
      reason === "reset"
        ? `Using the configured default: ${labels.model} in ${labels.app}.`
        : `Model changed to ${labels.model}. Still using ${labels.app}.`,
  };
}

export type SessionModelSelectionRequest = {
  provider: string;
  model: string;
  isDefault: boolean;
  resetToDefault?: true;
  alias?: string;
  profileOverride?: string;
  runtime: { kind: "unchanged" } | { kind: "clear" } | { kind: "set"; runtime: string };
};

export type ApplySessionModelSelectionParams = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  storePath?: string;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  allowCreate?: boolean;
  defaultProvider: string;
  defaultModel: string;
  currentProvider: string;
  currentModel: string;
  modelPolicy?: Omit<ModelVisibilityPolicy, "catalog">;
  modelCatalog: readonly ModelCatalogEntry[];
  thinkingCatalog?: readonly ModelCatalogEntry[];
  canPersistStickyModelSelection?: boolean;
  stickyModelSelectionTarget?: AgentModelPrimaryWriteTarget;
  validateAuthProfileSelection?: () => string | undefined;
  request: SessionModelSelectionRequest;
  /** Raw directive text used only by the existing session patch hook. */
  patchModel?: string;
  markLiveSwitchPending: true;
};

export type ApplySessionModelSelectionResult =
  | {
      status: "applied";
      selection: ExecutionSelection;
      message: string;
      changed: boolean;
      contextTokens?: number;
      configuredDefaultUpdate?: StickyModelSelectionDispatchOutcome;
      thinkingRemap?: {
        from: ThinkLevel;
        to: ThinkLevel;
        provider: string;
        model: string;
      };
    }
  | {
      status: "rejected";
      reason:
        | "locked"
        | "not-allowed"
        | "invalid-runtime"
        | "unknown-provider"
        | "unknown"
        | "unavailable"
        | "unsupported";
      message: string;
    }
  | { status: "conflict"; message: string };

function formatModelSwitchEvent(provider: string, model: string, alias?: string): string {
  const label = `${provider}/${model}`;
  return alias ? `Model switched to ${alias} (${label}).` : `Model switched to ${label}.`;
}

function rejectNotAllowed(provider: string, model: string): ApplySessionModelSelectionResult {
  return {
    status: "rejected",
    reason: "not-allowed",
    message: `Model ${provider}/${model} is not available for this agent.`,
  };
}

/**
 * Rejects a model selection when the candidate runtime is incompatible with an
 * active cloud-worker placement. Mirrors the sessions.patch guard so directive
 * model changes are validated before they persist.
 */
function resolveActivePlacementModelSelectionError(params: {
  sessionId?: string;
  selection: ExecutionSelection;
}): string | undefined {
  const sessionId = params.sessionId;
  if (!sessionId) {
    return undefined;
  }
  const placementService = resolveSessionWorkerPlacementContext().workerSessionPlacementService;
  const placement = placementService?.getMany([sessionId]).get(sessionId);
  if (!placement || placement.state === "local") {
    return undefined;
  }
  const executor = params.selection.executor;
  const { executionMode } = resolveWorkerPlacementCapabilities(
    executor.kind === "acp" ? executor.backend : executor.id,
  );
  if (executionMode === placement.executionMode) {
    return undefined;
  }
  return executionMode
    ? `Session cannot change cloud placement execution mode while placement is ${placement.state}.`
    : `Session cannot select a runtime without cloud placement support while cloud worker placement is ${placement.state}.`;
}

/** Applies one validated picker selection to the authoritative live session. */
export async function applySessionModelSelection(
  params: ApplySessionModelSelectionParams,
): Promise<ApplySessionModelSelectionResult> {
  const startingStoreEntry = params.sessionStore[params.sessionKey];
  const startingEntry = params.storePath
    ? params.sessionEntry
    : (startingStoreEntry ?? params.sessionEntry);
  const initialEntry = { ...startingEntry };
  if (isModelSelectionLocked(startingEntry)) {
    return { status: "rejected", reason: "locked", message: MODEL_SELECTION_LOCKED_MESSAGE };
  }

  const resetToDefault = params.request.resetToDefault === true;
  const selectedRef = resetToDefault
    ? resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId })
    : params.request;
  const normalizedModelKey = modelKey(selectedRef.provider, selectedRef.model);
  const request: SessionModelSelectionRequest = {
    ...params.request,
    provider: selectedRef.provider,
    model: selectedRef.model,
    isDefault:
      resetToDefault ||
      normalizedModelKey === modelKey(params.defaultProvider, params.defaultModel),
  };
  const policy =
    params.modelPolicy ??
    createModelVisibilityPolicy({
      cfg: params.cfg,
      catalog: [...params.modelCatalog],
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
      agentId: params.agentId,
    });
  if (!resetToDefault && !policy.allows(request)) {
    return rejectNotAllowed(request.provider, request.model);
  }

  const explicitKind =
    request.runtime.kind === "set"
      ? executionSelectionCodecMetadata(params.cfg).classifyExecutor(request.runtime.runtime)
      : undefined;
  if (request.runtime.kind === "set" && !explicitKind) {
    return {
      status: "rejected",
      reason: "unknown",
      message: "Could not confirm support for the selected model. Your selection is unchanged.",
    };
  }
  const prepared = await prepareSessionExecutionSelection({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionEntry: request.profileOverride
      ? {
          ...startingEntry,
          authProfileOverride: request.profileOverride,
          authProfileOverrideSource: "user",
        }
      : startingEntry,
    profileProvider: request.profileOverride ? request.provider : undefined,
    modelCatalog: params.thinkingCatalog ?? params.modelCatalog,
    prepareAcp: async (selection) => {
      const { getAcpSessionManager } = await import("../acp/control-plane/manager.js");
      return getAcpSessionManager().setExecutionSelection({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        selection,
        assertActive: () => {
          const error =
            params.validateAuthProfileSelection?.() ??
            resolveActivePlacementModelSelectionError({
              sessionId: startingEntry.sessionId,
              selection,
            });
          if (error) throw new Error(error);
        },
      });
    },
    request: resetToDefault
      ? { kind: "reset" }
      : request.runtime.kind === "clear"
        ? { kind: "reset", model: { provider: request.provider, id: request.model } }
        : {
            kind: "model",
            model: { provider: request.provider, id: request.model },
            ...(request.runtime.kind === "set" && explicitKind
              ? { executor: { kind: explicitKind, id: request.runtime.runtime } }
              : {}),
          },
  });
  if (prepared.status === "rejected") {
    return prepared;
  }
  const validateSelection = () =>
    params.validateAuthProfileSelection?.() ?? prepared.validateCommit();
  const authProfileError = validateSelection();
  if (authProfileError) {
    return { status: "rejected", reason: "not-allowed", message: authProfileError };
  }
  // Metadata preparation can yield. Memory-only sessions need the same lock and
  // replacement fence that persisted sessions enforce in their atomic write.
  const currentEntry = params.storePath
    ? startingEntry
    : (params.sessionStore[params.sessionKey] ?? params.sessionEntry);
  if (isModelSelectionLocked(currentEntry)) {
    return { status: "rejected", reason: "locked", message: MODEL_SELECTION_LOCKED_MESSAGE };
  }
  if (
    !params.storePath &&
    (params.sessionStore[params.sessionKey] !== startingStoreEntry ||
      currentEntry.sessionId !== initialEntry.sessionId ||
      currentEntry.lifecycleRevision !== initialEntry.lifecycleRevision ||
      (!isAcpExecutionSelection(prepared.selection) &&
        executionSelectionTransactionChanged(initialEntry, currentEntry)))
  ) {
    return {
      status: "conflict",
      message: "Model change was not applied because the session changed. Retry.",
    };
  }
  if (isAcpExecutionSelection(prepared.selection)) {
    return {
      status: "applied",
      selection: prepared.selection,
      message: prepared.message,
      changed: !isDeepStrictEqual(prepared.before, prepared.selection),
      contextTokens: params.sessionEntry.contextTokens,
    };
  }
  request.provider = prepared.selection.model.provider;
  request.model = prepared.selection.model.id;
  const existingCatalog = params.thinkingCatalog ?? params.modelCatalog;
  const thinkingCatalog = prepared.catalogEntry
    ? [
        prepared.catalogEntry,
        ...existingCatalog.filter(
          (entry) =>
            entry.provider !== prepared.catalogEntry?.provider ||
            entry.id !== prepared.catalogEntry?.id,
        ),
      ]
    : existingCatalog;
  const selectedCatalogEntry =
    prepared.catalogEntry ?? findSelectedCatalogEntry({ catalog: thinkingCatalog, ...request });
  const nextEntry = { ...startingEntry };
  const applied = commitSessionModelSelectionWithAuth({
    cfg: params.cfg,
    agentId: params.agentId,
    entry: nextEntry,
    selection: prepared.selection,
    currentProvider: params.currentProvider,
    profileOverride: request.profileOverride,
    markLiveSwitchPending: params.markLiveSwitchPending,
    cause: { kind: resetToDefault ? "reset" : "user" },
  });
  const thinkingRuntime = prepared.selection.executor.id;
  const currentThinkingLevel = nextEntry.thinkingLevel as ThinkLevel | undefined;
  let thinkingRemap: Extract<
    ApplySessionModelSelectionResult,
    { status: "applied" }
  >["thinkingRemap"];
  if (currentThinkingLevel) {
    const remapped = resolveSupportedThinkingLevel({
      provider: request.provider,
      model: request.model,
      level: currentThinkingLevel,
      catalog: [...thinkingCatalog],
      agentRuntime: thinkingRuntime,
    });
    if (remapped !== currentThinkingLevel) {
      nextEntry.thinkingLevel = remapped;
      thinkingRemap = {
        from: currentThinkingLevel,
        to: remapped,
        provider: request.provider,
        model: request.model,
      };
    }
  }
  // An explicit selection retains the existing persistence and conflict semantics even when idempotent.
  nextEntry.updatedAt = Date.now();
  let persistedEntry: SessionEntry;
  // The pre-persistence read above can be overtaken by placement activation before the
  // durable write commits. Revalidate placement inside the synchronous commit boundary so an
  // override that became incompatible during that window is rejected without mutating state.
  const validateCommit = validateSelection;
  if (params.storePath) {
    const persistence = await persistReplySessionEntry({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      initialEntry,
      entry: nextEntry,
      allowCreate: params.allowCreate,
      reassertLiveModelSwitchPending: applied.changed && nextEntry.liveModelSwitchPending === true,
      requireModelSelectionUnlocked: true,
      touchedFields: SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS,
      validateCommit,
    });
    if (persistence.entry) {
      params.sessionStore[params.sessionKey] = persistence.entry;
      adoptPersistedSessionSnapshot(params.sessionEntry, persistence.entry);
    }
    if (persistence.status === "model-selection-locked") {
      return { status: "rejected", reason: "locked", message: MODEL_SELECTION_LOCKED_MESSAGE };
    }
    if (persistence.status === "commit-rejected") {
      return { status: "rejected", reason: "not-allowed", message: persistence.error };
    }
    if (
      persistence.status !== "current" ||
      !sessionModelOverrideChangesApplied({
        initial: initialEntry,
        next: nextEntry,
        current: persistence.entry,
        reassertLiveModelSwitchPending:
          applied.changed && nextEntry.liveModelSwitchPending === true,
      })
    ) {
      return {
        status: "conflict",
        message: "Model change was not applied because the session changed. Retry.",
      };
    }
    persistedEntry = persistence.entry;
  } else {
    adoptPersistedSessionSnapshot(
      params.sessionEntry,
      mergeSessionSnapshotChanges({
        initial: initialEntry,
        next: nextEntry,
        current: currentEntry,
      }),
    );
    params.sessionStore[params.sessionKey] = params.sessionEntry;
    persistedEntry = params.sessionEntry;
  }

  const agentRuntime = prepared.selection.executor.id;

  const provider = request.provider;
  const model = request.model;
  const effectiveModelRef = `${provider}/${model}`;
  const changed = applied.changed || thinkingRemap !== undefined;
  const configuredDefaultUpdate =
    params.canPersistStickyModelSelection === true &&
    (!request.isDefault || params.stickyModelSelectionTarget)
      ? persistStickyModelSelectionBestEffort({
          agentId: params.agentId,
          model: effectiveModelRef,
          // The shipped SDK opt-in resolves its effective layer inside the config mutation.
          // Ordinary chat callers supply an authorized target or leave persistence disabled.
          target: params.stickyModelSelectionTarget ?? "effective",
        })
      : undefined;
  if (changed) {
    emitSessionLifecycleEvent({
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      reason: "patch",
    });
    triggerSessionPatchHook({
      cfg: params.cfg,
      sessionEntry: persistedEntry,
      sessionKey: params.sessionKey,
      patch: { key: params.sessionKey, model: params.patchModel ?? effectiveModelRef },
    });
    refreshQueuedFollowupSession({
      key: params.sessionKey,
      nextSelection: prepared.selection,
      nextAuthProfileId: persistedEntry.authProfileOverride,
      nextAuthProfileIdSource: resolveCollapsedSessionAuthPinSource(persistedEntry),
      nextThinking: {
        level: persistedEntry.thinkingLevel,
        catalog: [...thinkingCatalog],
      },
    });
  }

  if (`${params.currentProvider}/${params.currentModel}` !== effectiveModelRef) {
    enqueueSystemEvent(formatModelSwitchEvent(provider, model, request.alias), {
      sessionKey: params.sessionKey,
      contextKey: `model:${effectiveModelRef}`,
    });
  }

  const contextProvider = resolveContextConfigProviderForRuntime({
    provider,
    runtimeId: agentRuntime,
    config: params.cfg,
  });
  return {
    status: "applied",
    selection: prepared.selection,
    message: prepared.message,
    changed,
    contextTokens: resolveContextTokens({
      cfg: params.cfg,
      provider: contextProvider,
      model,
      modelContextWindow: selectedCatalogEntry?.contextWindow,
      modelContextTokens: selectedCatalogEntry?.contextTokens,
    }),
    ...(configuredDefaultUpdate ? { configuredDefaultUpdate } : {}),

    ...(thinkingRemap ? { thinkingRemap } : {}),
  };
}
