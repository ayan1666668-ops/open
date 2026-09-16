import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactSensitiveText } from "../logging/redact.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import {
  closeProviderTransportDispatcherPool,
  getProviderTransportDispatcherPool,
} from "./provider-transport-dispatcher-pool.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";

describe("guarded model fetch integration", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeProviderTransportDispatcherPool();
    resetSecretRedactionRegistryForTest();
  });

  it("injects the real header only at local HTTP egress and redacts the resolved value", async () => {
    let receivedAuthorization: string | undefined;
    const server = createServer((request, response) => {
      receivedAuthorization = request.headers.authorization;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const port = (server.address() as AddressInfo).port;
      const baseUrl = `http://127.0.0.1:${port}/v1`;
      const model = {
        id: "integration-model",
        provider: "sentinel-integration",
        api: "openai-responses",
        baseUrl,
      } as unknown as Model<"openai-responses">;
      const secret = "integration-provider-secret";
      const sentinel = mintSecretSentinel(secret, { label: "model-auth:integration" });

      const response = await buildGuardedModelFetch(model)(`${baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sentinel}` },
        body: "{}",
      });
      await response.text();

      expect(receivedAuthorization).toBe(`Bearer ${secret}`);
      expect(redactSensitiveText(`upstream used ${secret}`, { mode: "off" })).toBe(
        "upstream used integr…cret",
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it.each([false, true])(
    "retries only before body handoff (fail during upload: %s)",
    async (duringUpload) => {
      const bodies: string[] = [];
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          bodies.push(Buffer.concat(chunks).toString("utf8"));
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end("data: ok\n\n");
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });

      try {
        const pool = getProviderTransportDispatcherPool();
        const acquire = pool.acquire.bind(pool);
        const reused: boolean[] = [];
        let injectFailure = true;
        let bodyHandoffs = 0;
        let completedUploads = 0;
        vi.spyOn(pool, "acquire").mockImplementation((params) => {
          const lease = acquire(params);
          if (!lease) {
            return lease;
          }
          reused.push(lease.reused);
          if (!injectFailure) {
            return lease;
          }
          injectFailure = false;
          return {
            ...lease,
            dispatcher: lease.dispatcher.compose((dispatch) => (options, handler) => {
              const failure = Object.assign(new Error("injected socket failure"), {
                code: "UND_ERR_SOCKET",
              });
              if (!duringUpload) {
                throw failure;
              }
              return dispatch(
                options,
                new Proxy(handler, {
                  get(target, property) {
                    if (property === "onBodySent") {
                      return (chunk: Buffer) => {
                        bodyHandoffs += 1;
                        target.onBodySent?.(chunk);
                        throw failure;
                      };
                    }
                    if (property === "onRequestSent") {
                      return () => {
                        completedUploads += 1;
                        return target.onRequestSent?.();
                      };
                    }
                    const value = Reflect.get(target, property, target) as unknown;
                    return typeof value === "function" ? value.bind(target) : value;
                  },
                }),
              );
            }),
          };
        });

        const port = (server.address() as AddressInfo).port;
        const baseUrl = `http://127.0.0.1:${port}/v1`;
        const model = {
          id: "claude-sonnet-4-6",
          provider: "anthropic",
          api: "anthropic-messages",
          baseUrl,
        } as unknown as Model<"anthropic-messages">;
        const body = JSON.stringify({
          model: model.id,
          stream: true,
          messages: [{ role: "user", content: duringUpload ? "x".repeat(32 * 1024 * 1024) : "hi" }],
        });

        const result = buildGuardedModelFetch(model)(`${baseUrl}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });

        if (duringUpload) {
          await expect(result).rejects.toThrow();
          expect(bodyHandoffs).toBeGreaterThan(0);
          expect(completedUploads).toBe(0);
          expect(reused).toEqual([false]);
        } else {
          await expect((await result).text()).resolves.toBe("data: ok\n\n");
          expect(reused).toEqual([false, true]);
          expect(bodies).toEqual([body]);
        }
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    },
  );

  it.each([false, true])(
    "does not retry an Anthropic POST when the socket closes (during upload: %s)",
    async (duringUpload) => {
      let requests = 0;
      const bodies: string[] = [];
      const server = createServer((request) => {
        requests += 1;
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          if (duringUpload) {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            request.socket.destroy();
          }
        });
        request.on("end", () => {
          bodies.push(Buffer.concat(chunks).toString("utf8"));
          request.socket.destroy();
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });

      try {
        const port = (server.address() as AddressInfo).port;
        const baseUrl = `http://127.0.0.1:${port}/v1`;
        const model = {
          id: "claude-sonnet-4-6",
          provider: "anthropic",
          api: "anthropic-messages",
          baseUrl,
        } as unknown as Model<"anthropic-messages">;
        const body = JSON.stringify({
          model: model.id,
          stream: true,
          messages: [{ role: "user", content: duringUpload ? "x".repeat(32 * 1024 * 1024) : "hi" }],
        });

        await expect(
          buildGuardedModelFetch(model)(`${baseUrl}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
        ).rejects.toThrow();

        expect(requests).toBe(1);
        if (duringUpload) {
          expect(bodies).toHaveLength(1);
          expect(bodies[0]!.length).toBeGreaterThan(0);
          expect(bodies[0]!.length).toBeLessThan(body.length);
        } else {
          expect(bodies).toEqual([body]);
        }
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    },
  );
});
