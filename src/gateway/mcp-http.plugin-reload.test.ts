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
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getPluginInstance, type PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("serves tools from the replacement generation after the listener creator retires", async ({
  signal,
}) => {
  const root = tempDirs.make("mcp-plugin-generation-");
  const bundledDir = path.join(root, "bundled");
  const pluginDir = path.join(bundledDir, "generation-probe");
  const workspaceDir = path.join(root, "workspace");
  const observationsPath = path.join(root, "tool-completions.jsonl");
  const config: OpenClawConfig = {
    agents: { defaults: { workspace: workspaceDir } },
    plugins: { allow: ["generation-probe"], entries: { "generation-probe": { enabled: true } } },
    tools: { allow: ["generation_probe"] },
  };
  const instances: PluginInstanceHandle[] = [];
  const loadGeneration = () =>
    withPluginCache(createPluginCache(), () => {
      const metadataSnapshot = resolvePluginMetadataSnapshot({ config, workspaceDir });
      const pluginRegistry = loadPluginRegistryHandle({
        config,
        workspaceDir,
        manifestRegistry: metadataSnapshot.manifestRegistry,
        onlyPluginIds: ["generation-probe"],
      });
      const record = pluginRegistry.plugins.find((plugin) => plugin.id === "generation-probe");
      const instance = record && getPluginInstance(record);
      if (!instance) {
        throw new Error(
          `Generation fixture failed to load: ${JSON.stringify(pluginRegistry.diagnostics)}`,
        );
      }
      instances.push(instance);
      return { pluginRegistry, metadataSnapshot, instance };
    });
  const callTool = async (phase: string) => {
    const runtime = getActiveMcpLoopbackRuntime();
    if (!runtime) {
      throw new Error("MCP listener did not start");
    }
    const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${runtime.ownerToken}`,
        "content-type": "application/json",
        "x-session-key": `agent:main:generation-${phase}`,
        connection: "close",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: phase,
        method: "tools/call",
        params: { name: "generation_probe", arguments: {} },
      }),
    });
    const payload: unknown = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload).toMatchObject({
      result: { content: [{ type: "text", text: "generation tool available" }], isError: false },
    });
  };

  await runQaGatewayFixture(
    async () => {
      vi.stubEnv("OPENCLAW_HOME", root);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
      writeJsonFile(path.join(pluginDir, "package.json"), {
        name: "@openclaw/generation-probe",
        version: "1.0.0",
        type: "commonjs",
        main: "index.cjs",
        openclaw: { extensions: ["./index.cjs"] },
      });
      writeJsonFile(path.join(pluginDir, "openclaw.plugin.json"), {
        id: "generation-probe",
        configSchema: { type: "object", additionalProperties: false },
        contracts: { tools: ["generation_probe"] },
      });
      fs.writeFileSync(
        path.join(pluginDir, "index.cjs"),
        `module.exports = { id: "generation-probe", register(api) {
      const fs = require("node:fs");
      api.on("after_tool_call", (event, ctx) => {
        fs.appendFileSync(${JSON.stringify(observationsPath)}, JSON.stringify({
          toolName: event.toolName, sessionKey: ctx.sessionKey, result: event.result
        }) + "\\n");
        throw new Error("observer failure must not change the HTTP result");
      }, { matcher: ["generation_probe"] });
      api.registerWidgetPresenter({
        target: "node_panel", description: "Synthetic generation presenter",
        availability: async () => ({ ok: true, value: { available: true } }),
        present: async () => ({ ok: false, error: { code: "no_eligible_node", message: "No test node" } })
      });
      api.registerTool({
        name: "generation_probe", label: "Generation probe", description: "Return a generation-owned answer",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "generation tool available" }], details: {} })
      });
    } };`,
      );
      setRuntimeConfigSnapshot(config);
      const original = loadGeneration();
      setActivePluginRegistry(original.pluginRegistry);
      initializeGlobalHookRunner(original.pluginRegistry);
      await withPluginRuntimeGenerationScope(original, () => ensureMcpLoopbackServer());
      await callTool("before");

      const replacement = loadGeneration();
      setActivePluginRegistry(replacement.pluginRegistry);
      initializeGlobalHookRunner(replacement.pluginRegistry);
      await original.instance.dispose();
      await callTool("after");
      await vi.waitFor(() =>
        expect(
          fs
            .readFileSync(observationsPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual(
          ["before", "after"].map((phase) => ({
            toolName: "generation_probe",
            sessionKey: `agent:main:generation-${phase}`,
            result: { content: [{ type: "text", text: "generation tool available" }], details: {} },
          })),
        ),
      );
    },
    () => closeMcpLoopbackServer(),
    () => Promise.all(instances.map((instance) => instance.dispose())),
    () => resetPluginRuntimeStateForTest(),
    () => resetGlobalHookRunner(),
    () => clearRuntimeConfigSnapshot(),
    () => vi.unstubAllEnvs(),
  );
});
