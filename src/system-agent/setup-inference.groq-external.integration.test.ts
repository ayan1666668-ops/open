import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { afterEach, expect, it } from "vitest";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../plugins/installed-plugin-index-records.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { waitForPluginCacheRetirement } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { activateSetupInference } from "./setup-inference-activate.js";

afterEach(async () => {
  configureAiTransportHost({});
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  await waitForPluginCacheRetirement();
});

it("resolves a Groq manifest model from a global external install during setup", async () => {
  await withOpenClawTestState(
    {
      label: "groq-external-setup",
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_DEV_SOURCE_ROOT: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
      },
    },
    async (state) => {
      const pluginDir = state.statePath("extensions", "groq");
      await fs.cp(path.join(process.cwd(), "extensions", "groq"), pluginDir, { recursive: true });
      const config = { plugins: { entries: { groq: { enabled: true } } } };
      await state.writeConfig(config);
      await writePersistedInstalledPluginIndexInstallRecords(
        {
          groq: {
            source: "path",
            sourcePath: pluginDir,
            installPath: pluginDir,
          },
        },
        { config, env: state.env },
      );
      clearLoadInstalledPluginIndexInstallRecordsCache();

      const requests: Array<{ method?: string; url?: string }> = [];
      const runtimeErrors: string[] = [];
      const server = http.createServer((request, response) => {
        requests.push({ method: request.method, url: request.url });
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        const chunk = {
          id: "chatcmpl-groq-catalog-test",
          object: "chat.completion.chunk",
          created: 0,
          model: "openai/gpt-oss-120b",
          choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
        };
        const stop = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
        response.end(
          `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(stop)}\n\ndata: [DONE]\n\n`,
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("loopback server has no TCP port");
      }

      const realFetch = globalThis.fetch;
      const originalHost = getAiTransportHost();
      configureAiTransportHost({
        ...originalHost,
        buildModelFetch: () => async (input, init) => {
          const original = new Request(input, init);
          const url = new URL(original.url);
          expect(url.hostname).toBe("api.groq.com");
          const replacement = new URL(original.url);
          replacement.protocol = "http:";
          replacement.hostname = "127.0.0.1";
          replacement.port = String(address.port);
          return await realFetch(new Request(replacement, original));
        },
      });

      try {
        const result = await activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "test-placeholder",
          modelRef: "groq/openai/gpt-oss-120b",
          workspace: state.workspaceDir,
          surface: "gateway",
          runtime: {
            log: () => {},
            error: (message) => {
              runtimeErrors.push(message);
            },
            exit: (code) => {
              throw new Error(`exit ${code}`);
            },
          },
        });

        expect(result, JSON.stringify({ result, runtimeErrors, requests })).toMatchObject({
          ok: true,
          modelRef: "groq/openai/gpt-oss-120b",
        });
        expect(requests).toEqual([{ method: "POST", url: "/openai/v1/chat/completions" }]);
      } finally {
        configureAiTransportHost(originalHost);
        server.close();
        await once(server, "close");
      }
    },
  );
});
