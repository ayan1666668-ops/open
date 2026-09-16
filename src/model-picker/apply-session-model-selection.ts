import { isDeepStrictEqual } from "node:util";
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
} from "../agents/agent-runtime-id.js";
import {
  resolveAgentDir,
  resolveSessionAgentId,
  resolveAgentModelFallbacksOverride,
  resolveSubagentSpawnModelFallbacksOverride,
  type ModelFallbackAvailability,
} from "../agents/agent-scope.js";
import { resolveModelProviderAuthConfig } from "../agents/model-auth-provider-route.js";
import { resolveModelCandidateChain } from "../agents/model-fallback-candidates.js";
import { modelKey, resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { shouldPreserveSessionAuthProfileOverride } from "../sessions/auth-profile-preservation.js";
import { ModelSelectionLockedError } from "../sessions/model-overrides.js";
import {
  LEGACY_SELECTION_VIEW_FIELDS,
  projectLegacyExecutionSelection,
  projectExecutionSelectionEntry,
  type PublicSessionEntry,
} from "./execution-selection-projection.js";
import {
  type ExecutionSelectionCommitCause,
  type PreparedSessionExecutionSelection,
  type ApplySessionExecutionSelectionResult,
  type ApplySessionExecutionSelectionParams,
  type PrepareSessionExecutionSelectionParams,
  type PreparedSessionExecutionCommitParams,
  getSessionExecutionSelection,
  getCommittedSessionExecutionSelection,
  isAcpExecutionSelection,
  isModelExecutionSelection,
  SESSION_EXECUTION_SELECTION_TRANSACTION_FIELDS,
  type SessionExecutionSelection,
  type ExecutionFallbackPermission,
  type DeferredExecutionSelectionRequest,
  type AcpExecutionSelection,
  type ExecutionSelection,
  type ModelExecutionSelection,
} from "./execution-selection.js";
import { sessionExecutionSelectionSchema } from "./execution-selection.schema.js";

export function inheritSessionExecutionSelection(
  entry: Partial<SessionEntry> | undefined,
): Partial<SessionEntry> {
  return entry?.executionSelection
    ? { executionSelection: structuredClone(entry.executionSelection) }
    : {};
}

export function commitStoredSessionExecutionSelection(
  entry: Pick<SessionEntry, "executionSelection">,
  fact: SessionExecutionSelection,
): void {
  entry.executionSelection = sessionExecutionSelectionSchema.parse(fact);
}

/** Synchronous SDK intake records a request for the async owner; it makes no readiness claim. */
export function stageSessionExecutionSelection(params: {
  entry: PublicSessionEntry & Pick<SessionEntry, "executionSelection">;
  selection: { provider: string; model: string; isDefault?: boolean };
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
  preserveAuthProfileOverride?: boolean;
  selectionSource?: "auto" | "user";
  explicitDefaultSelection?: boolean;
  markLiveSwitchPending?: boolean;
}): { updated: boolean } {
  const { entry, selection } = params;
  if (entry.modelSelectionLocked) throw new ModelSelectionLockedError();
  const initial = { ...entry };
  const pinInput = reconcileSessionExecutionSelectionView(
    {
      executionSelection: entry.executionSelection,
      modelSelectionLocked: entry.modelSelectionLocked,
    },
    {
      agentRuntimeOverride: entry.agentRuntimeOverride,
      ...(!entry.executionSelection && entry.acp ? { acp: entry.acp } : {}),
    },
  );
  const previous = getCommittedSessionExecutionSelection(pinInput);
  const existing =
    pinInput.executionSelection?.state === "deferred"
      ? pinInput.executionSelection.request
      : undefined;
  const executor = existing ? existing.executor : previous?.executor;
  const runtime = existing?.runtime;
  const request: DeferredExecutionSelectionRequest = {
    ...(selection.isDefault
      ? {
          defaultSelection: params.explicitDefaultSelection
            ? ("configured" as const)
            : ("inherit" as const),
        }
      : { model: { provider: selection.provider, id: selection.model } }),
    ...(executor ? { executor } : {}),
    ...(runtime ? { runtime } : {}),
  };
  const fallbackPermission =
    selection.isDefault || params.selectionSource === "auto" ? "configured" : "explicit";
  const alreadyAccepted =
    previous &&
    isModelExecutionSelection(previous) &&
    !selection.isDefault &&
    previous.model.provider === selection.provider &&
    previous.model.id === selection.model &&
    pinInput.executionSelection?.state === "accepted" &&
    pinInput.executionSelection.fallbackPermission === fallbackPermission;
  const preserveAcpDefault =
    selection.isDefault && !params.explicitDefaultSelection && executor?.kind === "acp";
  if (preserveAcpDefault && pinInput.executionSelection)
    commitStoredSessionExecutionSelection(entry, pinInput.executionSelection);
  else if (!alreadyAccepted)
    commitStoredSessionExecutionSelection(entry, {
      state: "deferred",
      request,
      fallbackPermission,
      ...(previous ? { previous } : {}),
    });
  if (params.profileOverride) {
    entry.authProfileOverride = params.profileOverride;
    entry.authProfileOverrideSource = params.profileOverrideSource ?? "user";
    delete entry.authProfileOverrideCompactionCount;
  } else if (!params.preserveAuthProfileOverride) {
    delete entry.authProfileOverride;
    delete entry.authProfileOverrideSource;
    delete entry.authProfileOverrideCompactionCount;
  }
  const projected = projectLegacyExecutionSelection(entry.executionSelection);
  const modelChanged =
    initial.providerOverride !== projected.providerOverride ||
    initial.modelOverride !== projected.modelOverride ||
    (selection.isDefault && initial.modelOverrideSource !== projected.modelOverrideSource);
  const runtimeModel = entry.model?.trim() ?? "";
  const runtimeProvider = entry.modelProvider?.trim() ?? "";
  const staleObservation =
    Boolean(runtimeModel || runtimeProvider) &&
    (modelChanged ||
      runtimeModel !== selection.model ||
      (runtimeProvider !== "" && runtimeProvider !== selection.provider));
  if (staleObservation) {
    delete entry.model;
    delete entry.modelProvider;
  }
  const selectionChanged = executionSelectionTransactionChanged(initial, entry);
  const clearFallback = selectionChanged || params.selectionSource !== "auto";
  const hadFallback = entry.modelFallback !== undefined;
  if (clearFallback) entry.modelFallback = undefined;
  const updated = selectionChanged || staleObservation || (clearFallback && hadFallback);
  if (updated) {
    delete entry.contextTokens;
    delete entry.contextTokensSource;
    delete entry.contextBudgetStatus;
    delete entry.fallbackNotice;
    if (params.markLiveSwitchPending) entry.liveModelSwitchPending = true;
    entry.updatedAt = Date.now();
  }
  // These fields belong only to the caller's released SDK view, never the session encoding.
  for (const key of LEGACY_SELECTION_VIEW_FIELDS) delete entry[key];
  Object.assign(entry, projected);
  return { updated };
}

/** Released store inputs stage requests at the owner without making a readiness claim. */
export function reconcileSessionExecutionSelectionView(
  current: Partial<SessionEntry> | undefined,
  patch: Partial<PublicSessionEntry> & Pick<SessionEntry, "executionSelection">,
  options: { replace?: boolean } = {},
): Pick<SessionEntry, "executionSelection" | "modelFallback"> {
  const before = current?.executionSelection;
  const projected = projectExecutionSelectionEntry(current ?? {});
  const replace =
    options.replace ||
    (patch.sessionId !== undefined && patch.sessionId !== current?.sessionId) ||
    (patch.lifecycleRevision !== undefined &&
      patch.lifecycleRevision !== current?.lifecycleRevision);
  const next = replace ? patch : { ...projected, ...patch };
  const previous = before?.state === "accepted" ? before.selection : before?.previous;
  const changed = LEGACY_SELECTION_VIEW_FIELDS.some(
    (field) =>
      (replace || Object.hasOwn(patch, field)) &&
      !isDeepStrictEqual(patch[field], projected[field]),
  );
  const acpChanged =
    patch.acp &&
    (patch.acp.backend !== projected.acp?.backend ||
      patch.acp.agent !== projected.acp?.agent ||
      patch.acp.runtimeOptions?.model !== projected.acp?.runtimeOptions?.model);
  const entry: Pick<SessionEntry, "executionSelection" | "modelFallback"> = {};
  if (patch.executionSelection && !isDeepStrictEqual(before, patch.executionSelection)) {
    const proposed = patch.executionSelection;
    commitStoredSessionExecutionSelection(entry, {
      state: "deferred",
      request:
        proposed.state === "deferred"
          ? proposed.request
          : { model: proposed.selection.model, executor: proposed.selection.executor },
      fallbackPermission: proposed.fallbackPermission,
      ...(previous ? { previous } : {}),
    });
  } else if (changed || acpChanged) {
    const normalizedRuntime = normalizeOptionalAgentRuntimeId(next.agentRuntimeOverride);
    const runtime = isDefaultAgentRuntimeId(normalizedRuntime) ? undefined : normalizedRuntime;
    const request: DeferredExecutionSelectionRequest =
      acpChanged && patch.acp
        ? {
            executor: { kind: "acp", backend: patch.acp.backend, agent: patch.acp.agent },
            model: patch.acp.runtimeOptions?.model
              ? { id: patch.acp.runtimeOptions.model }
              : "native-managed",
          }
        : {
            ...(next.modelOverride
              ? {
                  model: {
                    id: next.modelOverride,
                    ...(next.providerOverride ? { provider: next.providerOverride } : {}),
                  },
                }
              : {
                  defaultSelection:
                    next.modelOverrideSource === "default"
                      ? ("configured" as const)
                      : ("inherit" as const),
                }),
            ...(runtime ? { runtime } : {}),
            ...(!replace && !Object.hasOwn(patch, "agentRuntimeOverride") && previous
              ? { executor: previous.executor }
              : {}),
          };
    commitStoredSessionExecutionSelection(entry, {
      state: "deferred",
      request,
      fallbackPermission:
        next.modelOverrideSource === "user"
          ? "explicit"
          : next.modelOverrideSource || !next.modelOverride
            ? "configured"
            : "explicit",
      ...(previous ? { previous } : {}),
    });
  } else if (before) {
    commitStoredSessionExecutionSelection(entry, before);
  }
  if (current?.modelSelectionLocked && !isDeepStrictEqual(before, entry.executionSelection)) {
    throw new ModelSelectionLockedError();
  }
  if (Object.hasOwn(patch, "modelFallback") || (replace && projected.modelFallback)) {
    const fallback = patch.modelFallback;
    if (!fallback) entry.modelFallback = undefined;
    else if (isDeepStrictEqual(fallback, projected.modelFallback))
      entry.modelFallback = current?.modelFallback;
    else
      entry.modelFallback = {
        previous: {
          state: "deferred",
          request: {
            model: {
              provider: fallback.prevProviderOverride ?? fallback.prevProvider,
              id: fallback.prevModelOverride ?? fallback.prevModel,
            },
          },
          fallbackPermission:
            fallback.prevModelOverrideSource === "user" ? "explicit" : "configured",
        },
        prevAuthProfileOverride: fallback.prevAuthProfileOverride,
        prevAuthProfileOverrideSource: fallback.prevAuthProfileOverrideSource,
        prevAuthProfileOverrideCompactionCount: fallback.prevAuthProfileOverrideCompactionCount,
        prevContextWindow: fallback.prevContextWindow,
        prevThinkingLevel: fallback.prevThinkingLevel,
        lastValidatedPatchTs: fallback.lastValidatedPatchTs,
        ts: fallback.ts,
        source: fallback.source,
      };
  } else if (!isDeepStrictEqual(before, entry.executionSelection)) {
    entry.modelFallback = undefined;
  } else if (
    current?.modelFallback &&
    (!patch.sessionId || patch.sessionId === current.sessionId) &&
    (!patch.lifecycleRevision || patch.lifecycleRevision === current.lifecycleRevision)
  ) {
    entry.modelFallback = current.modelFallback;
  }
  return entry;
}

export function executionSelectionTransactionChanged(
  before: Pick<SessionEntry, (typeof SESSION_EXECUTION_SELECTION_TRANSACTION_FIELDS)[number]>,
  after: Pick<SessionEntry, (typeof SESSION_EXECUTION_SELECTION_TRANSACTION_FIELDS)[number]>,
): boolean {
  return SESSION_EXECUTION_SELECTION_TRANSACTION_FIELDS.some(
    (field) => !isDeepStrictEqual(before[field], after[field]),
  );
}

export function executionSelectionRouteChanged(
  before: Partial<SessionEntry>,
  after: Partial<SessionEntry>,
): boolean {
  return !isDeepStrictEqual(
    getSessionExecutionSelection(before),
    getSessionExecutionSelection(after),
  );
}

export function copyExecutionSelectionTransaction(
  next: Partial<SessionEntry>,
  patch: Partial<SessionEntry>,
): void {
  patch.executionSelection = next.executionSelection
    ? structuredClone(next.executionSelection)
    : undefined;
  patch.authProfileOverride = next.authProfileOverride;
  patch.authProfileOverrideSource = next.authProfileOverrideSource;
  patch.authProfileOverrideCompactionCount = next.authProfileOverrideCompactionCount;
}

export function resolveExecutionSelectionExecutorKind(
  cfg: OpenClawConfig | undefined,
  id: string,
): "harness" | "cli" | undefined {
  if (id === "openclaw") return "harness";
  const registry = getPluginRegistryForContext();
  const metadata = getCurrentPluginMetadataSnapshot({
    config: cfg,
    allowSynchronousPolicyRead: false,
    allowWorkspaceScopedSnapshot: true,
  });
  const harness =
    registry?.agentHarnesses.some(({ harness }) => harness.id === id) ||
    metadata?.plugins.some((plugin) => plugin.activation?.onAgentHarnesses?.includes(id));
  const cli =
    registry?.cliBackends.some(({ backend }) => backend.id === id) ||
    metadata?.owners.cliBackends.has(id);
  return harness && !cli ? "harness" : cli && !harness ? "cli" : undefined;
}

function fallbackPermissionForCommit(
  entry: Partial<SessionEntry>,
  cause: ExecutionSelectionCommitCause,
): ExecutionFallbackPermission {
  if (cause.kind === "user") return "explicit";
  if (cause.kind === "reset") return "configured";
  if (cause.kind === "initialize" && cause.fallbackPermission) return cause.fallbackPermission;
  return (
    (cause.kind === "inherit" ? cause.entry : entry).executionSelection?.fallbackPermission ??
    "configured"
  );
}

function admitSessionFallbackModel(params: {
  entry: Partial<SessionEntry> | undefined;
  model: ModelExecutionSelection["model"];
  explicitModels?: readonly ModelExecutionSelection["model"][];
}):
  | { status: "accepted" }
  | { status: "rejected"; reason: "model-selection-locked" | "user-model-selection" } {
  if (params.entry?.modelSelectionLocked)
    return { status: "rejected", reason: "model-selection-locked" };
  const explicit = params.explicitModels?.some((model) => isDeepStrictEqual(model, params.model));
  if (!explicit && params.entry?.executionSelection?.fallbackPermission === "explicit")
    return { status: "rejected", reason: "user-model-selection" };
  return { status: "accepted" };
}

export function admitSessionExecutionFallback(params: {
  entry: Partial<SessionEntry> | undefined;
  candidate: ModelExecutionSelection;
  explicitModels?: readonly ModelExecutionSelection["model"][];
}): ReturnType<typeof admitSessionFallbackModel> {
  const current = getCommittedSessionExecutionSelection(params.entry);
  if (isDeepStrictEqual(current, params.candidate)) return { status: "accepted" };
  return admitSessionFallbackModel({ ...params, model: params.candidate.model });
}

type SessionModelFallbackParams = {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string | null;
  sessionEntry?: Partial<SessionEntry>;
  model: ModelExecutionSelection["model"];
  modelFallbacksOverride?: string[];
  configuredFallbacksOverride?: string[];
  /** A model request may own its chain before an executor has been admitted. */
  ownsCandidateChain?: boolean;
  subagentSpawnLineage?: boolean;
};

/** Plans retry models and permission without claiming executor readiness. */
export function resolveSessionModelFallbacks(
  params: SessionModelFallbackParams,
): ModelFallbackAvailability {
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
    params.configuredFallbacksOverride ??
    (isSubagentSessionKey(params.sessionKey) || params.subagentSpawnLineage
      ? resolveSubagentSpawnModelFallbacksOverride(params.cfg, agentId)
      : resolveAgentModelFallbacksOverride(params.cfg, agentId));
  const models =
    params.modelFallbacksOverride ??
    configured ??
    resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
  const source =
    params.modelFallbacksOverride !== undefined ||
    configured !== undefined ||
    (params.ownsCandidateChain ?? Boolean(getSessionExecutionSelection(entry)))
      ? "explicit"
      : "inherited";
  const candidates = resolveModelCandidateChain({
    cfg: params.cfg,
    agentId,
    provider: params.model.provider,
    model: params.model.id,
    requestedRouteResolution: "resolved",
    fallbacksOverride: source === "explicit" ? models : undefined,
  })
    .slice(1)
    .map(({ provider, model }) => ({ provider, id: model }));
  const explicitModels = params.modelFallbacksOverride === undefined ? undefined : candidates;
  const admitted = candidates
    .map((model) => admitSessionFallbackModel({ entry, model, explicitModels }))
    .find((result) => result.status === "rejected");
  if (admitted?.status === "rejected") {
    return {
      kind:
        admitted.reason === "model-selection-locked"
          ? "disabled_by_model_selection_lock"
          : "disabled_by_model_override",
    };
  }
  return models.length ? { kind: "active", models, source } : { kind: "none_configured", source };
}

/** Resolve retry permission without exposing stored selection provenance to callers. */
export function resolveSessionExecutionFallbacks(
  params: Omit<
    SessionModelFallbackParams,
    "model" | "configuredFallbacksOverride" | "ownsCandidateChain"
  > & {
    selection: ModelExecutionSelection;
  },
): ModelFallbackAvailability {
  return resolveSessionModelFallbacks({ ...params, model: params.selection.model });
}

/** Synchronous selection mutation; callers retain their existing store transaction and authority. */
export function commitSessionExecutionSelection(
  entry: Partial<SessionEntry>,
  selection: ExecutionSelection,
  options: {
    markLiveSwitchPending?: boolean;
    cause?: ExecutionSelectionCommitCause;
  } = {},
): { changed: boolean } {
  const before = getSessionExecutionSelection(entry);
  const initial = { ...entry };
  const pairChanged = !isDeepStrictEqual(before, selection);
  commitStoredSessionExecutionSelection(entry, {
    state: "accepted",
    selection,
    fallbackPermission: fallbackPermissionForCommit(entry, options.cause ?? { kind: "user" }),
  });
  if (options.cause?.kind === "user" || options.cause?.kind === "reset" || !options.cause) {
    delete entry.modelFallback;
  }
  const changed =
    executionSelectionTransactionChanged(initial, entry) ||
    initial.modelFallback !== entry.modelFallback;
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

export function commitSessionModelSelectionWithAuth(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: SessionEntry;
  currentProvider: string;
  selection: Exclude<ExecutionSelection, AcpExecutionSelection>;
  profileOverride?: string;
  markLiveSwitchPending?: boolean;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
  cause?: ExecutionSelectionCommitCause;
}): { changed: boolean } {
  if (!isModelExecutionSelection(params.selection)) {
    return commitSessionExecutionSelection(params.entry, params.selection, params);
  }
  const configured = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  const cause =
    (!params.cause || params.cause.kind === "user") &&
    modelKey(params.selection.model.provider, params.selection.model.id) ===
      modelKey(configured.provider, configured.model)
      ? { kind: "reset" as const }
      : params.cause;

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
  const applied = commitSessionExecutionSelection(params.entry, params.selection, {
    ...params,
    cause,
  });
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

export const SESSION_EXECUTION_CONFIRMATION_PAUSED_MESSAGE =
  "Chat is paused while the app confirms the saved selection.";
export type {
  ExecutionSelectionCommitCause,
  ExecutionSelectionRequest,
  PreparedSessionExecutionSelection,
  ApplySessionExecutionSelectionResult,
  ApplySessionExecutionSelectionParams,
} from "./execution-selection.js";
export { formatExecutionSelectionAcknowledgment } from "./execution-selection-presentation.js";

// Async preparation and persistence load only when requested; the stored fact is written above.
export async function prepareSessionExecutionSelection(
  params: PrepareSessionExecutionSelectionParams,
): Promise<PreparedSessionExecutionSelection> {
  return (await import("./execution-selection-preparation.js")).prepareSessionExecutionSelection(
    params,
  );
}
export async function withPreparedSessionExecutionSelection<T>(
  params: PreparedSessionExecutionCommitParams<T>,
): Promise<T> {
  return (
    await import("./execution-selection-application.js")
  ).withPreparedSessionExecutionSelection(params);
}
export async function resolveSessionExecutionControlFailure(
  error: unknown,
  target: Parameters<
    typeof import("./execution-selection-application.js").resolveSessionExecutionControlFailure
  >[1],
): ReturnType<
  typeof import("./execution-selection-application.js").resolveSessionExecutionControlFailure
> {
  return (
    await import("./execution-selection-application.js")
  ).resolveSessionExecutionControlFailure(error, target);
}
export async function applySessionExecutionSelection(
  params: ApplySessionExecutionSelectionParams,
): Promise<ApplySessionExecutionSelectionResult> {
  return (await import("./execution-selection-application.js")).applySessionExecutionSelection(
    params,
  );
}
