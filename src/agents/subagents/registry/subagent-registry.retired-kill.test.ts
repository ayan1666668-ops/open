import { beforeEach, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { getTaskById } from "../../../tasks/runtime-internal.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { settleSubagentCompletionDelivery } from "../completion/subagent-completion-admission.store.js";
import {
  records,
  requesterWakeDriver,
} from "../completion/subagent-completion-admission.test-helpers.js";
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { SubagentRegistryDeps } from "./subagent-registry-deps.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { settleSubagentRegistryPersistenceWork } from "./subagent-registry.persistence.test-support.js";
import {
  bindSubagentRunRecord,
  loadSubagentRegistryFromSqlite,
  upsertSubagentRunRowInDatabase,
} from "./subagent-registry.store.sqlite.js";
import {
  activateSubagentRegistry,
  initSubagentRegistry,
  resumeSubagentRun,
  testing,
} from "./subagent-registry.test-helpers.js";

const fixture = useSubagentControlFixture();
const wake = vi.fn<SubagentRegistryDeps["maybeWakeRequesterAfterAllChildrenSettled"]>();
const announce = vi.fn<SubagentRegistryDeps["runSubagentAnnounceFlow"]>();
const capture = vi.fn<SubagentRegistryDeps["captureSubagentCompletionReply"]>();
const cleanup = vi.fn<SubagentRegistryDeps["cleanupBrowserSessionsForLifecycleEnd"]>();

beforeEach(() => {
  wake.mockReset().mockImplementation(async (params) => {
    params.completeBatch([params.settledEntry], 1, {
      delivered: false,
      path: "none",
      error: "requester unavailable",
    });
    return false;
  });
  announce.mockReset().mockResolvedValue("delivered");
  capture.mockReset().mockResolvedValue(undefined);
  cleanup.mockReset().mockResolvedValue(undefined);
  testing.setDepsForTest({
    callGateway: fixture.gateway,
    loadAgentRuntimePluginRegistryHandle: () => undefined,
    maybeWakeRequesterAfterAllChildrenSettled: wake,
    runSubagentAnnounceFlow: announce,
    captureSubagentCompletionReply: capture,
    cleanupBrowserSessionsForLifecycleEnd: cleanup,
  });
});

function historicalCancellation() {
  const input = records();
  const endedAt = Date.now() - 9 * 24 * 60 * 60_000;
  input.subagent = createSubagentRunRecord({
    runId: input.subagent.runId,
    generation: 1,
    taskRunId: input.task.runId,
    childSessionKey: input.subagent.childSessionKey,
    createdAt: endedAt - 60_000,
    startedAt: endedAt - 50_000,
    endedAt,
    endedReason: SUBAGENT_ENDED_REASON_KILLED,
    outcome: { status: "error", error: "stopped" },
    cleanup: "keep",
    cleanupHandled: true,
    cleanupCompletedAt: endedAt,
    suppressAnnounceReason: "killed",
    killReconciliation: { killedAt: endedAt - 2 },
    expectsCompletionMessage: true,
    completion: { required: true },
    delivery: { status: "pending" },
    requesterSettleWake: { status: "dispatching", attemptCount: 3, rearmGeneration: 1 },
  });
  input.task.status = "cancelled";
  input.task.createdAt = input.subagent.createdAt;
  input.task.endedAt = endedAt;
  return input;
}

function persist(input: ReturnType<typeof records>, keepTask = false) {
  const database = openOpenClawStateDatabase();
  settleSubagentCompletionDelivery({ ...input, databaseOptions: { database } });
  if (!keepTask) {
    database.db.prepare("DELETE FROM task_runs WHERE task_id = ?").run(input.task.taskId);
  }
}

function restore() {
  initSubagentRegistry();
  // These terminal-only fixtures need a live owner but never dispatch a model turn.
  const gateway = { resolveGatewayContext: () => gateway as never };
  activateSubagentRegistry(() => gateway as never);
}

function expectNoExecutionReplay() {
  expect(announce).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled();
  expect(cleanup).not.toHaveBeenCalled();
  expect(fixture.gateway).not.toHaveBeenCalled();
}

describe("restored historical cancellation ownership", () => {
  it("reconciles the kill owner before waking a pruned task without repeating cleanup", async () => {
    const input = historicalCancellation();
    persist(input);
    restore();
    resumeSubagentRun(input.subagent.runId, "restore");
    await settleSubagentRegistryPersistenceWork();
    await testing.sweepOnceForTests();
    await settleSubagentRegistryPersistenceWork();

    const saved = loadSubagentRegistryFromSqlite().get(input.subagent.runId)!;
    expect(saved.killReconciliation).toBeUndefined();
    expect(saved.requesterSettleWake).toBeUndefined();
    expect(saved.execution).toEqual(input.subagent.execution);
    expect(saved.cleanupCompletedAt).toBe(input.subagent.cleanupCompletedAt);
    expect(saved.delivery).toMatchObject({ status: "failed", lastError: "requester unavailable" });
    expect(saved.completion).toEqual({
      required: true,
      capturedAt: input.subagent.execution.endedAt,
      resultText: null,
    });
    expect(getTaskById(input.task.taskId)).toBeUndefined();
    expect(wake).toHaveBeenCalledOnce();
    expectNoExecutionReplay();
  });

  it("leaves a newer persisted kill marker untouched by the restored snapshot", async () => {
    const input = historicalCancellation();
    persist(input);
    restore();
    const updated = structuredClone(input.subagent);
    updated.killReconciliation = { killedAt: Date.now() };
    upsertSubagentRunRowInDatabase(openOpenClawStateDatabase(), bindSubagentRunRecord(updated));

    resumeSubagentRun(input.subagent.runId, "restore");
    await settleSubagentRegistryPersistenceWork();
    await testing.sweepOnceForTests();
    await settleSubagentRegistryPersistenceWork();

    expect(loadSubagentRegistryFromSqlite().get(input.subagent.runId)).toEqual(updated);
    expect(wake).not.toHaveBeenCalled();
    expectNoExecutionReplay();
  });

  it("preserves a newer child generation instead of waking the retired cancellation", async () => {
    const input = historicalCancellation();
    persist(input);
    const successor = createSubagentRunRecord({
      runId: "successor-run",
      childSessionKey: input.subagent.childSessionKey,
      generation: 2,
      createdAt: input.subagent.createdAt + 1,
      endedAt: input.subagent.execution.endedAt,
      outcome: { status: "ok" },
      cleanup: "keep",
      cleanupHandled: true,
      cleanupCompletedAt: input.subagent.cleanupCompletedAt,
      expectsCompletionMessage: false,
      completion: { required: false, resultText: "completed", capturedAt: Date.now() },
      delivery: { status: "not_required" },
    });
    upsertSubagentRunRowInDatabase(openOpenClawStateDatabase(), bindSubagentRunRecord(successor));
    restore();
    resumeSubagentRun(input.subagent.runId, "restore");
    await settleSubagentRegistryPersistenceWork();
    const before = loadSubagentRegistryFromSqlite().get(successor.runId);
    await testing.sweepOnceForTests();
    await settleSubagentRegistryPersistenceWork();

    expect(loadSubagentRegistryFromSqlite().get(successor.runId)).toEqual(before);
    expect(wake).not.toHaveBeenCalled();
    expect(getTaskById(input.task.taskId)).toBeUndefined();
    expectNoExecutionReplay();
  });

  it("keeps ordinary yielded wakes ahead of terminal cleanup", async () => {
    const input = historicalCancellation();
    input.subagent.pauseReason = "sessions_yield";
    input.subagent.endedReason = undefined;
    input.subagent.killReconciliation = undefined;
    input.subagent.execution.outcome = undefined;
    input.subagent.cleanupCompletedAt = undefined;
    input.subagent.cleanupHandled = false;
    input.subagent.requesterSettleWake!.retireAfterSettle = true;
    input.task.status = "running";
    delete input.task.endedAt;
    persist(input, true);
    restore();
    await settleSubagentRegistryPersistenceWork();
    await testing.sweepOnceForTests();
    await settleSubagentRegistryPersistenceWork();

    const saved = loadSubagentRegistryFromSqlite().get(input.subagent.runId)!;
    expect(saved.requesterSettleWake).toBeUndefined();
    expect(saved.execution).toEqual(input.subagent.execution);
    expect(saved.pauseReason).toBe("sessions_yield");
    expect(saved.delivery).toEqual(input.subagent.delivery);
    expect(getTaskById(input.task.taskId)?.status).toBe("running");
    expect(wake).toHaveBeenCalledOnce();
    expectNoExecutionReplay();
  });

  it.each([-1, 0, 1])(
    "does not reopen a cleaned cancellation for a delayed killed callback (%ims)",
    async (offset) => {
      const input = historicalCancellation();
      input.subagent.killReconciliation = undefined;
      persist(input);
      subagentRuns.set(input.subagent.runId, input.subagent);
      const driver = requesterWakeDriver([input]);
      const before = structuredClone(input.subagent);
      try {
        await driver.controller.completeSubagentRun({
          runId: input.subagent.runId,
          expectedEntry: input.subagent,
          endedAt: input.subagent.execution.endedAt! + offset,
          reason: SUBAGENT_ENDED_REASON_KILLED,
          outcome: { status: "error", error: "stopped" },
          triggerCleanup: true,
        });

        expect(input.subagent).toEqual(before);
        expect(loadSubagentRegistryFromSqlite().get(input.subagent.runId)).toEqual(before);
        expect(driver.wake).not.toHaveBeenCalled();
        expect(getTaskById(input.task.taskId)).toBeUndefined();
        expectNoExecutionReplay();
      } finally {
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );
});
