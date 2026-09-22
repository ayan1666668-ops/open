import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { settleRequesterCompletionBatch } from "../completion/subagent-completion-admission.store.js";
import {
  SubagentLifecycleController,
  type SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// Keep completion, session cleanup, and transport outside this settlement proof.
vi.mock("./subagent-registry-lifecycle-completion.js", () => ({
  completeSubagentRunAttempt: vi.fn(),
}));
vi.mock("./subagent-registry-lifecycle-announce-cleanup.js", () => ({
  finalizeResumedAnnounceGiveUp: vi.fn(),
  resumeAncestorCleanup: vi.fn(),
  startSubagentAnnounceCleanupFlow: vi.fn(),
}));
vi.mock("./subagent-registry-requester-yield.js", () => ({
  settleRequesterTurnAfterSessionSpawns: vi.fn(),
}));
vi.mock("./subagent-registry-lifecycle-delivery.js", () => ({
  buildSafeLifecycleErrorMeta: (error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  }),
  clearSubagentPendingDelivery: vi.fn(),
  markRequesterSettleWakePending: vi.fn(),
  maskLifecycleIdentifier: () => "synthetic",
  refreshFrozenResultFromSession: vi.fn(),
  safeSetSubagentTaskDeliveryStatus: vi.fn(),
}));
vi.mock("../completion/subagent-completion-admission.store.js", () => ({
  blockSubagentCompletionDelivery: vi.fn(),
  settleRequesterCompletionBatch: vi.fn(),
}));
vi.mock("../../agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: vi.fn(),
}));
vi.mock("../../internal-session-effects.js", () => ({
  removeInternalSessionEffectsSession: vi.fn(),
}));
vi.mock("../requester-cron-authority.js", () => ({
  revokeRequesterCronAuthorityBatch: vi.fn(),
}));
vi.mock("./subagent-registry-memory.js", () => ({
  subagentRuns: { confirmRetirement: vi.fn() },
}));
vi.mock("../../../runtime.js", () => ({ defaultRuntime: { log: vi.fn() } }));
vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

type Harness = {
  readonly controller: SubagentLifecycleController;
  readonly entry: SubagentRunRecord;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly persisted: string[][];
  readonly origin: AsyncWorkScope;
};

function buildHarness(taskLookup: "available" | "unavailable", wakeFailure: Error): Harness {
  const entry: SubagentRunRecord = {
    runId: "rejection-run",
    childSessionKey: "agent:main:subagent:rejection-child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "return the child result",
    cleanup: "keep",
    createdAt: 1_000,
    execution: { status: "terminal", endedAt: 4_000 },
    expectsCompletionMessage: false,
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      rearmGeneration: 1,
    },
  };
  const runs = new Map([[entry.runId, entry]]);
  const persisted: string[][] = [];
  const warn = vi.fn();
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected completion, cleanup, or transport effect");
  };
  const wake: SubagentLifecycleOptions["maybeWakeRequesterAfterAllChildrenSettled"] = async () => {
    throw wakeFailure;
  };
  const controller = new SubagentLifecycleController({
    runs,
    resumedRuns: new Set(),
    subagentAnnounceTimeoutMs: 1_000,
    getRuntimeConfig: () => ({}),
    persist: vi.fn(),
    persistOrThrow: (...runIds: string[]) => persisted.push(runIds),
    clearPendingLifecycleError: vi.fn(),
    countPendingDescendantRuns: () => 0,
    getLatestRunForChildSession: () => null,
    suppressAnnounceForSteerRestart: () => false,
    resolveSubagentTask: () => ({ lookup: taskLookup }),
    shouldEmitEndedHookForRun: () => false,
    emitSubagentEndedHookForRun: unexpected,
    emitSubagentProgressEndedForRun: unexpected,
    notifyContextEngineSubagentEnded: unexpected,
    retireSupersededRun: unexpected,
    resumeSubagentRun: vi.fn(),
    callGateway: unexpected,
    captureSubagentCompletionReply: unexpected,
    cleanupBrowserSessionsForLifecycleEnd: unexpected,
    runSubagentAnnounceFlow: unexpected,
    maybeWakeRequesterAfterAllChildrenSettled: wake,
    warn,
  });
  return { controller, entry, warn, persisted, origin: new AsyncWorkScope() };
}

function warnedMessages(warn: ReturnType<typeof vi.fn>): string[] {
  return warn.mock.calls.map((call) => String(call[0]));
}

// karmaterminal/openclaw#1363. A requester settle wake that fails must be able to
// record its own rejection. It records that rejection through
// completeRequesterSettleWakeBatch with an outcome, which resolves the owning
// detached task FIRST and throws "subagent completion owner unavailable before
// settlement" when the lookup is not available. A task that has gone away does
// not come back, so that write throws on every later attempt and the row is never
// given a terminal state: it stays armed and re-fires for the life of the process.
//
// Observed on the silas seat as an exact 1:1 pair of "requester settle wake failed"
// and "failed to persist requester settle wake rejection" at a rigid 60s cadence
// (360 of each over three hours). The rigid 60s is itself the proof that
// deferWakeCommit's 30s/60s/120s backoff is NOT driving the loop, so
// pending.failures never accumulates across cycles and a ceiling on it could
// never fire.
//
// BELLED ROPE: the second case below pins the CURRENT DEFECTIVE behavior. If you
// are fixing #1363, it SHOULD fail — change it deliberately, and keep the first
// case, which is the contract that must survive any fix.
describe("requester settle wake rejection write", () => {
  it("records the rejection through settlement when the completion owner is available", async () => {
    vi.clearAllMocks();
    resetGatewayWorkAdmission();
    const { controller, entry, warn, origin } = buildHarness(
      "available",
      new Error("wake transport refused"),
    );
    try {
      origin.run(() => controller.resumeRequesterSettleWake(entry.runId, entry));
      await vi.waitFor(() => {
        expect(warnedMessages(warn)).toContain("requester settle wake failed");
      });
      // The rejection write succeeds, so the caller never observes a rethrow.
      expect(warnedMessages(warn)).not.toContain(
        "failed to persist requester settle wake rejection",
      );
      // The rejection reached settlement carrying the failed outcome. Disarming the
      // row is settleRequesterCompletionBatch's job and is mocked out of this proof;
      // what matters here is that the write was ATTEMPTED and did not throw.
      expect(settleRequesterCompletionBatch).toHaveBeenCalledTimes(1);
      const settled = vi.mocked(settleRequesterCompletionBatch).mock.calls[0]?.[0];
      expect(settled?.outcome).toMatchObject({ delivered: false, path: "none" });
      expect(settled?.entries.map((member) => member.subagent.runId)).toEqual(["rejection-run"]);
    } finally {
      controller.clearScheduledResumeTimers();
      await origin.drain();
      resetGatewayWorkAdmission();
    }
  });

  it("cannot record the rejection and leaves the row armed when the completion owner is gone", async () => {
    vi.clearAllMocks();
    resetGatewayWorkAdmission();
    const { controller, entry, warn, persisted, origin } = buildHarness(
      "unavailable",
      new Error("wake transport refused"),
    );
    try {
      origin.run(() => controller.resumeRequesterSettleWake(entry.runId, entry));
      await vi.waitFor(() => {
        expect(warnedMessages(warn)).toContain("failed to persist requester settle wake rejection");
      });
      const messages = warnedMessages(warn);
      // The exact 1:1 pair seen on the seat: the second line is the caller
      // observing commitRequesterWake's intentional rethrow, not a second fault.
      expect(messages.filter((m) => m === "requester settle wake failed")).toHaveLength(1);
      expect(
        messages.filter((m) => m === "failed to persist requester settle wake rejection"),
      ).toHaveLength(1);
      // The throw happens while resolving the owner, BEFORE any durable write.
      expect(persisted).toEqual([]);
      // No terminal state was reached, so the row remains eligible to re-fire.
      expect(entry.requesterSettleWake).toBeDefined();
      expect(entry.requesterSettleWake?.rearmGeneration).toBe(1);
    } finally {
      controller.clearScheduledResumeTimers();
      await origin.drain();
      resetGatewayWorkAdmission();
    }
  });
});
