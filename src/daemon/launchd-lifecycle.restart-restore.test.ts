// LaunchAgent restart restore tests cover kickstart after bootout with empty stderr.
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecResult } from "./exec-file.js";
import { restartLaunchAgent } from "./launchd-lifecycle.js";

const state = vi.hoisted(() => ({
  launchctlCalls: [] as string[][],
  serviceLoaded: false,
  kickstartFailuresRemaining: 0,
  kickstartError: "",
  kickstartCode: 1,
}));

function executeLaunchctlMock(file: string, args: string[]): ExecResult {
  const call = file === "launchctl" ? args : args[0] === "launchctl" ? args.slice(1) : args;
  state.launchctlCalls.push(call);
  if (call[0] === "print") {
    if (!state.serviceLoaded) {
      return {
        termination: "exit",
        stdout: "",
        stderr: "Could not find service",
        code: 113,
      };
    }
    return {
      termination: "exit",
      stdout: ["state = waiting", "pid = 0"].join("\n"),
      stderr: "",
      code: 0,
    };
  }
  if (call[0] === "enable") {
    return { termination: "exit", stdout: "", stderr: "", code: 0 };
  }
  if (call[0] === "bootstrap") {
    state.serviceLoaded = true;
    return { termination: "exit", stdout: "", stderr: "", code: 0 };
  }
  if (call[0] === "kickstart") {
    if (state.kickstartFailuresRemaining > 0) {
      state.kickstartFailuresRemaining -= 1;
      return {
        termination: "exit",
        stdout: "",
        stderr: state.kickstartError,
        code: state.kickstartCode,
      };
    }
    state.serviceLoaded = true;
    return { termination: "exit", stdout: "", stderr: "", code: 0 };
  }
  return { termination: "exit", stdout: "", stderr: "", code: 0 };
}

vi.mock("./exec-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exec-file.js")>();
  return {
    execFileUtf8: vi.fn(async (...args: Parameters<typeof actual.execFileUtf8>) =>
      executeLaunchctlMock(args[0], args[1]),
    ),
  };
});

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawnSync: ((file: string, args: string[] = []) => {
        const result = executeLaunchctlMock(file, args);
        return { ...result, status: result.code, error: undefined };
      }) as unknown as typeof import("node:child_process").spawnSync,
    },
  );
});

vi.mock("./launchd-restart-handoff.js", () => ({
  scheduleDetachedLaunchdRestartHandoff: () => ({ ok: true, value: Promise.resolve(true) }),
  scheduleDetachedLaunchdMaintenancePark: () => ({ ok: true, value: Promise.resolve(true) }),
}));

vi.mock("./launchd-system.js", () => ({
  assertNoSystemLaunchDaemonOwnership: async () => {},
  inspectSystemLaunchDaemonOwnership: async (label: string) => ({
    status: "absent" as const,
    serviceTarget: `system/${label}`,
  }),
  isSystemLaunchDaemonOwnershipError: () => false,
}));

vi.mock("../infra/restart-stale-pids.js", () => ({
  getSelfAndAncestorPidsSync: () => new Set<number>(),
  cleanStaleGatewayProcessesSync: () => [],
}));

vi.mock("../infra/ports-inspect.js", () => ({
  inspectPortUsage: async () => ({ port: 18789, status: "free", listeners: [], hints: [] }),
}));

vi.mock("../infra/ports-probe.js", () => ({
  LOOPBACK_PORT_PROBE_HOSTS: ["127.0.0.1"],
  probePortUsage: async () => "free",
}));

vi.mock("./gateway-service-probe-hosts.js", () => ({
  resolveGatewayServiceProbeHosts: async () => ["127.0.0.1"],
}));

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  state.launchctlCalls.length = 0;
  state.serviceLoaded = false;
  state.kickstartFailuresRemaining = 0;
  state.kickstartError = "";
  state.kickstartCode = 1;
});

describe("LaunchAgent restart restore after bootout", () => {
  it("bootstraps after empty kickstart stderr when the LaunchAgent was booted out", async () => {
    const env = { HOME: "/Users/test", OPENCLAW_PROFILE: "default" };
    state.kickstartFailuresRemaining = 1;
    state.kickstartError = "";
    state.kickstartCode = 1;

    const result = await restartLaunchAgent({
      env,
      stdout: new PassThrough(),
      preserveDefinition: true,
    });

    expect(result).toEqual({ outcome: "completed" });
    expect(state.launchctlCalls.map((call) => call[0])).toEqual([
      "print",
      "enable",
      "kickstart",
      "print",
      "enable",
      "bootstrap",
      "kickstart",
    ]);
    expect(state.serviceLoaded).toBe(true);
    expect(state.kickstartFailuresRemaining).toBe(0);
  });

  it("completes restart after bootstrapping an I/O kickstart failure that left the job unloaded", async () => {
    const env = { HOME: "/Users/test", OPENCLAW_PROFILE: "default" };
    state.kickstartFailuresRemaining = 1;
    state.kickstartError = "Input/output error";
    state.kickstartCode = 1;

    await expect(
      restartLaunchAgent({
        env,
        stdout: new PassThrough(),
      }),
    ).resolves.toEqual({ outcome: "completed" });

    expect(state.launchctlCalls.map((call) => call[0])).toContain("bootstrap");
    expect(state.launchctlCalls.map((call) => call[0])).not.toContain("bootout");
    expect(state.serviceLoaded).toBe(true);
  });
});
