import {
  IncomingMessage,
  ServerResponse,
  type ClientRequest,
  type IncomingHttpHeaders,
} from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import { Socket } from "node:net";
import { PassThrough, Writable, type Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { resolveSecretSentinel, sealSecretSentinel } from "../sentinel.js";
import { createSecretEgressBodyBudget, forwardSecretEgressRequest } from "./proxy-forward.js";

vi.mock("node:https", { spy: true });

describe("secret egress forwarding resource ownership", () => {
  it.each([undefined, 0])(
    "releases body streams when upstream construction fails (length: %s)",
    async (length) => {
      const request = new IncomingMessage(new Socket());
      request.headers = length === undefined ? {} : { "content-length": String(length) };
      request.method = "POST";
      request.on("error", () => {});
      const response = new ServerResponse(request);
      const agent = new Agent();
      const resources: Array<Readable | Writable> = [];
      try {
        forwardSecretEgressRequest({
          request,
          response,
          host: "localhost",
          upstreamTlsAgent: agent,
          // A protected value can contain newlines. Node refuses this header
          // synchronously, before DNS, TLS or any upstream socket is opened.
          prepareRequest: () => ({
            target: new URL("https://localhost:1/"),
            headers: { "x-synthetic": "invalid\nheader" },
            substituted: true,
          }),
          acquireBody: createSecretEgressBodyBudget(),
          isActive: () => true,
          ownResource: (resource) => {
            resources.push(resource);
            resource.on("error", () => resource.destroy());
            return resource;
          },
          releaseResponse() {},
          resolveSentinel() {
            return undefined;
          },
          audit() {},
        });
        request.push(null);
        await setImmediate();
        response.emit("close");
        await setImmediate();
        expect(response.statusCode).toBe(502);
        expect(resources.every((resource) => resource.destroyed)).toBe(true);
      } finally {
        for (const resource of resources) {
          resource.destroy();
        }
        request.destroy();
        response.destroy();
        agent.destroy();
      }
    },
  );

  it.each([
    ["run revocation", "drain"],
    ["run revocation", "next turn"],
    ["proxy stop", "drain"],
    ["proxy stop", "next turn"],
    ["client disconnect", "drain"],
    ["client disconnect", "next turn"],
  ] as const)("stops buffered submission after %s while waiting for %s", async (cause, wait) => {
    const secret = "synthetic-buffered-secret";
    const body = Buffer.concat([
      Buffer.alloc(128 * 1024, 120),
      Buffer.from(sealSecretSentinel(secret, { label: "buffered-cancellation" }) + "tail"),
    ]);
    const request = new IncomingMessage(new Socket());
    request.headers = { "content-length": String(body.length) };
    request.method = "POST";
    request.on("error", () => {});
    const response = new ServerResponse(request);
    const agent = new Agent();
    const resources: Array<Readable | Writable> = [];
    const submitted: Buffer[] = [];
    let completeWrite: (error?: Error | null) => void = () => {};
    let firstWrite: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      firstWrite = resolve;
    });
    // Real Writable backpressure controls transport admission without relying on
    // platform socket buffers or adding a test-only production hook.
    const upstream = new Writable({
      highWaterMark: wait === "drain" ? 1 : body.length + 1,
      write(chunk: Buffer, _encoding, callback) {
        submitted.push(Buffer.from(chunk));
        completeWrite = callback;
        firstWrite();
      },
    });
    vi.mocked(httpsRequest).mockReturnValueOnce(upstream as unknown as ClientRequest);
    const releaseBody = vi.fn();
    const audit = vi.fn();
    let active = true;
    try {
      forwardSecretEgressRequest({
        request,
        response,
        host: "localhost",
        upstreamTlsAgent: agent,
        prepareRequest: () => ({
          target: new URL("https://localhost:1/"),
          headers: {},
          substituted: false,
        }),
        acquireBody: () => releaseBody,
        isActive: () => active,
        ownResource: (resource) => {
          resources.push(resource);
          return resource;
        },
        releaseResponse() {},
        resolveSentinel: resolveSecretSentinel,
        audit,
      });
      request.push(body);
      request.push(null);
      await started;
      expect(releaseBody).not.toHaveBeenCalled();
      if (cause === "client disconnect") {
        response.emit("close");
      } else {
        active = false;
        if (cause === "proxy stop") {
          for (const resource of resources) {
            resource.destroy();
          }
        }
      }
      completeWrite();
      await setImmediate();
      await setImmediate();
      const sent = Buffer.concat(submitted);
      expect(sent.length).toBeLessThan(body.length);
      expect(sent.includes(secret)).toBe(false);
      expect(sent.includes("tail")).toBe(false);
      expect(upstream.destroyed).toBe(true);
      expect(upstream.writableEnded).toBe(false);
      expect(releaseBody).toHaveBeenCalledOnce();
      expect(audit).not.toHaveBeenCalled();
    } finally {
      for (const resource of resources) {
        resource.destroy();
      }
      request.destroy();
      response.destroy();
      agent.destroy();
    }
  });
});

const CJK_FILE_NAME = "附件_2026-09-21.log";
const CJK_DISPOSITION =
  "attachment; filename=\"___2026-09-21.log\"; filename*=UTF-8''%E9%99%84%E4%BB%B6_2026-09-21.log";

describe("secret egress forwarded response headers", () => {
  // Node accepts latin1 header bytes, then once content-length is stored it
  // rewrites content-disposition through a latin1 Buffer and validates that as
  // UTF-8. CJK wire bytes then throw ERR_INVALID_CHAR out of writeHead.
  async function captureForwardedResponse(
    headers: IncomingHttpHeaders,
    body: Buffer,
    prepare?: (response: ServerResponse) => void,
  ): Promise<Buffer> {
    const request = new IncomingMessage(new Socket());
    request.method = "GET";
    request.headers = {};
    request.on("error", () => {});
    const response = new ServerResponse(request);
    const chunks: Buffer[] = [];
    const socket = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    });
    response.assignSocket(socket as unknown as Socket);
    const agent = new Agent();
    const resources: Array<Readable | Writable> = [];
    const upstream = new PassThrough();
    let upstreamResponse: IncomingMessage | undefined;
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);
    vi.mocked(httpsRequest).mockImplementationOnce(((...args: unknown[]) => {
      const callback = args.find((entry) => typeof entry === "function") as
        | ((message: IncomingMessage) => void)
        | undefined;
      upstreamResponse = new IncomingMessage(new Socket());
      upstreamResponse.statusCode = 200;
      upstreamResponse.headers = headers;
      upstreamResponse.on("error", () => {});
      // The real client emits the response after httpsRequest returns, outside
      // the send() try/catch. A synchronous callback would hide the crash.
      const responseMessage = upstreamResponse;
      process.nextTick(() => {
        callback?.(responseMessage);
        if (!responseMessage.destroyed) {
          responseMessage.push(body);
          responseMessage.push(null);
        }
      });
      return upstream as unknown as ClientRequest;
    }) as never);
    try {
      prepare?.(response);
      forwardSecretEgressRequest({
        request,
        response,
        host: "localhost",
        upstreamTlsAgent: agent,
        prepareRequest: () => ({
          target: new URL("https://localhost:1/"),
          headers: {},
          substituted: false,
        }),
        acquireBody: createSecretEgressBodyBudget(),
        isActive: () => true,
        ownResource: (resource) => {
          resources.push(resource);
          return resource;
        },
        releaseResponse() {},
        resolveSentinel() {
          return undefined;
        },
        audit() {},
      });
      request.push(null);
      await setImmediate();
      expect(uncaught).toEqual([]);
      return Buffer.concat(chunks);
    } finally {
      process.off("uncaughtException", onUncaught);
      for (const resource of resources) {
        resource.destroy();
      }
      upstream.destroy();
      upstreamResponse?.destroy();
      request.destroy();
      response.destroy();
      socket.destroy();
      agent.destroy();
    }
  }

  it.each([
    [
      "latin-1 CJK bytes",
      `attachment; filename="${Buffer.from(CJK_FILE_NAME, "utf8").toString("latin1")}"`,
      CJK_DISPOSITION,
    ],
    ["unicode CJK characters", `attachment; filename="${CJK_FILE_NAME}"`, CJK_DISPOSITION],
    [
      "latin-1 high bytes",
      'attachment; filename="caf\u00e9.txt"',
      "attachment; filename=\"caf_.txt\"; filename*=UTF-8''caf%C3%A9.txt",
    ],
  ])(
    "keeps the gateway up when content-length precedes a %s content-disposition",
    async (_label, disposition, expectedDisposition) => {
      const body = Buffer.from("file");
      const raw = await captureForwardedResponse(
        {
          "content-length": String(body.length),
          "content-disposition": disposition,
          "content-type": "application/octet-stream",
          "x-file-name": "附件.log",
        },
        body,
      );
      const text = raw.toString("latin1");

      expect(text).toMatch(/^HTTP\/1\.1 200 /);
      expect(text).toContain("content-length: 4");
      expect(text).toContain(expectedDisposition);
      expect(text).toContain("x-file-name: __.log");
      expect(text).toContain("\r\n\r\nfile");
      expect(
        raw.every(
          (byte) =>
            byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e),
        ),
      ).toBe(true);
    },
  );

  it("answers 502 when the forwarded response head still cannot be written", async () => {
    const body = Buffer.from("UPSTREAM-BODY");
    let writeHead: { mockRestore: () => void } | undefined;
    try {
      const raw = await captureForwardedResponse(
        {
          "content-type": "text/plain",
          "content-length": String(body.length),
        },
        body,
        (response) => {
          writeHead = vi.spyOn(response, "writeHead").mockImplementationOnce(() => {
            const error = new TypeError(
              'Invalid character in header content ["content-disposition"]',
            );
            (error as NodeJS.ErrnoException).code = "ERR_INVALID_CHAR";
            throw error;
          });
        },
      );
      const text = raw.toString("latin1");

      expect(text).toMatch(/^HTTP\/1\.1 502 /);
      expect(text).toContain("Secret egress proxy could not forward the upstream response.");
      expect(text).not.toContain("UPSTREAM-BODY");
    } finally {
      writeHead?.mockRestore();
    }
  });
});
