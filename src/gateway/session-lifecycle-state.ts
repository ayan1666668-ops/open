import { normalizeOptionalString as normalizeLifecycleRunId } from "@openclaw/normalization-core/string-coerce";
import type { SessionRunStatus } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import { isAgentLifecycleYieldedWaiting } from "../agents/agent-lifecycle-parent-state.js";
import {
  AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import {
  isMainSessionRecoveryLifecycleEvent,
  projectMainSessionRecoveryLifecycle,
} from "../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import { captureYieldedMainSessionContinuation } from "../agents/main-session-recovery/main-session-restart-recovery-target.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration, type AgentEventPayload } from "../infra/agent-events.js";
import { hasLiveAgentRunContext, listAgentRunsForSession } from "../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import {
  recordGatewaySessionRunFailure,
  resolveSessionRunError,
} from "../sessions/session-run-error.js";
import { loadSessionEntry } from "./session-utils.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

const restartRecoveryLog = createSubsystemLogger("main-session-restart-recovery");
const staleRunningReconcileLog = createSubsystemLogger("session-lifecycle-reconcile");

type LifecyclePhase = "start" | "end" | "error";

type LifecycleEventLike = Pick<AgentEventPayload, "ts" | "sessionId"> & {
  contextClaimId?: string;
  runId?: string;
  clientRunId?: string;
  lifecycleGeneration?: string;
  mainSessionRestartRecovery?: true;
  data?: {
    phase?: unknown;
    startedAt?: unknown;
    endedAt?: unknown;
    aborted?: unknown;
    stopReason?: unknown;
    error?: unknown;
    livenessState?: unknown;
    timeoutPhase?: unknown;
    providerStarted?: unknown;
    yielded?: unknown;
    status?: unknown;
  };
};

type LifecycleSessionShape = Pick<
  GatewaySessionRow,
  | "updatedAt"
  | "status"
  | "lastRunError"
  | "lastRunId"
  | "startedAt"
  | "endedAt"
  | "runtimeMs"
  | "abortedLastRun"
>;

type PersistedLifecycleSessionShape = Pick<
  SessionEntry,
  | "updatedAt"
  | "status"
  | "lastRunError"
  | "lastRunId"
  | "startedAt"
  | "endedAt"
  | "runtimeMs"
  | "abortedLastRun"
  | "restartRecoveryRuns"
  | "restartRecoveryForceSafeTools"
  | "mainRestartRecovery"
  | "lifecycleRunId"
>;

type GatewaySessionLifecycleSnapshot = Partial<Pick<SessionEntry, keyof LifecycleSessionShape>>;

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveLifecyclePhase(event: Pick<LifecycleEventLike, "data">): LifecyclePhase | null {
  const phase = event.data?.phase;
  return phase === "start" || phase === "end" || phase === "error" ? phase : null;
}

const SESSION_STATUS_BY_TERMINAL_CLASSIFICATION = {
  success: "done",
  timeout: "timeout",
  cancellation: "killed",
  failure: "failed",
} as const satisfies Record<ReturnType<typeof classifyAgentRunTerminalOutcome>, SessionRunStatus>;

function resolveTerminalOutcome(event: LifecycleEventLike): AgentRunTerminalOutcome {
  return buildAgentRunTerminalOutcomeFromLifecycleEvent({
    phase: event.data?.phase === "error" ? "error" : "end",
    data: event.data,
    endedAt: event.data?.endedAt ?? event.ts,
  });
}

function resolveSettledLifecycleTerminalOutcome(
  event: LifecycleEventLike,
): AgentRunTerminalOutcome | undefined {
  const phase = resolveLifecyclePhase(event);
  if (phase !== "end" && phase !== "error") {
    return undefined;
  }
  const outcome = resolveTerminalOutcome(event);
  return isAgentLifecycleYieldedWaiting({
    phase,
    yielded: event.data?.yielded,
    livenessState: event.data?.livenessState,
    stopReason: outcome.stopReason,
    aborted: event.data?.aborted,
    status: event.data?.status,
    timeoutPhase: event.data?.timeoutPhase,
    error: event.data?.error,
  })
    ? undefined
    : outcome;
}

function resolveLifecycleStartedAt(
  existingStartedAt: number | undefined,
  event: LifecycleEventLike,
): number | undefined {
  if (isFiniteTimestamp(event.data?.startedAt)) {
    return event.data.startedAt;
  }
  if (isFiniteTimestamp(existingStartedAt)) {
    return existingStartedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveLifecycleEndedAt(event: LifecycleEventLike): number | undefined {
  if (isFiniteTimestamp(event.data?.endedAt)) {
    return event.data.endedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveRuntimeMs(params: {
  startedAt?: number;
  endedAt?: number;
  existingRuntimeMs?: number;
}): number | undefined {
  const { startedAt, endedAt, existingRuntimeMs } = params;
  if (isFiniteTimestamp(startedAt) && isFiniteTimestamp(endedAt)) {
    return Math.max(0, endedAt - startedAt);
  }
  if (
    typeof existingRuntimeMs === "number" &&
    Number.isFinite(existingRuntimeMs) &&
    existingRuntimeMs >= 0
  ) {
    return existingRuntimeMs;
  }
  return undefined;
}

export function deriveGatewaySessionLifecycleSnapshot(params: {
  session?: GatewaySessionLifecycleSnapshot | null;
  event: LifecycleEventLike;
}): GatewaySessionLifecycleSnapshot {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return {};
  }

  const existing = params.session ?? undefined;
  if (phase === "start") {
    // A start event clears terminal fields from the previous run so UI rows do
    // not show stale runtime/end state while the new run is active.
    const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
    const updatedAt = startedAt ?? existing?.updatedAt;
    return {
      updatedAt,
      status: "running",
      lastRunError: undefined,
      startedAt,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    };
  }

  const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
  const endedAt = resolveLifecycleEndedAt(params.event);
  const updatedAt = endedAt ?? existing?.updatedAt;
  const terminal = resolveSettledLifecycleTerminalOutcome(params.event);
  // Cancellation must preserve recovery even when the bulk shutdown marker failed.
  // Use the normalized outcome so a prior hard timeout still owns the terminal state.
  const interruptedForRestart =
    terminal?.reason === "cancelled" && terminal.stopReason === "restart";
  const status =
    terminal && !interruptedForRestart
      ? SESSION_STATUS_BY_TERMINAL_CLASSIFICATION[classifyAgentRunTerminalOutcome(terminal)]
      : "running";
  return {
    updatedAt,
    status,
    lastRunError: terminal ? resolveSessionRunError(terminal, status) : undefined,
    startedAt,
    endedAt: interruptedForRestart ? undefined : endedAt,
    runtimeMs: interruptedForRestart
      ? undefined
      : resolveRuntimeMs({ startedAt, endedAt, existingRuntimeMs: existing?.runtimeMs }),
    abortedLastRun: interruptedForRestart || status === "killed",
  };
}

function derivePersistedSessionLifecyclePatch(params: {
  entry?: Partial<PersistedLifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): Partial<PersistedLifecycleSessionShape> {
  const snapshot = deriveGatewaySessionLifecycleSnapshot({
    session: params.entry ?? undefined,
    event: params.event,
  });
  const snapshotPatch: Partial<PersistedLifecycleSessionShape> = {
    ...snapshot,
    updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : undefined,
    ...(snapshot.status === "running" && snapshot.abortedLastRun === true
      ? { restartRecoveryForceSafeTools: true }
      : {}),
  };
  const projection = projectMainSessionRecoveryLifecycle({
    currentLifecycleGeneration: getAgentEventLifecycleGeneration(),
    entry: params.entry,
    event: params.event,
    snapshotPatch,
  });
  if (projection.action === "suppress") {
    return {};
  }
  const phase = resolveLifecyclePhase(params.event);
  const runId = normalizeLifecycleRunId(params.event.runId);
  const clientRunId = normalizeLifecycleRunId(params.event.clientRunId) ?? runId;
  // Run ownership follows the durable running projection. Terminal settlement
  // releases it; yielded parents retain it for their continuation lifecycle.
  return {
    ...projection.patch,
    ...(phase === "start"
      ? { lifecycleRunId: runId, lastRunId: undefined }
      : projection.patch.status && projection.patch.status !== "running"
        ? { lifecycleRunId: undefined, lastRunId: clientRunId }
        : {}),
  };
}

export function deriveGatewaySessionLifecycleProjectionPatch(params: {
  entry?: Partial<PersistedLifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): GatewaySessionLifecycleSnapshot {
  const {
    restartRecoveryRuns: _restartRecoveryRuns,
    restartRecoveryForceSafeTools: _restartRecoveryForceSafeTools,
    lifecycleRunId: _lifecycleRunId,
    ...patch
  } = derivePersistedSessionLifecyclePatch(params);
  return patch;
}

export function isRestartRecoveryLifecycleEvent(params: {
  entry?: Pick<SessionEntry, "restartRecoveryRuns"> | null;
  event: Pick<LifecycleEventLike, "runId" | "lifecycleGeneration" | "data">;
}): boolean {
  return isMainSessionRecoveryLifecycleEvent(params);
}

/**
 * Reject pre-reset runs and explicitly older runs sharing one session so late
 * lifecycle events cannot overwrite a newer run's authoritative state.
 */
export function isStaleLifecycleEventForSession(params: {
  owningSessionId?: string;
  currentSessionId?: string;
  eventRunId?: unknown;
  currentRunId?: unknown;
  eventStartedAt?: unknown;
  currentStartedAt?: number;
}): boolean {
  if (
    params.owningSessionId &&
    params.currentSessionId &&
    params.owningSessionId !== params.currentSessionId
  ) {
    return true;
  }
  const eventRunId = normalizeLifecycleRunId(params.eventRunId);
  const currentRunId = normalizeLifecycleRunId(params.currentRunId);
  // Matching ownership is stronger than producer timestamps. Missing or
  // different identities retain the legacy timestamp fence.
  if (eventRunId && currentRunId && eventRunId === currentRunId) {
    return false;
  }
  return (
    isFiniteTimestamp(params.eventStartedAt) &&
    isFiniteTimestamp(params.currentStartedAt) &&
    params.eventStartedAt < params.currentStartedAt
  );
}

function acceptsCronRunContinuationLifecycleEvent(params: {
  entry: SessionEntry;
  event: LifecycleEventLike;
}): boolean {
  const marker = params.entry.cronRunContinuation;
  if (marker?.phase === "running") {
    return true;
  }
  const runId = params.event.runId?.trim();
  return Boolean(marker?.phase === "continuing" && runId && marker.ownerRunId === runId);
}

// sessions.list cache fence input. The terminal entry write (status/endedAt/
// runtimeMs) commits asynchronously after the run-index fence already bumped
// at lifecycle end; without its own fence a list computed in that window
// caches the pre-terminal row indefinitely.
let lifecyclePersistenceVersion = 0;

export function readSessionLifecyclePersistenceVersion(): number {
  return lifecyclePersistenceVersion;
}

export async function persistGatewaySessionLifecycleEvent(params: {
  sessionKey: string;
  agentId?: string;
  event: LifecycleEventLike;
  assertCommitAllowed?: () => void;
  expectedWriter?: {
    runId: string;
    sessionId: string;
    lifecycleRevision?: string;
  };
}): Promise<void> {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return;
  }

  const sessionEntry = loadSessionEntry(params.sessionKey, {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    clone: false,
  });
  if (!sessionEntry.entry) {
    return;
  }
  const owningSessionId =
    typeof params.event.sessionId === "string" && params.event.sessionId
      ? params.event.sessionId
      : undefined;

  const exactCronRun = parseCronRunScopeSuffix(sessionEntry.canonicalKey).runId !== undefined;
  let terminalRecovery: { runId: string; outcome: AgentRunTerminalOutcome } | undefined;
  let failedRun: { runId: string; error: unknown } | undefined;
  const persisted = await patchSessionEntryCore(
    {
      storePath: sessionEntry.storePath,
      sessionKey: sessionEntry.canonicalKey,
    },
    async (storedEntry) => {
      terminalRecovery = undefined;
      failedRun = undefined;
      // SAFETY: The lifecycle store returns the durable session row persisted under this storePath/sessionKey; its schema-version gate guarantees the SessionEntry shape.
      const entry = storedEntry as SessionEntry;
      const expected = params.expectedWriter;
      if (
        expected &&
        (entry.sessionId !== expected.sessionId ||
          entry.lifecycleRevision !== expected.lifecycleRevision ||
          (entry.activeWriterRunId !== expected.runId && entry.lifecycleRunId !== expected.runId) ||
          (entry.activeWriterRunId !== undefined && entry.activeWriterRunId !== expected.runId) ||
          (entry.lifecycleRunId !== undefined && entry.lifecycleRunId !== expected.runId))
      ) {
        return null;
      }
      if (
        exactCronRun &&
        !acceptsCronRunContinuationLifecycleEvent({ entry, event: params.event })
      ) {
        // Exact cron rows transfer lifecycle ownership from the initial run to
        // one claimed continuation. Ready or replaced claims reject late events.
        return null;
      }
      if (
        isStaleLifecycleEventForSession({
          owningSessionId,
          currentSessionId: entry.sessionId,
          eventRunId: params.event.runId,
          currentRunId: entry.lifecycleRunId,
          eventStartedAt: params.event.data?.startedAt,
          currentStartedAt: entry.startedAt,
        })
      ) {
        return null;
      }
      const eventRunId = normalizeLifecycleRunId(params.event.runId);
      const eventClientRunId = normalizeLifecycleRunId(params.event.clientRunId);
      const terminalRunId = normalizeLifecycleRunId(entry.lastRunId);
      if (
        phase === "start" &&
        entry.status !== "running" &&
        terminalRunId !== undefined &&
        (eventRunId === terminalRunId || eventClientRunId === terminalRunId)
      ) {
        // A delayed start from a terminalized run must not reopen the row after
        // its end write commits; lifecycle events are delivered in order, but
        // their async persistence can settle out of order.
        return null;
      }
      const patch = derivePersistedSessionLifecyclePatch({
        entry,
        event: params.event,
      });
      if (
        (phase === "error" || phase === "end") &&
        eventRunId &&
        (patch.status === "failed" || patch.status === "timeout")
      ) {
        failedRun = {
          runId: eventRunId,
          error:
            resolveTerminalOutcome(params.event).error ??
            (patch.status === "timeout" ? "Run timed out" : undefined),
        };
      }
      const recoveryTerminalIsCurrent =
        params.event.mainSessionRestartRecovery === true &&
        params.event.lifecycleGeneration === getAgentEventLifecycleGeneration() &&
        eventRunId !== undefined &&
        (phase === "end" || phase === "error");
      const terminalOutcome = recoveryTerminalIsCurrent
        ? resolveSettledLifecycleTerminalOutcome(params.event)
        : undefined;
      if (terminalOutcome && eventRunId && Object.keys(patch).length > 0) {
        terminalRecovery = {
          runId: eventRunId,
          outcome: terminalOutcome,
        };
      }
      return Object.keys(patch).length > 0 ? patch : null;
    },
    {
      skipMaintenance: true,
      takeCacheOwnership: true,
      requireWriteSuccess: true,
      ...(params.assertCommitAllowed ? { assertCommitAllowed: params.assertCommitAllowed } : {}),
    },
  );
  if (persisted && terminalRecovery) {
    const message = `main-session restart recovery terminal: session=${sessionEntry.canonicalKey} run=${terminalRecovery.runId} status=${terminalRecovery.outcome.status} reason=${terminalRecovery.outcome.reason}`;
    restartRecoveryLog[terminalRecovery.outcome.status === "ok" ? "info" : "warn"](message);
  }
  lifecyclePersistenceVersion += 1;
  if (persisted && failedRun) {
    const { runId, error } = failedRun;
    // Only accepted errors pay for branch navigation; assistant detection and
    // report deduplication share the appender's authoritative write snapshot.
    await recordGatewaySessionRunFailure({
      target: {
        agentId: sessionEntry.agentId,
        storePath: sessionEntry.storePath,
        sessionKey: sessionEntry.canonicalKey,
        sessionId: persisted.sessionId,
        expectedLifecycleRevision: persisted.lifecycleRevision,
      },
      runId,
      error,
      assertCommitAllowed: params.assertCommitAllowed,
    });
  }
}

/**
 * Terminal reason recorded when a durable `running` row is found without a live
 * run owner. Short because it surfaces in session rows and UI error copy.
 */
const STALE_RUNNING_RECONCILE_ERROR =
  "Run ended without a terminal lifecycle event; session state was reconciled.";

/**
 * True when a durable `running` row is old enough that a missing live-run
 * registry entry means the run is dead rather than still starting up. The age
 * gate keeps the settlement from racing a just-started run whose
 * controller/registry entry has not been published yet.
 */
function isStaleRunningSessionAge(updatedAt: number | null | undefined, now = Date.now()): boolean {
  return (
    typeof updatedAt === "number" &&
    Number.isFinite(updatedAt) &&
    now - updatedAt >= AGENT_RUN_TERMINAL_RETRY_GRACE_MS
  );
}

function buildStaleRunningTerminalPatch(params: {
  entry: SessionEntry;
  now: number;
}): Partial<PersistedLifecycleSessionShape> | null {
  const runId =
    normalizeLifecycleRunId(params.entry.lifecycleRunId) ??
    normalizeLifecycleRunId(params.entry.lastRunId);
  const patch = derivePersistedSessionLifecyclePatch({
    entry: params.entry,
    event: {
      ts: params.now,
      ...(params.entry.sessionId ? { sessionId: params.entry.sessionId } : {}),
      ...(runId ? { runId } : {}),
      data: {
        phase: "error",
        error: STALE_RUNNING_RECONCILE_ERROR,
        endedAt: params.now,
      },
    },
  });
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Settles a session left in the durable `running` state after its run owner
 * disappeared without a persisted terminal lifecycle event (for example an
 * idle-timeout whose prepared terminal write expired). This reuses the same
 * lifecycle owner and terminal derivation as real lifecycle events, so the row
 * converges to one terminal state instead of a parallel state machine.
 *
 * The caller owns authority: only an operation already admitted to mutate the
 * session may call this, and its authorization is re-asserted inside the commit
 * transaction through `assertCommitAllowed`. Read-only callers must never reach
 * this function, because the settlement clears lifecycle ownership.
 *
 * Every "is this row still owned?" input is re-read inside the commit
 * transaction — the caller's live-run view, the operational run registry (row
 * writer ids, session-bound contexts, retained queue leases, pending recovery
 * fences) and the yielded-main-session continuation — so work that appears after
 * the patch callback yields is never marked failed. The age gate additionally
 * avoids racing a just-started run whose registry entry is not published yet.
 */
export async function reconcileStaleRunningSession(params: {
  sessionKey: string;
  agentId?: string;
  cfg?: OpenClawConfig;
  hasLiveRun: () => boolean;
  now?: number;
  assertCommitAllowed?: () => void;
  /** Test seam for the operational run-registry ownership check. */
  isLiveRunContext?: (runId: string) => boolean;
  /** Test seam for the session-bound registry lookup. */
  listSessionRuns?: (params: {
    sessionKey: string;
    sessionId?: string;
  }) => Array<{ runId: string }>;
}): Promise<boolean> {
  const sessionEntry = loadSessionEntry(params.sessionKey, {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    clone: false,
  });
  const entry = sessionEntry.entry;
  if (!entry || entry.status !== "running") {
    return false;
  }
  const now = params.now ?? Date.now();
  const startedAt = entry.startedAt ?? entry.updatedAt;
  // A run that started inside the retry grace window may not have published its
  // registry entry yet, so age gates the settlement just like liveness does.
  if (typeof startedAt === "number" && !isStaleRunningSessionAge(startedAt, now)) {
    return false;
  }
  const keepsRunning = (row: SessionEntry) =>
    keepsRunningForStaleSettlement({ sessionEntry, entry: row, params });
  if (keepsRunning(entry)) {
    return false;
  }
  // The row the write is prepared against. The commit guard re-evaluates
  // ownership against it, because the registries can change while the accessor
  // awaits before its transaction.
  let fencedEntry: SessionEntry | undefined;
  let settled = false;
  let commitAborted = false;
  let persisted: SessionEntry | null;
  try {
    persisted = await patchSessionEntryCore(
      {
        storePath: sessionEntry.storePath,
        sessionKey: sessionEntry.canonicalKey,
      },
      (storedEntry) => {
        // SAFETY: The lifecycle store returns the durable session row persisted under this storePath/sessionKey; its schema-version gate guarantees the SessionEntry shape.
        const current = storedEntry as SessionEntry;
        if (current.status !== "running" || keepsRunning(current)) {
          return null;
        }
        const patch = buildStaleRunningTerminalPatch({ entry: current, now });
        // The durable owner must accept the terminal event. A suppressed projection
        // (recovery still owns the row) leaves the patch empty and the row running;
        // read paths must not report a status the owner refused to record.
        if (!patch || !isTerminalSessionRunStatus(patch.status)) {
          return null;
        }
        fencedEntry = current;
        settled = true;
        return patch;
      },
      {
        skipMaintenance: true,
        takeCacheOwnership: true,
        requireWriteSuccess: true,
        // Synchronous final guard. Ownership is re-derived here from live
        // registries against the row the accessor just fenced, so a continuation
        // or owner that appeared after the callback yielded still blocks the write.
        assertCommitAllowed: () => {
          params.assertCommitAllowed?.();
          if (!settled || !fencedEntry) {
            return;
          }
          if (keepsRunning(fencedEntry)) {
            commitAborted = true;
            throw new Error(
              "Session work reappeared before the stale-running settlement committed.",
            );
          }
        },
      },
    );
  } catch (error) {
    // A declined commit is a normal outcome: live work reappeared, so this row is
    // not stale after all. Report "not settled" instead of failing the caller.
    if (commitAborted) {
      staleRunningReconcileLog.warn(
        `declined stale running settlement session=${sessionEntry.canonicalKey}: live work reappeared`,
      );
      return false;
    }
    throw error;
  }
  // patchSessionEntryCore returns the unchanged entry when the callback declines,
  // so the explicit flag is the only proof this owner actually wrote a terminal.
  if (!settled || !persisted) {
    return false;
  }
  lifecyclePersistenceVersion += 1;
  staleRunningReconcileLog.warn(
    `settled stale running session=${sessionEntry.canonicalKey} ageMs=${
      Number.isFinite(startedAt) ? now - startedAt : "unknown"
    }`,
  );
  return true;
}

/** True when any live-run owner still claims this row. */
function keepsRunningForStaleSettlement(params: {
  sessionEntry: ReturnType<typeof loadSessionEntry>;
  entry: SessionEntry;
  params: {
    agentId?: string;
    cfg?: OpenClawConfig;
    hasLiveRun: () => boolean;
    isLiveRunContext?: (runId: string) => boolean;
    listSessionRuns?: (params: {
      sessionKey: string;
      sessionId?: string;
    }) => Array<{ runId: string }>;
  };
}): boolean {
  if (params.params.hasLiveRun()) {
    return true;
  }
  if (
    hasOperationalSessionOwner({
      entry: params.entry,
      sessionKey: params.sessionEntry.canonicalKey,
      generation: getAgentEventLifecycleGeneration(),
      isLiveRunContext: params.params.isLiveRunContext ?? hasLiveAgentRunContext,
      listSessionRuns: params.params.listSessionRuns ?? listAgentRunsForSession,
    })
  ) {
    return true;
  }
  return captureYieldedContinuationProtection(
    params.sessionEntry,
    params.entry,
    params.params,
  ).keepsRunning();
}

/**
 * Operational run ownership for a session row.
 *
 * The display projection (`resolveVisibleActiveSessionRunState`) is deliberately
 * narrower than the registry: it omits contexts without active display
 * projection, while `hasLiveAgentRunContext` also recognizes owner claims and
 * retained queue leases. Settlement must use the operational view, including the
 * row's own writer identities and any recovery fence pinned to the current
 * lifecycle generation — otherwise admitted-but-unprojected work is marked
 * failed.
 */
function hasOperationalSessionOwner(params: {
  entry: SessionEntry;
  sessionKey: string;
  generation: string;
  isLiveRunContext: (runId: string) => boolean;
  listSessionRuns: (params: { sessionKey: string; sessionId?: string }) => Array<{ runId: string }>;
}): boolean {
  const rowWriterRunIds = [params.entry.activeWriterRunId, params.entry.lifecycleRunId];
  for (const runId of rowWriterRunIds) {
    if (runId && params.isLiveRunContext(runId)) {
      return true;
    }
  }
  const sessionRuns = params.listSessionRuns({
    sessionKey: params.sessionKey,
    ...(params.entry.sessionId ? { sessionId: params.entry.sessionId } : {}),
  });
  if (sessionRuns.some((run) => params.isLiveRunContext(run.runId))) {
    return true;
  }
  return (params.entry.restartRecoveryRuns ?? []).some(
    (run) => run.lifecycleGeneration === params.generation,
  );
}

/**
 * A parent that yielded while its children run is intentionally still `running`
 * after its own execution registration ends. `captureYieldedMainSessionContinuation`
 * is the existing owner of that distinction (the orphan planner uses it too), so
 * reconciliation must not treat such a row as abandoned.
 *
 * Callers re-capture at commit time instead of retaining the callback: a capture
 * that found no continuation returns a constant `false`, which could not observe
 * a child continuation established while the write waited.
 */
function captureYieldedContinuationProtection(
  sessionEntry: ReturnType<typeof loadSessionEntry>,
  entry: SessionEntry,
  params: { agentId?: string; cfg?: OpenClawConfig },
): { keepsRunning: () => boolean } {
  const captured = captureYieldedMainSessionContinuation({
    sessionKey: sessionEntry.canonicalKey,
    storePath: sessionEntry.storePath,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.cfg ? { cfg: params.cfg } : {}),
    entry,
  });
  return { keepsRunning: captured ?? (() => false) };
}

function isTerminalSessionRunStatus(status: SessionRunStatus | undefined): boolean {
  return status !== undefined && status !== "running";
}
