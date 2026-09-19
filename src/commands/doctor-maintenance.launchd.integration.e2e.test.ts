import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-maintenance.js";
import {
  readLaunchAgentRuntime,
  resolveLaunchAgentLabel,
  uninstallLaunchAgent,
} from "../daemon/launchd.js";
import { withGatewayServiceOperationLock } from "../daemon/service-operation-lock.js";
import { resolveGatewayService } from "../daemon/service.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { tryAcquireExclusiveSqliteCoordinator } from "../infra/sqlite-coordinator.js";
import { acquireGatewayLifecycleCoordinator } from "../infra/state-database-coordinator.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const mocks = vi.hoisted(() => ({
  serviceMaintenance: vi.fn(),
  revalidateService: vi.fn(),
  waitForHealthy: vi.fn(),
}));

vi.mock("../cli/update-cli/update-command-service-maintenance.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../cli/update-cli/update-command-service-maintenance.js")
    >();
  return {
    ...actual,
    maybeStopManagedServiceBeforeMutableUpdate: (
      params: Parameters<typeof actual.maybeStopManagedServiceBeforeMutableUpdate>[0],
    ) => mocks.serviceMaintenance(params),
    revalidateManagedGatewayServiceAfterUpdate: (
      params: Parameters<typeof actual.revalidateManagedGatewayServiceAfterUpdate>[0],
    ) => mocks.revalidateService(params),
  };
});

vi.mock("../cli/daemon-cli/restart-health.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/daemon-cli/restart-health.js")>();
  return {
    ...actual,
    waitForGatewayHealthyRestart: (...args: unknown[]) => mocks.waitForHealthy(...args),
  };
});

vi.mock("./doctor-service-repair-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-service-repair-policy.js")>()),
  shouldManageGatewayService: async () => true,
}));

vi.mock("./doctor-maintenance-stale-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-maintenance-stale-service.js")>()),
  inspectStaleDoctorGateway: async () => undefined,
}));

const WAIT_INTERVAL_MS = 100;
const WAIT_TIMEOUT_MS = 30_000;
const MAX_EVENT_BYTES = 4_096;
const MAX_EVENTS = 16;

function canRunLaunchdIntegration(): boolean {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") {
    return false;
  }
  return (
    spawnSync("launchctl", ["print", `gui/${process.getuid()}`], {
      encoding: "utf8",
    }).status === 0
  );
}

const describeLaunchdIntegration = canRunLaunchdIntegration() ? describe : describe.skip;

type ProbeEvent = { kind: "start" | "SIGTERM"; pid: number };

async function readProbeEvents(eventsPath: string): Promise<ProbeEvent[]> {
  const stat = await fs.stat(eventsPath);
  expect(stat.size).toBeLessThanOrEqual(MAX_EVENT_BYTES);
  const lines = (await fs.readFile(eventsPath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
  expect(lines.length).toBeLessThanOrEqual(MAX_EVENTS);
  return lines.map((line) => {
    const match = /^(start|SIGTERM) ([1-9]\d*)$/.exec(line);
    expect(match, `unexpected native event: ${line}`).not.toBeNull();
    return { kind: match![1] as ProbeEvent["kind"], pid: Number(match![2]) };
  });
}

async function waitForProbeStarts(eventsPath: string, count: number): Promise<ProbeEvent[]> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const events = await readProbeEvents(eventsPath);
    if (events.filter((event) => event.kind === "start").length >= count) {
      return events;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, WAIT_INTERVAL_MS);
    });
  }
  throw new Error(`Timed out waiting for ${count} native LaunchAgent starts`);
}

async function waitForLaunchAgentState(
  env: NodeJS.ProcessEnv,
  expected: "running" | "stopped",
): Promise<{ pid?: number }> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const runtime = await readLaunchAgentRuntime(env);
    if (
      (expected === "running" && runtime.status === "running" && (runtime.pid ?? 0) > 1) ||
      (expected === "stopped" && runtime.status !== "running" && runtime.pid === undefined)
    ) {
      return runtime.pid === undefined ? {} : { pid: runtime.pid };
    }
    await new Promise((resolve) => {
      setTimeout(resolve, WAIT_INTERVAL_MS);
    });
  }
  throw new Error(`Timed out waiting for native LaunchAgent state ${expected}`);
}

async function writeProbeScript(scriptPath: string, eventsPath: string): Promise<void> {
  await fs.writeFile(
    scriptPath,
    [
      'const fs = require("node:fs");',
      `const eventsPath = ${JSON.stringify(eventsPath)};`,
      "fs.appendFileSync(eventsPath, `start ${process.pid}\\n`);",
      'process.on("SIGTERM", () => {',
      "  fs.appendFileSync(eventsPath, `SIGTERM ${process.pid}\\n`);",
      "  process.exit(0);",
      "});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function withNativeDoctorFixture(
  operation: (fixture: {
    env: NodeJS.ProcessEnv;
    eventsPath: string;
    maintenance: NonNullable<Awaited<ReturnType<typeof beginDoctorMaintenance>>>;
    initialPid: number;
    logs: string[];
  }) => Promise<void>,
): Promise<void> {
  const id = randomUUID().slice(0, 8);
  const profile = `doctor-launchd-int-${id}`;
  const accountHome = userInfo().homedir;
  const stateDir = path.join(accountHome, `.openclaw-${profile}`);
  const probeDir = await fs.mkdtemp(path.join(tmpdir(), `openclaw-doctor-launchd-${id}-`));
  const eventsPath = path.join(probeDir, "events.log");
  const scriptPath = path.join(probeDir, "probe.cjs");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: accountHome,
    OPENCLAW_HOME: undefined,
    OPENCLAW_PROFILE: profile,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_LAUNCHD_LABEL: undefined,
    OPENCLAW_SERVICE_KIND: undefined,
    OPENCLAW_SUPERVISOR_MODE: undefined,
    OPENCLAW_UPDATE_RUN_ID: undefined,
    OPENCLAW_UPDATE_IN_PROGRESS: undefined,
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: undefined,
  };
  const stdout = new PassThrough();
  const service = resolveGatewayService();
  let delayedOwner: ReturnType<typeof tryAcquireExclusiveSqliteCoordinator> | undefined;
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(eventsPath, "", "utf8");
  await writeProbeScript(scriptPath, eventsPath);
  try {
    await withEnvAsync(env, async () => {
      await service.install({
        env,
        stdout,
        programArguments: [process.execPath, scriptPath],
        environment: env,
      });
      const initial = await waitForLaunchAgentState(env, "running");
      if (initial.pid === undefined) {
        throw new Error("Native LaunchAgent did not report a process ID");
      }
      await waitForProbeStarts(eventsPath, 1);
      const databasePath = openOpenClawStateDatabase().path;
      closeOpenClawStateDatabaseForTest();
      const startedAt = getFileLockProcessStartTime(initial.pid);
      if (startedAt === null) {
        throw new Error("Current process start identity is unavailable");
      }
      const db = openNodeSqliteDatabase(databasePath);
      try {
        const now = Date.now();
        db.prepare(
          `INSERT INTO state_leases
             (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
           VALUES ('gateway-owner', 'global', 'doctor-launchd-integration', ?, ?, ?, ?, ?)`,
        ).run(
          now + 60_000,
          now,
          JSON.stringify({
            owner: { pid: initial.pid, host: hostname(), startedAt },
            port: 18789,
            mode: "supervised",
            supervisor: { kind: "launchd", name: profile },
          }),
          now,
          now,
        );
      } finally {
        db.close();
      }
      const coordinator = acquireGatewayLifecycleCoordinator({ databasePath });
      coordinator.release();
      delayedOwner = tryAcquireExclusiveSqliteCoordinator(coordinator.path, { busyTimeoutMs: 0 });
      if (!delayedOwner) {
        throw new Error("Could not hold delayed gateway-lifecycle ownership");
      }
      const verdict = {
        kind: "owned" as const,
        root: process.cwd(),
        fingerprint: `doctor-launchd-${id}`,
        refreshDefinition: false,
      };
      const before: PreManagedServiceStop = {
        stopped: false,
        inspected: true,
        runtimeInspected: true,
        running: true,
        servicePid: initial.pid,
        offline: false,
        serviceEnv: env,
        serviceUpdateVerdict: verdict,
      };
      mocks.revalidateService.mockResolvedValue(verdict);
      mocks.serviceMaintenance.mockImplementation(
        async (params: {
          phase?: "inspect" | "prepare";
          expectedService?: PreManagedServiceStop;
          assertCurrent?: () => void;
          onStopped?: (state: PreManagedServiceStop) => void;
        }) => {
          if (params.phase === "inspect") {
            return before;
          }
          const stopped = { ...before, stopped: true, stoppedAtMs: Date.now() };
          await withGatewayServiceOperationLock(env, async (assertNative) => {
            const assertCurrent = () => {
              params.assertCurrent?.();
              assertNative();
            };
            await service.stop({
              env,
              stdout,
              assertCurrent,
              onMutation: () => params.onStopped?.(stopped),
            });
            assertCurrent();
          });
          setTimeout(() => {
            delayedOwner?.release();
            delayedOwner = undefined;
          }, 250);
          return stopped;
        },
      );
      mocks.waitForHealthy.mockImplementation(async () => {
        const runtime = await waitForLaunchAgentState(env, "running");
        await waitForProbeStarts(eventsPath, 2);
        return { healthy: true, runtime };
      });
      const logs: string[] = [];
      const maintenance = await beginDoctorMaintenance({
        root: process.cwd(),
        options: { repair: true },
        runtime: {
          log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
          error: () => {},
          exit: () => {},
        },
      });
      if (!maintenance) {
        throw new Error("Doctor maintenance did not acquire the native fixture");
      }
      await operation({ env, eventsPath, maintenance, initialPid: initial.pid, logs });
    });
  } finally {
    delayedOwner?.release();
    closeOpenClawStateDatabaseForTest();
    await uninstallLaunchAgent({ env, stdout });
    await fs.rm(path.join(accountHome, ".Trash", `${resolveLaunchAgentLabel(env)}.plist`), {
      force: true,
    });
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(probeDir, { recursive: true, force: true });
  }
}

describeLaunchdIntegration("Doctor launchd maintenance integration", () => {
  beforeEach(() => {
    mocks.serviceMaintenance.mockReset();
    mocks.revalidateService.mockReset();
    mocks.waitForHealthy.mockReset();
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
  });

  it("waits for delayed lifecycle release and restores the native LaunchAgent", async () => {
    await withNativeDoctorFixture(async ({ env, eventsPath, maintenance, initialPid, logs }) => {
      await waitForLaunchAgentState(env, "stopped");
      const stoppedEvents = await readProbeEvents(eventsPath);
      expect(stoppedEvents.map((event) => event.kind)).toEqual(["start", "SIGTERM"]);

      await maintenance.finish({});

      const restored = await waitForLaunchAgentState(env, "running");
      expect(restored.pid).not.toBe(initialPid);
      const restoredEvents = await waitForProbeStarts(eventsPath, 2);
      expect(restoredEvents.map((event) => event.kind)).toEqual(["start", "SIGTERM", "start"]);
      expect(logs).toContain("Gateway restarted and verified after Doctor repair.");
    });
  }, 60_000);

  it("rejects a copied finisher without native activation before owner cleanup", async () => {
    await withNativeDoctorFixture(async ({ env, eventsPath, maintenance, initialPid }) => {
      await waitForLaunchAgentState(env, "stopped");
      const copied = { ...maintenance };
      try {
        await expect(copied.finish({})).rejects.toThrow("original live maintenance owner");
        await new Promise((resolve) => {
          setTimeout(resolve, 500);
        });
        await waitForLaunchAgentState(env, "stopped");
        expect((await readProbeEvents(eventsPath)).map((event) => event.kind)).toEqual([
          "start",
          "SIGTERM",
        ]);
      } finally {
        await maintenance.finish({});
      }

      const restored = await waitForLaunchAgentState(env, "running");
      expect(restored.pid).not.toBe(initialPid);
      expect((await waitForProbeStarts(eventsPath, 2)).map((event) => event.kind)).toEqual([
        "start",
        "SIGTERM",
        "start",
      ]);
    });
  }, 60_000);
});
