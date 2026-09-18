// Covers runCampaignUpdate's exception boundary: a state write that throws must
// name its cause in the Gateway log, not only in the update-run ledger.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import type { UpdateCheckResult } from "./update-check.js";
import { getUpdateRun, listUpdateRuns } from "./update-run-ledger.js";
import { getUpdateSchedule } from "./update-status-state.js";

const { sentinelFault } = vi.hoisted((): { sentinelFault: { error?: Error } } => ({
  sentinelFault: {},
}));

vi.mock("./restart-sentinel.js", async () => {
  const actual =
    await vi.importActual<typeof import("./restart-sentinel.js")>("./restart-sentinel.js");
  return {
    ...actual,
    readRestartSentinelSnapshot: async (
      ...args: Parameters<typeof actual.readRestartSentinelSnapshot>
    ) => {
      if (sentinelFault.error) {
        throw sentinelFault.error;
      }
      return await actual.readRestartSentinelSnapshot(...args);
    },
  };
});

vi.mock("./openclaw-root.js", async () => ({
  ...(await vi.importActual<typeof import("./openclaw-root.js")>("./openclaw-root.js")),
  resolveOpenClawPackageRoot: vi.fn(async () => "/opt/openclaw"),
}));

vi.mock("./update-check.js", async () => ({
  ...(await vi.importActual<typeof import("./update-check.js")>("./update-check.js")),
  checkUpdateStatus: vi.fn(),
  resolveNpmChannelTag: vi.fn(),
}));

vi.mock("./update-triage.js", () => ({ runUpdateFailureTriage: vi.fn() }));

vi.mock("./telemetry.js", () => ({ checkTelemetryUpdate: vi.fn(async () => null) }));

vi.mock("../model-catalog/remote-refresh.js", async () => ({
  ...(await vi.importActual<typeof import("../model-catalog/remote-refresh.js")>(
    "../model-catalog/remote-refresh.js",
  )),
  refreshRemoteModelCatalog: vi.fn(async () => ({
    status: "unchanged" as const,
    providers: 1,
    models: 1,
    generatedAt: 1_753_500_000_000,
  })),
}));

function idleActiveWorkInspectors(): GatewayActiveWorkInspectors {
  return {
    getQueueSize: () => 0,
    getPendingReplies: () => 0,
    getEmbeddedRuns: () => 0,
    getBackgroundExecSessions: () => 0,
    getCronRuns: () => 0,
    getActiveTasks: () => 0,
    getTaskBlockers: () => [],
    getRootRequests: () => 0,
    getSessionAdmissions: () => 0,
    getSessionMutations: () => 0,
    getChatRuns: () => 0,
    getQueuedTurns: () => 0,
    getTerminalPersistence: () => 0,
    getTerminalSessions: () => 0,
  };
}

describe("update campaign apply exception boundary", () => {
  let testState: OpenClawTestState;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T10:00:00Z"));
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-update-campaign-apply-",
      env: {
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_NO_AUTO_UPDATE: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        NODE_ENV: "test",
        VITEST: undefined,
      },
    });
  });

  afterEach(async () => {
    delete sentinelFault.error;
    const { resetUpdateAvailableStateForTest } = await import("./update-startup.js");
    resetUpdateAvailableStateForTest();
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
    await testState.cleanup();
  });

  it("logs the cause when a campaign apply throws before the updater runs", async () => {
    const { checkUpdateStatus, resolveNpmChannelTag } = await import("./update-check.js");
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/opt/openclaw",
      installKind: "git",
      packageManager: "pnpm",
      git: {
        root: "/opt/openclaw",
        sha: "current-sha",
        tag: null,
        branch: "main",
        upstream: "origin/main",
        upstreamSource: "tracking",
        upstreamSha: "upstream-sha",
        commitAtMs: null,
        dirty: false,
        ahead: 0,
        behind: 2,
        fetchOk: true,
      },
    } satisfies UpdateCheckResult);
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({ tag: "dev", version: "99.0.0-dev.1" });
    const { runGatewayUpdateCheck } = await import("./update-startup.js");
    const runAutoUpdate = vi.fn(async () => ({ status: "handoff" as const }));
    const log = { info: vi.fn() };
    sentinelFault.error = new Error("state write refused: SQLITE_READONLY");

    await runGatewayUpdateCheck({
      getConfig: () => ({ update: { channel: "dev", auto: { enabled: true } } }),
      log,
      isNixMode: false,
      allowInTests: true,
      activeWorkInspectors: idleActiveWorkInspectors(),
      runAutoUpdate,
    });
    expect(getUpdateSchedule()?.campaign?.state).toBe("countdown");

    await vi.advanceTimersByTimeAsync(60_000);

    const runId = listUpdateRuns()[0]?.runId ?? "";
    expect(getUpdateRun(runId)).toMatchObject({ status: "failed", reason: "unexpected-error" });
    expect(runAutoUpdate).not.toHaveBeenCalled();
    expect(getUpdateSchedule()?.campaign).toBeUndefined();
    const failureLog = log.info.mock.calls.find(([message]) =>
      String(message).includes("state write refused: SQLITE_READONLY"),
    );
    expect(failureLog).toBeDefined();
    expect(failureLog?.[1]).toMatchObject({ channel: "dev", forced: false, tag: "dev" });
  });
});
