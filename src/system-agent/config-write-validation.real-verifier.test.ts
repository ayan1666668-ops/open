import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { buildMockOpenAiResponsesProvider } from "../gateway/test-openai-responses-model.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { executeSystemAgentOperation } from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

let home: TempHomeEnv | undefined;
let providerServer: ReturnType<typeof createServer> | undefined;

afterEach(async () => {
  const server = providerServer;
  providerServer = undefined;
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
  await home?.restore();
  home = undefined;
});

// The approved write reaches the provider through the production verifier and
// the production config writer; only the provider is a loopback stand-in.
describe("executeSystemAgentOperation with the real inference verifier", () => {
  it.each([
    { name: "commits when the provider answers", providerOk: true, revoked: false },
    {
      name: "leaves the file unchanged when the provider rejects",
      providerOk: false,
      revoked: false,
    },
    { name: "never reaches the provider once authority lapses", providerOk: true, revoked: true },
  ])("$name", { timeout: 60_000 }, async ({ providerOk, revoked }) => {
    home = await createTempHomeEnv("openclaw-config-write-real-");
    const stateDir = path.join(home.home, ".openclaw");
    const workspaceDir = path.join(home.home, "workspace");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_SKIP_PROVIDERS", "1");
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");

    let providerRequests = 0;
    providerServer = createServer((request, response) => {
      if (request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      providerRequests += 1;
      if (!providerOk) {
        response
          .writeHead(401, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: "fixture key rejected" } }));
        return;
      }
      writeOpenAiResponsesText(response, {
        text: "OK",
        messageId: "msg_config_write_proof",
        responseId: "resp_config_write_proof",
      });
    });
    await new Promise<void>((resolve, reject) => {
      providerServer?.once("error", reject);
      providerServer?.listen(0, "127.0.0.1", resolve);
    });
    const address = providerServer.address();
    if (!address || typeof address === "string") {
      throw new Error("proof provider did not bind a loopback port");
    }
    const provider = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${address.port}/v1`);
    const raw = JSON.stringify({
      agents: {
        defaults: {
          workspace: workspaceDir,
          skipBootstrap: true,
          model: { primary: provider.modelRef },
          models: {
            [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
          },
          params: { temperature: 0.2 },
        },
        entries: { main: { default: true } },
      },
      models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
    });
    await fs.writeFile(configPath, raw);
    const { runtime, lines } = createSystemAgentTestRuntime();
    // Authority holds when the commit boundary opens and lapses before the probe.
    let checks = 0;
    const beforePersistentApply = () => {
      checks += 1;
      if (revoked && checks > 1) {
        throw new Error("approving run closed");
      }
    };

    const execute = executeSystemAgentOperation(
      { kind: "config-set", path: "agents.defaults.params.temperature", value: "0.5" },
      runtime,
      { approved: true, beforePersistentApply },
    );
    if (revoked) {
      await expect(execute).rejects.toThrow("operation exited with code 1");
      expect(lines.join("\n")).toContain("approving run closed");
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
      expect(providerRequests).toBe(0);
      return;
    }
    if (providerOk) {
      await expect(execute).resolves.toMatchObject({ applied: true });
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
        agents: { defaults: { params: { temperature: 0.5 } } },
      });
    } else {
      await expect(execute).rejects.toThrow("operation exited with code 1");
      expect(lines.join("\n")).toContain(
        "Config write not applied: the default inference route would stop working",
      );
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    }
    expect(providerRequests).toBeGreaterThan(0);
  });
});
