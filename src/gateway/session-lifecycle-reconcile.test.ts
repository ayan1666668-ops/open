import path from "node:path";
import { expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { reconcileStaleRunningSession } from "./session-lifecycle-state.js";
import { projectGatewaySessionActiveRun } from "./session-utils-display.js";

const routing = vi.hoisted(() => ({ loadSessionEntry: vi.fn() }));
vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadSessionEntry: routing.loadSessionEntry,
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

it("settles a durable running session whose run owner disappeared", async () => {
  const { tempDirs, target } = createTarget("reconcile-stale");
  const runId = "reconcile-stale-run";
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
  try {
    await replaceSessionEntry(target, {
      sessionId: "reconcile-barrier-session",
      lifecycleRunId: "reconcile-barrier-run",
      status: "running",
      startedAt: 1_000,
      updatedAt: 1_000,
    });
    // First probe sees no live run; the barrier recheck observes the run that
    // started in between, so the reconcile must abort the write.
    let probes = 0;
    const reconciled = await reconcileStaleRunningSession({
      sessionKey: target.sessionKey,
      hasLiveRun: () => {
        probes += 1;
        return probes > 1;
      },
      now: 1_000_000,
    });
    expect(probes).toBeGreaterThanOrEqual(2);
    expect(reconciled).toBe(false);
    expect(readLatest(target)?.status).toBe("running");
  } finally {
    routing.loadSessionEntry.mockReset();
    closeOpenClawAgentDatabasesForTest();
    tempDirs.cleanup();
  }
});

it("projects a stale running row as terminal only when asked", () => {
  expect(
    projectGatewaySessionActiveRun({ active: false }, "running", { staleRunning: true }),
  ).toEqual({ hasActiveRun: false, status: "failed" });
  expect(projectGatewaySessionActiveRun({ active: false }, "running")).toEqual({
    hasActiveRun: false,
    status: "running",
  });
  expect(projectGatewaySessionActiveRun({ active: true }, "running")).toEqual({
    hasActiveRun: true,
    status: "running",
  });
  expect(
    projectGatewaySessionActiveRun({ active: false }, "failed", { staleRunning: true }),
  ).toEqual({ hasActiveRun: false, status: "failed" });
});
