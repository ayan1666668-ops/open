import path from "node:path";
import { expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { reconcileStaleRunningSession } from "./session-lifecycle-state.js";

const routing = vi.hoisted(() => ({ loadSessionEntry: vi.fn() }));
vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadSessionEntry: routing.loadSessionEntry,
}));

// The yielded-continuation guard reads the subagent registry; the test drives it
// directly so the "parent intentionally still running" case is deterministic.
const subagents = vi.hoisted(() => ({ listSubagentRunsForRequester: vi.fn() }));
vi.mock("../agents/subagents/registry/subagent-registry-read.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../agents/subagents/registry/subagent-registry-read.js")
  >()),
  listSubagentRunsForRequester: subagents.listSubagentRunsForRequester,
}));

function createTarget(label: string) {
  const tempDirs = createTempDirTracker();
  const target = {
    storePath: path.join(tempDirs.make(`openclaw-${label}-`), "sessions.json"),
    sessionKey: `agent:main:${label}`,
  };
  routing.loadSessionEntry.mockImplementation(() => ({
    ...target,
    canonicalKey: target.sessionKey,
    entry: loadSessionEntry(target),
  }));
  return { tempDirs, target };
}

function readLatest(target: { storePath: string; sessionKey: string }) {
  closeOpenClawAgentDatabasesForTest();
  return loadSessionEntry({ ...target, readConsistency: "latest" });
}

function resetRegistry() {
  subagents.listSubagentRunsForRequester.mockReset();
  subagents.listSubagentRunsForRequester.mockReturnValue([]);
}

it("settles a durable running session whose run owner disappeared", async () => {
  const { tempDirs, target } = createTarget("reconcile-stale");
  const runId = "reconcile-stale-run";
  resetRegistry();
  try {
    await replaceSessionEntry(target, {
      sessionId: "reconcile-stale-session",
      lifecycleRunId: runId,
      status: "running",
      startedAt: 1_000,
      updatedAt: 1_000,
    });
    const reconciled = await reconcileStaleRunningSession({
      sessionKey: target.sessionKey,
      hasLiveRun: () => false,
      now: 1_000_000,
    });
    expect(reconciled).toBe(true);
    const settled = readLatest(target);
    expect(settled).toMatchObject({
      status: "failed",
      lastRunId: runId,
      endedAt: 1_000_000,
      runtimeMs: 999_000,
    });
    expect(settled?.lastRunError).toEqual(expect.any(String));
    expect(settled?.lifecycleRunId).toBeUndefined();
  } finally {
    routing.loadSessionEntry.mockReset();
    closeOpenClawAgentDatabasesForTest();
    tempDirs.cleanup();
  }
});

it("leaves a running session alone while its run is still live", async () => {
  const { tempDirs, target } = createTarget("reconcile-live");
  resetRegistry();
  try {
    await replaceSessionEntry(target, {
      sessionId: "reconcile-live-session",
      lifecycleRunId: "reconcile-live-run",
      status: "running",
      startedAt: 1_000,
      updatedAt: 1_000,
    });
    const reconciled = await reconcileStaleRunningSession({
      sessionKey: target.sessionKey,
      hasLiveRun: () => true,
      now: 1_000_000,
    });
    expect(reconciled).toBe(false);
    expect(readLatest(target)?.status).toBe("running");
  } finally {
    routing.loadSessionEntry.mockReset();
    closeOpenClawAgentDatabasesForTest();
    tempDirs.cleanup();
  }
});

it("does not settle a just-started run inside the retry grace window", async () => {
  const { tempDirs, target } = createTarget("reconcile-fresh");
  resetRegistry();
  try {
    await replaceSessionEntry(target, {
      sessionId: "reconcile-fresh-session",
      lifecycleRunId: "reconcile-fresh-run",
      status: "running",
      startedAt: 1_000_000,
      updatedAt: 1_000_000,
    });
    const reconciled = await reconcileStaleRunningSession({
      sessionKey: target.sessionKey,
      hasLiveRun: () => false,
      now: 1_000_000 + 1_000,
    });
    expect(reconciled).toBe(false);
    expect(readLatest(target)?.status).toBe("running");
  } finally {
    routing.loadSessionEntry.mockReset();
    closeOpenClawAgentDatabasesForTest();
    tempDirs.cleanup();
  }
});

it("re-checks liveness under the writer barrier before settling", async () => {
  const { tempDirs, target } = createTarget("reconcile-barrier");
  resetRegistry();
  try {
    await replaceSessionEntry(target, {
      sessionId: "reconcile-barrier-session",
      lifecycleRunId: "reconcile-barrier-run",
      status: "running",
      startedAt: 1_000,
      updatedAt: 1_000,
    });
    // The patch callback sees no live run; the commit guard observes the run that
    // started in between, so the settlement must be declined instead of marking
    // newly live work failed.
    let probes = 0;
    const reconciled = await reconcileStaleRunningSession({
      sessionKey: target.sessionKey,
      hasLiveRun: () => {
        probes += 1;
        return probes > 2;
      },
      now: 1_000_000,
    });
    expect(probes).toBeGreaterThanOrEqual(3);
    expect(reconciled).toBe(false);
    expect(readLatest(target)?.status).toBe("running");
  } finally {
    routing.loadSessionEntry.mockReset();
    closeOpenClawAgentDatabasesForTest();
    tempDirs.cleanup();
  }
});

it("preserves a parent that yielded to a running child continuation", async () => {
  const { tempDirs, target } = createTarget("reconcile-yielded");
  try {
    const owner = {
      runId: "yielded-child-run",
      collect: false,
      expectsCompletionMessage: true,
      requesterTurnRunId: undefined,
      requesterSettleWake: {
        requesterYieldBatch: true,
        rearmGeneration: 7,
        batchRunIds: ["yielded-child-run"],
      },
    };
    subagents.listSubagentRunsForRequester.mockReset();
    subagents.listSubagentRunsForRequester.mockReturnValue([owner]);
    await replaceSessionEntry(target, {
      sessionId: "reconcile-yielded-session",
      lifecycleRunId: "reconcile-yielded-run",
      status: "running",
      startedAt: 1_000,
      updatedAt: 1_000,
      // A yielded parent keeps its durable `running` row after its own execution
      // registration ended; that ended-but-unsettled pair is what marks the debt.
      endedAt: 1_000,
    });
    const reconciled = await reconcileStaleRunningSession({
      sessionKey: target.sessionKey,
      hasLiveRun: () => false,
      now: 1_000_000,
    });
    expect(reconciled).toBe(false);
    expect(readLatest(target)?.status).toBe("running");
  } finally {
    routing.loadSessionEntry.mockReset();
    resetRegistry();
    closeOpenClawAgentDatabasesForTest();
    tempDirs.cleanup();
  }
});

it("re-asserts the caller's authority inside the commit transaction", async () => {
  const { tempDirs, target } = createTarget("reconcile-authority");
  resetRegistry();
  try {
    await replaceSessionEntry(target, {
      sessionId: "reconcile-authority-session",
      lifecycleRunId: "reconcile-authority-run",
      status: "running",
      startedAt: 1_000,
      updatedAt: 1_000,
    });
    let assertions = 0;
    await expect(
      reconcileStaleRunningSession({
        sessionKey: target.sessionKey,
        hasLiveRun: () => false,
        now: 1_000_000,
        // Stands in for a caller whose access is revoked while the write waits.
        assertCommitAllowed: () => {
          assertions += 1;
          throw new Error("caller access revoked before commit");
        },
      }),
    ).rejects.toThrow(/access revoked/);
    expect(assertions).toBeGreaterThan(0);
    expect(readLatest(target)?.status).toBe("running");
  } finally {
    routing.loadSessionEntry.mockReset();
    closeOpenClawAgentDatabasesForTest();
    tempDirs.cleanup();
  }
});
