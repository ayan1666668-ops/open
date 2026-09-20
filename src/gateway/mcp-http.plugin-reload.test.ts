import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const healthyResult = {
  content: [{ type: "text", text: "healthy plugin completed" }],
  isError: false,
};

it("keeps initialization and healthy tools available after its creator's plugin generation retires", async ({
  signal,
}) => {
  const root = tempDirs.make("openclaw-mcp-plugin-reload-");
  const bundledDir = path.join(root, "bundled");
  const workspaceDir = path.join(root, "workspace");
  const config: OpenClawConfig = {
    agents: { defaults: { workspace: workspaceDir } },
    plugins: {
      allow: ["canvas", "healthy"],
      entries: { canvas: { enabled: true }, healthy: { enabled: true } },
    },
    tools: { allow: ["message", "healthy_probe"] },
  };
  const instances: Array<NonNullable<ReturnType<typeof getPluginInstance>>> = [];

  const loadGeneration = () =>
    withPluginCache(createPluginCache(), () => {
      const metadataSnapshot = resolvePluginMetadataSnapshot({ config, workspaceDir });
      const pluginRegistry = loadPluginRegistryHandle({
        config,
        workspaceDir,
        manifestRegistry: metadataSnapshot.manifestRegistry,
        onlyPluginIds: ["canvas", "healthy"],
      });
      for (const record of pluginRegistry.plugins) {
        const instance = getPluginInstance(record);
        if (instance) {
          instances.push(instance);
        }
      }
      const canvas = pluginRegistry.plugins.find((record) => record.id === "canvas");
      const canvasInstance = canvas && getPluginInstance(canvas);
      if (!canvasInstance) {
        throw new Error(
          `Canvas fixture did not load: ${JSON.stringify(pluginRegistry.diagnostics)}`,
        );
      }
      return { pluginRegistry, metadataSnapshot, canvasInstance };
    });

  const request = async (phase: string, method: "initialize" | "tools/list" | "tools/call") => {
    const runtime = getActiveMcpLoopbackRuntime();
    if (!runtime) {
      throw new Error("MCP loopback runtime missing");
    }
    const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
      method: "POST",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      headers: {
        authorization: `Bearer ${runtime.ownerToken}`,
        "content-type": "application/json",
        "x-session-key": `agent:main:${phase}`,
        connection: "close",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: phase,
        method,
        ...(method === "initialize"
          ? {
              params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "plugin-reload-test", version: "1" },
              },
            }
          : method === "tools/call"
            ? { params: { name: "healthy_probe", arguments: {} } }
            : {}),
      }),
    });
    const payload: unknown = await response.json();
    expect(response.status, `${phase}: ${JSON.stringify(payload)}`).toBe(200);
    return payload;
  };

  const expectHealthyTools = async (phase: string) => {
    expect(await request(phase, "tools/list")).toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "message" }),
          expect.objectContaining({ name: "healthy_probe" }),
        ]),
      },
    });
    expect(await request(`${phase}-call`, "tools/call")).toMatchObject({ result: healthyResult });
  };

  await runQaGatewayFixture(
    async () => {
      vi.stubEnv("OPENCLAW_HOME", root);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
      for (const id of ["canvas", "healthy"]) {
        const pluginRoot = path.join(bundledDir, id);
        writeJsonFile(path.join(pluginRoot, "package.json"), {
          name: `@openclaw/${id}`,
          version: "1.0.0",
          type: "commonjs",
          main: "index.cjs",
          openclaw: { extensions: ["./index.cjs"] },
        });
        writeJsonFile(path.join(pluginRoot, "openclaw.plugin.json"), {
          id,
          configSchema: { type: "object", additionalProperties: false },
          ...(id === "healthy" ? { contracts: { tools: ["healthy_probe"] } } : {}),
        });
        fs.writeFileSync(
          path.join(pluginRoot, "index.cjs"),
          id === "canvas"
            ? `module.exports = { id: "canvas", register(api) {
                api.registerWidgetPresenter({
                  target: "node_panel",
                  description: "Show on a connected device panel",
                  availability: async () => ({ ok: true, value: { available: true } }),
                  present: async () => ({ ok: false, error: { code: "no_eligible_node", message: "No fixture node" } })
                });
              } };`
            : `module.exports = { id: "healthy", register(api) {
                api.registerTool({
                  name: "healthy_probe", label: "Healthy probe", description: "Return a local sentinel",
                  parameters: { type: "object", properties: {} },
                  execute: async () => ({ content: ${JSON.stringify(healthyResult.content)}, details: {} })
                });
              } };`,
        );
      }
      setRuntimeConfigSnapshot(config);
      const before = loadGeneration();
      const after = loadGeneration();
      setActivePluginRegistry(before.pluginRegistry);
      await withPluginRuntimeGenerationScope(before, () => ensureMcpLoopbackServer());
      await expectHealthyTools("before-reload");

      // Tool assembly also resolves Canvas presenters before invoking individual tool factories.
      const oldPresenter = before.pluginRegistry.widgetPresenters[0]!.presenter;
      setActivePluginRegistry(after.pluginRegistry);
      await before.canvasInstance.dispose();
      expect(() => oldPresenter.availability({})).toThrow("Plugin canvas was reloaded or disabled");
      setRuntimeConfigSnapshot({ ...config, logging: { level: "warn" } });

      expect(await request("after-reload", "initialize")).toMatchObject({
        result: { protocolVersion: "2024-11-05", serverInfo: { name: "openclaw" } },
      });
      await expectHealthyTools("after-reload");
      await closeMcpLoopbackServer();
      await withPluginRuntimeGenerationScope(after, () => ensureMcpLoopbackServer());
      await expectHealthyTools("restarted");
    },
    () => closeMcpLoopbackServer(),
    () => Promise.all(instances.map((instance) => instance.dispose())),
    () => resetPluginRuntimeStateForTest(),
    () => clearRuntimeConfigSnapshot(),
    () => vi.unstubAllEnvs(),
  );
});
