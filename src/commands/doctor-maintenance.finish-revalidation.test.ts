import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GatewayService } from "../daemon/service.js";
import { createMockGatewayService, mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import {
  createUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
  finishUpdateRun,
} from "../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const mocks = vi.hoisted(() => ({
  resolveService: vi.fn<() => GatewayService>(),
  coordinatorRuntimeDir: "",
}));

vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: (...args: []) => mocks.resolveService(...args),
}));

vi.mock("./doctor-service-repair-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-service-repair-policy.js")>()),
  shouldManageGatewayService: async () => true,
}));

vi.mock("../cli/daemon-cli/restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: vi.fn(async () => ({ healthy: true })),
}));

// Keep coordinator files inside the isolated workspace on every host.
vi.mock("../infra/state-database-coordinator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/state-database-coordinator.js")>();
  const withIsolatedRuntimeDir = <T extends { runtimeDirectory?: string }>(params: T): T => ({
    ...params,
    runtimeDirectory: mocks.coordinatorRuntimeDir || params.runtimeDirectory,
  });
  return {
    ...actual,
    acquireGatewayLifecycleCoordinator: (
      params: Parameters<typeof actual.acquireGatewayLifecycleCoordinator>[0],
    ) => actual.acquireGatewayLifecycleCoordinator(withIsolatedRuntimeDir(params)),
    acquireStateDatabaseCoordinator: (
      params: Parameters<typeof actual.acquireStateDatabaseCoordinator>[0],
    ) => actual.acquireStateDatabaseCoordinator(withIsolatedRuntimeDir(params)),
  };
});

// Windows hosts cannot enforce the mocked Linux mode bits; retain real SQLite locking.
vi.mock("../infra/sqlite-coordinator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-coordinator.js")>();
  const nodeFs = await import("node:fs");
  return {
    ...actual,
    ensurePrivateSqliteCoordinatorDirectory: (directoryPath: string) => {
      nodeFs.mkdirSync(directoryPath, { recursive: true });
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => mockSystemAccountHome());
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type StoppedUnitState = "retained" | "unloaded" | "changed-manager" | "changed-command";
type Continuation =
  | "own"
  | "foreign"
  | "unknown-adopter"
  | "unrecorded"
  | "unrecorded-parked"
  | "parked"
  | "lost-before-stop"
  | "lost-before-restart";

async function runDoctorFinishForStoppedUnit(
  scenario: StoppedUnitState,
  continuation?: Continuation,
): Promise<{
  finishError: unknown;
  restartCalls: number;
  logs: string[];
}> {
  const home = tempDirs.make("openclaw-doctor-finish-");
  mocks.coordinatorRuntimeDir = home;
  return await withEnvAsync(
    {
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData"),
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
      OPENCLAW_SERVICE_MARKER: undefined,
      OPENCLAW_SERVICE_KIND: undefined,
      OPENCLAW_SYSTEMD_UNIT: undefined,
    },
    async () => {
      let runId: string | undefined;
      if (continuation) {
        const driver = readUpdateRunDriver();
        if (!driver) {
          throw new Error("Current driver identity is unavailable");
        }
        const run = createUpdateRun({
          trigger: "cli",
          origin: {
            driver: continuation === "foreign" ? { ...driver, host: "other-host.invalid" } : driver,
          },
        });
        runId = run.runId;
        recordUpdateRunPhase(runId, "validating");
        if (continuation === "unknown-adopter") {
          recordUpdateRunStep(runId, { step: "driver:identity-unavailable", status: "completed" });
        }
        if (continuation !== "unrecorded" && continuation !== "unrecorded-parked") {
          recordUpdateRunStep(runId, { step: "finalize:repair-continuation", status: "completed" });
        }
        vi.stubEnv(
          "OPENCLAW_UPDATE_RUN_ID",
          continuation === "unrecorded-parked" ? undefined : runId,
        );
        vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
        vi.stubEnv("OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION", "0");
      }
      mockProcessPlatform("linux");
      let running = continuation !== "parked" && continuation !== "unrecorded-parked";
      let stopObserved = false;
      let commandReads = 0;
      const command = {
        programArguments: [
          process.execPath,
          path.join(process.cwd(), "openclaw.mjs"),
          "gateway",
          "--port",
          "18789",
        ],
        environment: { HOME: home },
      };
      const restart = vi.fn(async () => {
        running = true;
        return { outcome: "completed" as const };
      });
      mocks.resolveService.mockReturnValue(
        createMockGatewayService({
          isAbsent: async () => false,
          hasInstalledDefinition: async () => true,
          isLoaded: async () => scenario === "retained",
          readCommand: async (_env, opts) => {
            if (continuation === "lost-before-stop" && ++commandReads === 2 && runId) {
              finishUpdateRun(runId, { status: "failed" });
            }
            if (
              stopObserved &&
              scenario === "unloaded" &&
              opts?.requireLoaded &&
              !opts.loadForInspection
            ) {
              throw new Error("Effective systemd service command could not be inspected.");
            }
            opts?.loadForInspection?.assertCurrent();
            return {
              programArguments: [
                ...command.programArguments,
                ...(stopObserved && scenario === "changed-command" ? ["--verbose"] : []),
              ],
              environment: { ...command.environment },
            };
          },
          readRuntime: async (_env, opts) => {
            if (running) {
              return { status: "running", systemd: { managerUid: 2001 } };
            }
            opts?.loadForInspection?.assertCurrent();
            // Plain status omits UID; collected units also need authorized inspection.
            return opts?.requireLoaded &&
              (scenario !== "unloaded" || opts.loadForInspection?.managerUid === 2001)
              ? {
                  status: "stopped",
                  systemd: { managerUid: scenario === "changed-manager" ? 2002 : 2001 },
                }
              : { status: "stopped" };
          },
          stop: vi.fn(async () => {
            running = false;
            stopObserved = true;
          }),
          restart,
        }),
      );
      const logs: string[] = [];
      const maintenance = await beginDoctorMaintenance({
        root: process.cwd(),
        options: { repair: true },
        runtime: {
          log: (...args: Array<unknown>) => {
            logs.push(args.map((entry) => String(entry)).join(" "));
          },
          error: () => {},
          exit: () => {},
        },
      });
      expect(maintenance).toBeDefined();
      if (continuation === "lost-before-restart" && runId) {
        finishUpdateRun(runId, { status: "failed" });
      }
      let finishError: unknown;
      try {
        await maintenance?.finish({});
      } catch (error) {
        finishError = error;
      }
      return {
        finishError,
        restartCalls: restart.mock.calls.length,
        logs,
      };
    },
  );
}

it.each(["own", "parked", "unrecorded-parked"] as const)(
  "continues owning-run Doctor maintenance with service %s",
  async (continuation) => {
    const { finishError, restartCalls, logs } = await runDoctorFinishForStoppedUnit(
      "retained",
      continuation,
    );
    expect(finishError).toBeUndefined();
    expect(restartCalls).toBe(continuation === "own" ? 1 : 0);
    if (continuation === "own") {
      expect(logs).toContain("Stopped the managed Gateway for Doctor repair.");
      expect(logs).toContain("Gateway restarted and verified after Doctor repair.");
    }
  },
);

it.each(["foreign", "unrecorded", "unknown-adopter"] as const)(
  "preserves parent activation without an owning repair continuation (%s)",
  async (continuation) => {
    await expect(runDoctorFinishForStoppedUnit("retained", continuation)).rejects.toThrow(
      continuation === "foreign"
        ? "other-host.invalid"
        : continuation === "unknown-adopter"
          ? "unrecorded adopter"
          : "update parent owns Gateway activation",
    );
  },
);

it("rechecks continuation before stopping the service", async () => {
  await expect(runDoctorFinishForStoppedUnit("retained", "lost-before-stop")).rejects.toThrow(
    "no longer owns this repair continuation",
  );
});

it("rechecks continuation before restoring the service", async () => {
  const { finishError, restartCalls } = await runDoctorFinishForStoppedUnit(
    "retained",
    "lost-before-restart",
  );
  expect(finishError).toMatchObject({
    message: expect.stringContaining("no longer owns this repair continuation"),
  });
  expect(restartCalls).toBe(0);
});

it.each(["retained", "unloaded"] as const)(
  "restarts and verifies the unchanged gateway after systemd leaves it %s",
  async (scenario) => {
    const { finishError, restartCalls, logs } = await runDoctorFinishForStoppedUnit(scenario);
    expect(finishError).toBeUndefined();
    expect(restartCalls).toBe(1);
    expect(logs.join("\n")).toContain("Gateway restarted and verified after Doctor repair.");
  },
);

it.each(["changed-manager", "changed-command"] as const)(
  "refuses activation after %s during repair",
  async (scenario) => {
    const { finishError, restartCalls } = await runDoctorFinishForStoppedUnit(scenario);
    expect(finishError).toMatchObject({
      message: expect.stringMatching(/ownership or manager identity changed/),
    });
    expect(restartCalls).toBe(0);
  },
);
