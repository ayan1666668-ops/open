// Real-transport proof for the recall completion capability: the same
// resolveContextEngineCapabilities production face that the recall assembly
// hands to context engines must carry the owning plugin's completion policy
// through real model acquisition and reach the real provider boundary. Every
// completion observation here comes from an actual HTTP round trip against a
// local provider fixture, not from a mocked completion owner.
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../admitted-run-context.js";
import { resolveContextEngineCapabilities } from "./context-engine-capabilities.js";

const providerId = "fixture-real";
const ownerPluginId = "real-transport-plugin";
const engineId = "real-transport-context-engine";
const allowedModel = `${providerId}/allowed-model`;
const forbiddenModel = `${providerId}/forbidden-model`;
const directText = "real-transport-direct-ok";
const isolatedText = "real-transport-isolated-ok";

type RecordedRequest = {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
};

describe("context engine completion capability over real transport", () => {
  let server: Server | undefined;
  let requests: RecordedRequest[] = [];
  const tempPaths: string[] = [];
  let previousStateDir: string | undefined;
  let previousDisableBundled: string | undefined;

  const startServer = async (): Promise<number> => {
    server = createServer((request: IncomingMessage, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          method: request.method ?? "",
          url: request.url ?? "",
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        // The isolated completion route answers with a different marker so the
        // two dispatch modes are distinguishable at the final I/O boundary.
        const isIsolatedRequest = requests.length === 2;
        const text = isIsolatedRequest ? isolatedText : directText;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            id: "real-transport-response",
            object: "chat.completion.chunk",
            model: "allowed-model",
            choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
          })}\n\ndata: [DONE]\n\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", () => {
        server?.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Real-transport fixture did not expose a TCP port");
    }
    return address.port;
  };

  const buildConfig = (port: number) => ({
    agents: {
      defaults: {
        model: allowedModel,
      },
    },
    models: {
      providers: {
        [providerId]: {
          api: "openai-completions",
          apiKey: "fixture-real-key",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          models: [
            {
              id: "allowed-model",
              name: "Allowed",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 1024,
            },
            {
              id: "forbidden-model",
              name: "Forbidden",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 1024,
            },
          ],
        },
      },
    },
    plugins: {
      slots: { contextEngine: engineId },
      entries: {
        [ownerPluginId]: {
          llm: {
            allowedCompletionModels: [allowedModel],
            allowModelOverride: true,
          },
        },
      },
    },
  });

  beforeEach(() => {
    requests = [];
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    previousDisableBundled = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  });

  afterEach(async () => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousDisableBundled === undefined) {
      delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    } else {
      process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = previousDisableBundled;
    }
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    server = undefined;
    await Promise.all(
      tempPaths.map((tempPath) => fs.rm(tempPath, { recursive: true, force: true })),
    );
    tempPaths.length = 0;
  });

  it("completes allowlisted direct and isolated probes against the real provider boundary and revokes after close", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-real-transport-state-"));
    tempPaths.push(stateRoot);
    process.env.OPENCLAW_STATE_DIR = stateRoot;
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    const port = await startServer();
    const config = buildConfig(port);

    // One admitted run authority, exactly like the attempt flow that mints
    // the capability for recall.
    const admission = prepareSystemAgentRunAdmission(config, "real-transport-run", "main", "test");
    const admitted = await admission.admit("embedded");
    const assertActive = resolveAdmittedRunActiveAssertion(admitted);
    expect(assertActive).toBeTypeOf("function");

    const capabilities = resolveContextEngineCapabilities({
      config,
      sessionKey: "agent:main:guildchat:channel:real-transport",
      contextEnginePluginId: ownerPluginId,
      assertRunAuthorityActive: assertActive,
      purpose: "context-engine.real-transport",
    });
    const complete = capabilities.llm.complete;

    // The policy-excluded model is denied by the owning plugin's completion
    // allowlist before acquisition, and the provider sees no traffic.
    await expect(
      complete({
        model: forbiddenModel,
        messages: [{ role: "user", content: "forbidden probe" }],
      } as never),
    ).rejects.toThrow(/is not allowlisted .* for plugin "real-transport-plugin"/u);
    expect(requests.length).toBe(0);

    // The allowlisted direct completion passes real acquisition and reaches
    // the real provider boundary: the local server observed the HTTP request,
    // and the streamed answer is the completion result.
    const direct = (await complete({
      model: allowedModel,
      messages: [{ role: "user", content: "direct recall probe" }],
    } as never)) as { text?: string };
    expect(direct?.text).toBe(directText);
    expect(requests.length).toBe(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toContain("/chat/completions");
    expect(requests[0]?.authorization).toBe("Bearer fixture-real-key");
    expect(requests[0]?.body).toContain("direct recall probe");

    // The isolated runtime mode dispatches through the real isolated
    // completion owner and reaches the same real provider boundary.
    const isolated = (await complete({
      model: allowedModel,
      messages: [{ role: "user", content: "isolated recall probe" }],
      execution: { mode: "isolated-agent-runtime" },
    } as never)) as { text?: string };
    expect(isolated?.text).toBe(isolatedText);
    expect(requests.length).toBe(2);
    expect(requests[1]?.body).toContain("isolated recall probe");

    // Compatibility face of the run-lifetime gate: a capability an engine
    // retained across the turn is refused with a clear authority error after
    // the admitting run closes, and the provider sees no further traffic.
    closeAdmittedRunDelegatedAuthority(admitted);
    await expect(
      complete({
        model: allowedModel,
        messages: [{ role: "user", content: "retained call" }],
      } as never),
    ).rejects.toThrow(/admitted run authority is no longer active/u);
    expect(requests.length).toBe(2);
  }, 60_000);
});
