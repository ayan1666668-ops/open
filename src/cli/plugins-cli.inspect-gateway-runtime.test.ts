import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState } from "../config/config.js";
import * as gatewayCall from "../gateway/call.js";
import * as gatewayLock from "../infra/gateway-lock.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { defaultRuntime } from "../runtime.js";
import { registerPluginsCli } from "./plugins-cli.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const pluginId = "inspect-gateway-runtime";

afterEach(() => {
  resetConfigRuntimeState();
  clearPluginMetadataLifecycleCaches();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function createLoadedFixture() {
  const root = tempDirs.make("openclaw-cli-inspect-gateway-");
  const pluginRoot = path.join(root, "plugin");
  const bundledRoot = path.join(root, "bundled");
  fs.mkdirSync(pluginRoot);
  fs.mkdirSync(bundledRoot);
  const fixture = createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId,
    manifest: { providers: [], channels: [] },
  });
  fs.writeFileSync(
    fixture.runtimeSource,
    `module.exports = { register(api) {
      api.on("before_tool_call", () => undefined, { priority: 90 });
      api.on("after_tool_call", () => undefined);
    } };`,
  );
  const configPath = path.join(root, "openclaw.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      plugins: {
        load: { paths: [pluginRoot] },
        entries: { [pluginId]: { enabled: true } },
      },
    }),
  );
  vi.stubEnv("OPENCLAW_HOME", root);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledRoot);
  resetConfigRuntimeState();
}

async function runInspect(args: string[]): Promise<{ json?: unknown; text: string }> {
  let stdout = "";
  const logs: string[] = [];
  vi.spyOn(defaultRuntime, "writeStdout").mockImplementation((text) => {
    stdout += text;
  });
  vi.spyOn(defaultRuntime, "log").mockImplementation((text) => {
    logs.push(String(text));
  });
  const program = new Command();
  registerPluginsCli(program);
  await program.parseAsync(["node", "openclaw", "plugins", "inspect", pluginId, ...args]);
  const text = stripVTControlCharacters(logs.join("\n"));
  const json: unknown = args.includes("--json") ? JSON.parse(stdout) : undefined;
  return { text, ...(json === undefined ? {} : { json }) };
}

function hookNames(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.typedHooks)) {
    return [];
  }
  return value.typedHooks.flatMap((hook) =>
    isRecord(hook) && typeof hook.name === "string" ? [hook.name] : [],
  );
}

it("labels a CLI module load when the Gateway reports the plugin unloaded", async () => {
  createLoadedFixture();
  vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockResolvedValue({
    pid: 42,
    createdAt: "2026-09-22T00:00:00.000Z",
    port: 18789,
  });
  const callGateway = vi.spyOn(gatewayCall, "callGateway").mockResolvedValue({
    generation: 3,
    plugins: [{ id: pluginId, runtime: { state: "unloaded" } }],
  });

  const { json } = await runInspect(["--runtime", "--json"]);

  expect(callGateway).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "plugins.list",
      localPortOverride: 18789,
      ignoreEnvUrlOverride: true,
    }),
  );
  expect(json).toMatchObject({
    inspectionScope: "cli-process",
    reportedStatus: "unloaded",
    gatewayRuntime: {
      source: "gateway",
      reachable: true,
      state: "unloaded",
      generation: 3,
    },
    plugin: {
      id: pluginId,
      status: "loaded",
      statusScope: "cli-process",
      activated: true,
      activationScope: "cli-process",
    },
  });
  expect(hookNames(json).toSorted()).toEqual(["after_tool_call", "before_tool_call"]);
  expect(JSON.stringify(json)).toContain("not the running Gateway");
  const human = await runInspect(["--runtime"]);
  expect(human.text).toContain("Gateway runtime:");
  expect(human.text).toContain("unloaded");
  expect(human.text).toContain("The running Gateway has not loaded this plugin.");
  expect(human.text).toMatch(/^Status: unloaded$/m);
  expect(human.text).toContain("loaded in this CLI process (not the Gateway)");
});
