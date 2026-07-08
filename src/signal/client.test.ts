import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithTimeoutMock = vi.fn();
const resolveFetchMock = vi.fn();

vi.mock("../infra/fetch.js", () => ({
  resolveFetch: (...args: unknown[]) => resolveFetchMock(...args),
}));

vi.mock("../infra/secure-random.js", () => ({
  generateSecureUuid: () => "test-id",
}));

vi.mock("../utils/fetch-timeout.js", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeoutMock(...args),
}));

import { isSignalConnectFailure, signalRpcRequest } from "./client.js";

function rpcResponse(body: unknown, status = 200): Response {
  if (typeof body === "string") {
    return new Response(body, { status });
  }
  return new Response(JSON.stringify(body), { status });
}

describe("signalRpcRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveFetchMock.mockReturnValue(vi.fn());
  });

  it("returns parsed RPC result", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      rpcResponse({ jsonrpc: "2.0", result: { version: "0.13.22" }, id: "test-id" }),
    );

    const result = await signalRpcRequest<{ version: string }>("version", undefined, {
      baseUrl: "http://127.0.0.1:8080",
    });

    expect(result).toEqual({ version: "0.13.22" });
  });

  it("throws a wrapped error when RPC response JSON is malformed", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(rpcResponse("not-json", 502));

    await expect(
      signalRpcRequest("version", undefined, {
        baseUrl: "http://127.0.0.1:8080",
      }),
    ).rejects.toMatchObject({
      message: "Signal RPC returned malformed JSON (status 502)",
      cause: expect.any(SyntaxError),
    });
  });

  it("throws when RPC response envelope has neither result nor error", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(rpcResponse({ jsonrpc: "2.0", id: "test-id" }));

    await expect(
      signalRpcRequest("version", undefined, {
        baseUrl: "http://127.0.0.1:8080",
      }),
    ).rejects.toThrow("Signal RPC returned invalid response envelope (status 200)");
  });

  it("retries when the daemon connection is refused, then succeeds", async () => {
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), {
        code: "ECONNREFUSED",
      }),
    });
    fetchWithTimeoutMock
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce(
        rpcResponse({ jsonrpc: "2.0", result: { timestamp: 123 }, id: "test-id" }),
      );

    const result = await signalRpcRequest<{ timestamp: number }>(
      "send",
      { message: "hi" },
      { baseUrl: "http://127.0.0.1:8080" },
    );

    expect(result).toEqual({ timestamp: 123 });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry timeouts (daemon may have processed the send)", async () => {
    const timeoutErr = Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" });
    fetchWithTimeoutMock.mockRejectedValueOnce(timeoutErr);

    await expect(
      signalRpcRequest("send", { message: "hi" }, { baseUrl: "http://127.0.0.1:8080" }),
    ).rejects.toBe(timeoutErr);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting connection retries", async () => {
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    fetchWithTimeoutMock.mockRejectedValue(refused);

    await expect(
      signalRpcRequest("send", { message: "hi" }, { baseUrl: "http://127.0.0.1:8080" }),
    ).rejects.toBe(refused);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
  });
});

describe("isSignalConnectFailure", () => {
  it("detects nested and aggregate connection failures", () => {
    const direct = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    const nested = new TypeError("fetch failed", { cause: direct });
    const aggregate = new TypeError("fetch failed", {
      cause: { errors: [new Error("other"), direct] },
    });
    expect(isSignalConnectFailure(direct)).toBe(true);
    expect(isSignalConnectFailure(nested)).toBe(true);
    expect(isSignalConnectFailure(aggregate)).toBe(true);
  });

  it("rejects non-connection failures", () => {
    expect(isSignalConnectFailure(new Error("boom"))).toBe(false);
    expect(isSignalConnectFailure(Object.assign(new Error("t"), { code: "ETIMEDOUT" }))).toBe(
      false,
    );
    expect(isSignalConnectFailure(undefined)).toBe(false);
  });
});
