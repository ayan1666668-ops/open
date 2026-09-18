import { isDeepStrictEqual } from "node:util";
import {
  resolveAgentDir,
  resolveSessionAgentId,
  resolveAgentModelFallbacksOverride,
  resolveSubagentSpawnModelFallbacksOverride,
  type ModelFallbackAvailability,
} from "../agents/agent-scope.js";
import { resolveModelProviderAuthConfig } from "../agents/model-auth-provider-route.js";
import { resolveModelCandidateChain } from "../agents/model-fallback-candidates.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import { resolveSessionEntry } from "../config/sessions/session-accessor.sqlite-exact-read.js";
import type { AgentPatchedSessionModelFallback } from "../config/sessions/session-model-fallback.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { shouldPreserveSessionAuthProfileOverride } from "../sessions/auth-profile-preservation.js";
import { ModelSelectionLockedError } from "../sessions/model-overrides.js";
import type {
  RunSelectionResult,
  SessionExecutionControlFailure,
  SessionExecutionControlTarget,
} from "./execution-selection-application.js";
import type {
  PreparedCompactionSelection,
  PrepareSessionCompactionExecutionSelectionParams,
} from "./execution-selection-compaction.js";
import {
  LEGACY_SELECTION_VIEW_FIELDS,
  projectLegacyExecutionSelection,
  type PublicSessionEntry,
  reconcileSessionExecutionSelectionView,
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
  isModelExecutionSelection,
  SESSION_EXECUTION_SELECTION_TRANSACTION_FIELDS,
  type SessionExecutionSelection,
  type ExecutionFallbackPermission,
  type DeferredExecutionSelectionRequest,
  type ExecutionSelection,
  type ModelExecutionSelection,
  type SessionModelFallbackParams,
} from "./execution-selection.js";
import { sessionExecutionSelectionSchema } from "./execution-selection.schema.js";

/** Explicit unfinished SDK intent suppresses channel defaults without supplying a route. */
export function hasSessionModelSelection(
  entry: Pick<SessionEntry, "executionSelection"> | undefined,
): boolean {
  const stored = entry?.executionSelection;
  return Boolean(
    stored &&
    (stored.state === "accepted" ||
      stored.legacyRequest ||
      stored.request.model ||
      stored.request.defaultSelection ||
      stored.request.runtime ||
      stored.request.executor),
  );
}

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

export function createAgentPatchedSessionModelFallback(params: {
  model: string;
  provider: string;
  entry: Partial<SessionEntry>;
  ts: number;
}): AgentPatchedSessionModelFallback {
  const { entry } = params;
  return {
    prevModel: params.model,
    prevProvider: params.provider,
    previous: entry.executionSelection
      ? structuredClone(entry.executionSelection)
      : {
          state: "deferred",
          request: { defaultSelection: "inherit" },
          fallbackPermission: "configured",
        },
    prevAuthProfileOverride: entry.authProfileOverride,
    prevAuthProfileOverrideSource: entry.authProfileOverrideSource,
    prevAuthProfileOverrideCompactionCount: entry.authProfileOverrideCompactionCount,
    prevContextWindow: entry.contextWindow,
    prevThinkingLevel: entry.thinkingLevel,
    ts: params.ts,
    source: "agent-patch",
  };
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
  if (entry.modelSelectionLocked) {
    throw new ModelSelectionLockedError();
  }
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
    !pinInput.executionSelection?.legacyRequest &&
    pinInput.executionSelection?.state === "accepted" &&
    pinInput.executionSelection.fallbackPermission === fallbackPermission;
  const preserveAcpDefault =
    selection.isDefault && !params.explicitDefaultSelection && executor?.kind === "acp";
  if (preserveAcpDefault && pinInput.executionSelection) {
    commitStoredSessionExecutionSelection(entry, pinInput.executionSelection);
  } else if (!alreadyAccepted) {
    commitStoredSessionExecutionSelection(entry, {
      state: "deferred",
      request,
      fallbackPermission,
      ...(previous ? { previous } : {}),
    });
  }
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
  if (clearFallback) {
    entry.modelFallback = undefined;
  }
  const updated = selectionChanged || staleObservation || (clearFallback && hadFallback);
  if (updated) {
    delete entry.contextTokens;
    delete entry.contextTokensSource;
    delete entry.contextBudgetStatus;
    delete entry.fallbackNotice;
    if (params.markLiveSwitchPending) {
      entry.liveModelSwitchPending = true;
    }
    entry.updatedAt = Date.now();
  }
  // These fields belong only to the caller's released SDK view, never the session encoding.
  for (const key of LEGACY_SELECTION_VIEW_FIELDS) {
    delete entry[key];
  }
  Object.assign(entry, projected);
  return { updated };
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
  if (id === "openclaw") {
    return "harness";
  }
  const registry = getPluginRegistryForContext();
  const metadata = getCurrentPluginMetadataSnapshot({
    config: cfg,
    allowSynchronousPolicyRead: false,
    allowWorkspaceScopedSnapshot: true,
  });
  const hasHarness =
    registry?.agentHarnesses.some(({ harness }) => harness.id === id) ||
    metadata?.plugins.some((plugin) => plugin.activation?.onAgentHarnesses?.includes(id));
  const hasCli =
    registry?.cliBackends.some(({ backend }) => backend.id === id) ||
    metadata?.owners.cliBackends.has(id);
  return hasHarness && !hasCli ? "harness" : hasCli && !hasHarness ? "cli" : undefined;
}

function fallbackPermissionForCommit(
  entry: Partial<SessionEntry>,
  cause: ExecutionSelectionCommitCause,
): ExecutionFallbackPermission {
  if (cause.kind === "user") {
    return "explicit";
  }
  if (cause.kind === "reset") {
    return "configured";
  }
  if (cause.kind === "initialize" && cause.fallbackPermission) {
    return cause.fallbackPermission;
  }
  return (
    (cause.kind === "inherit" ? cause.entry : entry).executionSelection?.fallbackPermission ??
    "configured"
  );
}

export type ExecutionFallbackAdmission =
  | { status: "accepted" }
  | { status: "rejected"; reason: "model-selection-locked" | "user-model-selection" };

function admitSessionFallbackModel(params: {
  entry: Partial<SessionEntry> | undefined;
  model?: ModelExecutionSelection["model"];
  explicitModels?: readonly ModelExecutionSelection["model"][];
  userSelection?: ModelExecutionSelection;
  modelSelectionLocked?: boolean;
}): ExecutionFallbackAdmission {
  if (params.modelSelectionLocked || params.entry?.modelSelectionLocked) {
    return { status: "rejected", reason: "model-selection-locked" };
  }
  const explicit = params.explicitModels?.some((model) => isDeepStrictEqual(model, params.model));
  if (
    !explicit &&
    (params.userSelection || params.entry?.executionSelection?.fallbackPermission === "explicit")
  ) {
    return { status: "rejected", reason: "user-model-selection" };
  }
  return { status: "accepted" };
}

export function admitSessionExecutionFallback(params: {
  entry: Partial<SessionEntry> | undefined;
  candidate: ExecutionSelection;
  explicitModels?: readonly ModelExecutionSelection["model"][];
  userSelection?: ModelExecutionSelection;
}): ExecutionFallbackAdmission {
  const current = getCommittedSessionExecutionSelection(params.entry);
  if (
    isDeepStrictEqual(params.userSelection ?? current, params.candidate) &&
    (!params.entry?.modelSelectionLocked || isDeepStrictEqual(current, params.candidate))
  ) {
    return { status: "accepted" };
  }
  return admitSessionFallbackModel({
    ...params,
    model: isModelExecutionSelection(params.candidate) ? params.candidate.model : undefined,
  });
}

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
      ? resolveSessionEntry({ agentId, sessionKey: params.sessionKey }, { readOnly: true }).existing
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
    params.userSelection !== undefined ||
    (params.ownsCandidateChain ?? entry?.executionSelection?.fallbackPermission === "explicit")
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
  for (const model of candidates) {
    const admitted = admitSessionFallbackModel({
      entry,
      model,
      explicitModels,
      userSelection: params.userSelection,
      modelSelectionLocked: params.modelSelectionLocked,
    });
    if (admitted.status === "rejected") {
      return {
        kind:
          admitted.reason === "model-selection-locked"
            ? "disabled_by_model_selection_lock"
            : "disabled_by_model_override",
      };
    }
  }
  return models.length ? { kind: "active", models, source } : { kind: "none_configured", source };
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
  const legacyRequest = (
    options.cause?.kind === "inherit"
      ? options.cause.entry
      : options.cause?.kind === "initialize"
        ? entry
        : undefined
  )?.executionSelection?.legacyRequest;
  commitStoredSessionExecutionSelection(entry, {
    state: "accepted",
    selection,
    fallbackPermission: fallbackPermissionForCommit(entry, options.cause ?? { kind: "user" }),
    ...(legacyRequest ? { legacyRequest } : {}),
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
  selection: ExecutionSelection;
  profileOverride?: string;
  markLiveSwitchPending?: boolean;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
  cause?: ExecutionSelectionCommitCause;
}): { changed: boolean } {
  if (!isModelExecutionSelection(params.selection)) {
    return commitSessionExecutionSelection(params.entry, params.selection, params);
  }
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

// Static runtime imports would pull plugin execution and Gateway/store cycles into synchronous SDK intake.
export async function prepareSessionExecutionSelection(
  params: PrepareSessionExecutionSelectionParams,
): Promise<PreparedSessionExecutionSelection> {
  return (await import("./execution-selection-input.js")).prepareSessionExecutionSelection(params);
}
export async function prepareSessionCompactionExecutionSelection(
  params: PrepareSessionCompactionExecutionSelectionParams,
): Promise<PreparedCompactionSelection> {
  return (
    await import("./execution-selection-compaction.js")
  ).prepareSessionCompactionExecutionSelection(params);
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
  target: SessionExecutionControlTarget,
): Promise<SessionExecutionControlFailure | undefined> {
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

/** Internal run callers retain prepared account state without changing the public apply result. */
export async function initializeSessionExecutionSelectionForRun(
  params: Omit<ApplySessionExecutionSelectionParams, "request">,
  purpose?: "compaction",
): Promise<RunSelectionResult> {
  return (
    await import("./execution-selection-application.js")
  ).initializeSessionExecutionSelectionForRun(params, purpose);
}
