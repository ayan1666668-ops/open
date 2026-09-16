import { describe, expect, it, vi } from "vitest";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cronStoreKey } from "../store/key.js";
import { readCronTaskRunHistoryPage } from "../task-run-history.js";
import type { CronFailureNotificationDelivery, CronJob } from "../types.js";
import { maybeEmitFailureAlert } from "./failure-alerts.js";
import { createCronServiceState } from "./state.js";
import {
  settleCronTaskRunFailureAlertOutcome,
  tryCreateCronTaskRunHandle,
  tryFinishCronTaskRun,
} from "./task-runs.js";

function tryCreateCronTaskRun(
  params: Parameters<typeof tryCreateCronTaskRunHandle>[0],
): string | undefined {
  return tryCreateCronTaskRunHandle(params)?.runId;
}

function buildJob(id: string): CronJob {
  return {
    id,
    name: id,
    agentId: "   ",
    sessionKey: "agent:ops:telegram:group:creator",
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "work" },
    schedule: { kind: "every", everyMs: 60_000 },
    state: {},
    createdAtMs: 100,
    updatedAtMs: 100,
    enabled: true,
  };
}

function createState(
  params: {
    sendCronFailureAlert?: (transport: {
      onDeliverySettled: (outcome: CronFailureNotificationDelivery) => Promise<void>;
    }) => Promise<void>;
  } = {},
): ReturnType<typeof createCronServiceState> {
  return createCronServiceState({
    storePath: "/tmp/jobs.json",
    cronEnabled: true,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
    ...(params.sendCronFailureAlert
      ? {
          sendCronFailureAlert: async (depParams) => {
            await params.sendCronFailureAlert?.(depParams);
          },
        }
      : {}),
  });
}

/** Creates a run and finalizes its history row the way production does while the alert is still pending. */
function createPendingRun(state: ReturnType<typeof createCronServiceState>, job: CronJob): string {
  const taskRunId = tryCreateCronTaskRun({ state, job, startedAt: 1_500 });
  if (!taskRunId) {
    throw new Error("expected the cron task run to be created");
  }
  const finished = {
    action: "finished",
    jobId: job.id,
    job,
    status: "error",
    error: "job failed",
    failureNotificationDelivery: { status: "unknown" },
    runAtMs: 1_500,
  };
  tryFinishCronTaskRun(state, {
    taskRunId,
    job,
    // SAFETY: the history writer only reads these finished-event fields; the wire type carries optional telemetry this fixture does not supply.
    event: finished as Parameters<typeof tryFinishCronTaskRun>[1]["event"],
  });
  return taskRunId;
}

function emitDeferredFailureAlert(
  state: ReturnType<typeof createCronServiceState>,
  job: CronJob,
  taskRunId: string | undefined,
): void {
  const deferred: Array<() => void> = [];
  maybeEmitFailureAlert(state, {
    job,
    alertConfig: {
      after: 1,
      cooldownMs: 60_000,
      channel: "last",
      mode: "announce",
      includeSkipped: false,
      alternateRoute: false,
    },
    status: "error",
    error: "job failed",
    consecutiveCount: 1,
    deferredNotifications: deferred,
    taskRunId,
  });
  for (const notify of deferred) {
    notify();
  }
}

describe("cron failure-alert run-history settlement", () => {
  it("settles the deferred alert outcome on the run-history row and stays idempotent", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-alert-history-settle-" },
      async () => {
        resetTaskRegistryForTests();
        const job = buildJob("alert-history-settle");
        const state = createState({
          sendCronFailureAlert: async (transport) => {
            await transport.onDeliverySettled({ delivered: true, status: "delivered" });
          },
        });

        const taskRunId = createPendingRun(state, job);
        const storeKey = cronStoreKey(state.deps.storePath);
        const readDelivery = () =>
          readCronTaskRunHistoryPage({ jobId: job.id, storeKey, limit: 10 }).entries[0]
            ?.failureNotificationDelivery;
        expect(readDelivery()).toMatchObject({ status: "unknown" });

        emitDeferredFailureAlert(state, job, taskRunId);
        await vi.waitFor(() => {
          expect(readDelivery()).toMatchObject({ status: "delivered", delivered: true });
        });

        // A late duplicate completion must not downgrade the settled history row.
        settleCronTaskRunFailureAlertOutcome(state, {
          taskRunId,
          outcome: { delivered: false, status: "not-delivered", error: "late transport failure" },
        });
        expect(readDelivery()).toMatchObject({ status: "delivered", delivered: true });
      },
    );
  });

  it("retains an uncertain channel outcome instead of confirming delivery", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-alert-uncertain-settle-" },
      async () => {
        resetTaskRegistryForTests();
        const job = buildJob("alert-uncertain-settle");
        const settlement = { done: false };
        const state = createState({
          sendCronFailureAlert: async (transport) => {
            // Mirrors the Gateway transport: adapter_returned_no_identity means a
            // retry might duplicate the send, not that the recipient got it.
            await transport.onDeliverySettled({
              status: "unknown",
              error: "cron failure alert outcome is unknown: adapter_returned_no_identity",
            });
            settlement.done = true;
          },
        });

        const taskRunId = createPendingRun(state, job);
        const storeKey = cronStoreKey(state.deps.storePath);
        const readDelivery = () =>
          readCronTaskRunHistoryPage({ jobId: job.id, storeKey, limit: 10 }).entries[0]
            ?.failureNotificationDelivery;

        emitDeferredFailureAlert(state, job, taskRunId);
        await vi.waitFor(() => {
          expect(settlement.done).toBe(true);
        });
        // The settled fact landed (its reason is now on the row) but stays uncertain.
        expect(readDelivery()?.error).toContain("adapter_returned_no_identity");
        expect(readDelivery()).toMatchObject({ status: "unknown" });
        expect(readDelivery()).not.toMatchObject({ delivered: true });
        expect(readDelivery()).not.toMatchObject({ status: "not-delivered" });
      },
    );
  });

  it("redacts and bounds transport errors before they reach run history", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-alert-redacted-settle-" },
      async () => {
        resetTaskRegistryForTests();
        const job = buildJob("alert-redacted-settle");
        const secret = "sk-ant-secret-0123456789abcdef0123456789abcdef";
        const state = createState({
          sendCronFailureAlert: async (transport) => {
            await transport.onDeliverySettled({
              delivered: false,
              status: "not-delivered",
              error: `webhook post failed: https://user:${secret}@hooks.example.com/deliver`,
            });
          },
        });

        const taskRunId = createPendingRun(state, job);
        const storeKey = cronStoreKey(state.deps.storePath);
        const readDelivery = () =>
          readCronTaskRunHistoryPage({ jobId: job.id, storeKey, limit: 10 }).entries[0]
            ?.failureNotificationDelivery;

        emitDeferredFailureAlert(state, job, taskRunId);
        await vi.waitFor(() => {
          expect(readDelivery()).toMatchObject({ status: "not-delivered" });
        });
        const persisted = JSON.stringify(readDelivery());
        expect(persisted).not.toContain(secret);
      },
    );
  });

  it("keeps the run-history outcome pending when no transport is configured", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-alert-transportless-settle-" },
      async () => {
        resetTaskRegistryForTests();
        const job = buildJob("alert-transportless-settle");
        // No sendCronFailureAlert dep: settlement must not run before terminal
        // publication (or at all), matching the transport-less unknown contract.
        const state = createState();

        const taskRunId = createPendingRun(state, job);
        const storeKey = cronStoreKey(state.deps.storePath);
        const readDelivery = () =>
          readCronTaskRunHistoryPage({ jobId: job.id, storeKey, limit: 10 }).entries[0]
            ?.failureNotificationDelivery;

        emitDeferredFailureAlert(state, job, taskRunId);
        expect(readDelivery()).toMatchObject({ status: "unknown" });
      },
    );
  });
});
