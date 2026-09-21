import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { READ_SCOPE } from "../gateway/operator-scopes.js";

const mocks = vi.hoisted(() => ({
  readActiveGatewayLockIdentity: vi.fn(),
  callGateway: vi.fn(),
}));

vi.mock("../infra/gateway-lock.js", () => ({
  readActiveGatewayLockIdentity: mocks.readActiveGatewayLockIdentity,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

const { gatewayRuntimeForPlugin, readPluginsInspectGatewayRuntime, reportedPluginGatewayStatus } =
  await import("./plugins-inspect-gateway-runtime.js");

const config: OpenClawConfig = {};

beforeEach(() => {
  mocks.readActiveGatewayLockIdentity.mockReset();
  mocks.callGateway.mockReset();
});

it("does not invent a loaded Gateway when no daemon is running", async () => {
  mocks.readActiveGatewayLockIdentity.mockResolvedValue(undefined);

  const report = await readPluginsInspectGatewayRuntime(config);
  const runtime = gatewayRuntimeForPlugin(report, "hook-only");

  expect(mocks.callGateway).not.toHaveBeenCalled();
  expect(runtime).toMatchObject({
    source: "gateway",
    reachable: false,
    state: "unreachable",
  });
  expect(reportedPluginGatewayStatus(runtime)).toBe("unreachable");
  expect(runtime.reachable ? "" : runtime.detail).toContain("No running Gateway");
  expect(runtime.state).not.toBe("active");
});

it("reports an unreadable Gateway lock without querying it", async () => {
  mocks.readActiveGatewayLockIdentity.mockRejectedValue(new Error("lock unreadable"));

  const runtime = gatewayRuntimeForPlugin(
    await readPluginsInspectGatewayRuntime(config),
    "hook-only",
  );

  expect(mocks.callGateway).not.toHaveBeenCalled();
  expect(runtime).toMatchObject({ reachable: false, state: "unreachable" });
  expect(runtime.reachable ? "" : runtime.detail).toContain("lock could not be read");
});

it("reads plugins.list from the local Gateway and keeps unloaded distinct from loaded", async () => {
  mocks.readActiveGatewayLockIdentity.mockResolvedValue({
    pid: 42,
    createdAt: "2026-09-22T00:00:00.000Z",
    port: 18789,
  });
  mocks.callGateway.mockResolvedValue({
    generation: 7,
    plugins: [
      { id: "hook-only", runtime: { state: "unloaded" } },
      { id: "Disabled", runtime: { state: "disabled" } },
      { id: "live", runtime: { state: "active" } },
      {
        id: "broken",
        runtime: { state: "service-failed", error: "svc: boom" },
      },
      { id: "opaque", runtime: { state: "loaded" } },
    ],
  });

  const report = await readPluginsInspectGatewayRuntime(config);

  expect(mocks.callGateway).toHaveBeenCalledTimes(1);
  expect(mocks.callGateway).toHaveBeenCalledWith(
    expect.objectContaining({
      config,
      method: "plugins.list",
      params: {},
      localPortOverride: 18789,
      ignoreEnvUrlOverride: true,
      timeoutMs: 30_000,
      scopes: [READ_SCOPE],
      requiredMethods: ["plugins.list"],
      sharedStateMode: "read-only",
    }),
  );
  expect(gatewayRuntimeForPlugin(report, "hook-only")).toMatchObject({
    reachable: true,
    state: "unloaded",
    generation: 7,
    detail: "The running Gateway has not loaded this plugin.",
  });
  expect(reportedPluginGatewayStatus(gatewayRuntimeForPlugin(report, "hook-only"))).toBe(
    "unloaded",
  );
  expect(reportedPluginGatewayStatus(gatewayRuntimeForPlugin(report, "live"))).toBe("loaded");
  expect(reportedPluginGatewayStatus(gatewayRuntimeForPlugin(report, "missing"))).toBe(
    "not-loaded",
  );
  expect(reportedPluginGatewayStatus(gatewayRuntimeForPlugin(report, "opaque"))).toBe("unknown");
  expect(gatewayRuntimeForPlugin(report, "disabled")).toMatchObject({
    reachable: true,
    state: "disabled",
  });
  expect(gatewayRuntimeForPlugin(report, "live")).toMatchObject({
    reachable: true,
    state: "active",
  });
  expect(gatewayRuntimeForPlugin(report, "broken")).toMatchObject({
    reachable: true,
    state: "service-failed",
    error: "svc: boom",
  });
  expect(gatewayRuntimeForPlugin(report, "opaque")).toMatchObject({
    reachable: true,
    state: "unreported",
  });
  expect(gatewayRuntimeForPlugin(report, "missing")).toMatchObject({
    reachable: true,
    state: "absent",
  });
});

it("says the Gateway is unreachable when plugins.list fails", async () => {
  mocks.readActiveGatewayLockIdentity.mockResolvedValue({
    pid: 42,
    createdAt: "2026-09-22T00:00:00.000Z",
    port: 18789,
  });
  mocks.callGateway.mockRejectedValue(new Error("connect ECONNREFUSED"));

  const runtime = gatewayRuntimeForPlugin(
    await readPluginsInspectGatewayRuntime(config),
    "hook-only",
  );

  expect(runtime).toMatchObject({ reachable: false, state: "unreachable" });
  expect(runtime.reachable ? "" : runtime.detail).toContain(
    "Gateway unreachable. Plugin runtime state was not read from the daemon.",
  );
  expect(runtime.reachable ? "" : runtime.detail).toContain("ECONNREFUSED");
});

it("does not treat a catalog-less payload as unloaded plugins", async () => {
  mocks.readActiveGatewayLockIdentity.mockResolvedValue({
    pid: 42,
    createdAt: "2026-09-22T00:00:00.000Z",
    port: 18789,
  });
  mocks.callGateway.mockResolvedValue({ ok: true });

  const runtime = gatewayRuntimeForPlugin(
    await readPluginsInspectGatewayRuntime(config),
    "hook-only",
  );

  expect(runtime).toMatchObject({ reachable: false, state: "unreachable" });
  expect(runtime.reachable ? "" : runtime.detail).toContain("did not include a runtime catalog");
});
