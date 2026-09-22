import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export async function startGenericEmbeddingServer(
  requests: Array<{
    method: string | undefined;
    url: string | undefined;
    body: Record<string, unknown>;
  }>,
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readJsonBody(req);
      requests.push({
        method: req.method,
        url: req.url,
        body,
      });
      const input = Array.isArray(body.input) ? body.input : [body.input];
      const inputType = body.input_type;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: input.map((_text, index) => ({
            object: "embedding",
            embedding: [index + 9.1, inputType === "document" ? 9.2 : 0],
            index,
          })),
          model: body.model,
        }),
      );
    })().catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function expectDefaultEmbeddingResponse(res: Response) {
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    object?: string;
    data?: Array<{ object?: string; embedding?: number[] }>;
  };
  expect(json.object).toBe("list");
  expect(json.data?.[0]?.object).toBe("embedding");
  expect(json.data?.[0]?.embedding).toEqual([0.1, 0.2]);
}

export async function expectEmbeddingData(
  res: Response,
  expected: Array<{ object: "embedding"; index: number; embedding: number[] }>,
) {
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
  };
  expect(json.data).toEqual(expected);
}

export async function expectInvalidEmbeddingRequest(res: Response, message?: string) {
  expect(res.status).toBe(400);
  const json = (await res.json()) as { error?: { type?: string; message?: string } };
  if (message === undefined) {
    expect(json.error?.type).toBe("invalid_request_error");
    return;
  }
  expect(json.error).toEqual({
    type: "invalid_request_error",
    message,
  });
}

// Observe the queued HTTP request while keeping the lifetime owner intact.
export function observeNextEmbeddingAdmission(
  embeddingsProviderLifetime: typeof import("./embeddings-provider-lifetime.js"),
) {
  const entered = createDeferred<AbortSignal>();
  const acquire = embeddingsProviderLifetime.acquireEmbeddingProviderLease;
  const spy = vi
    .spyOn(embeddingsProviderLifetime, "acquireEmbeddingProviderLease")
    .mockImplementationOnce((...args) => {
      const acquired = acquire(...args);
      entered.resolve(args[1]);
      return acquired;
    });
  return { entered: entered.promise, restore: () => spy.mockRestore() };
}
