// Telegram tests cover size-aware upload deadlines through the real send stack.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTelegramClientOptionsCacheForTests, sendMessageTelegram } from "./send.js";

const { loadWebMedia, resolveTelegramTransport } = vi.hoisted(() => ({
  loadWebMedia: vi.fn(),
  resolveTelegramTransport: vi.fn(),
}));

vi.mock("./send.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.runtime.js")>()),
  loadWebMedia,
}));

vi.mock("./fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fetch.js")>()),
  resolveTelegramTransport,
}));

const MIB = 1024 * 1024;
const cfg = { channels: { telegram: { botToken: "123456:upload-timeout-fixture" } } };

describe("Telegram media upload deadline", () => {
  const aborts: Array<{ method: string; afterMs: number; reason: string }> = [];

  // Stands in for a Bot API server that is still relaying the file to Telegram.
  const pendingUploadFetch = (url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const startedAt = Date.now();
      init?.signal?.addEventListener(
        "abort",
        () => {
          const reason: unknown = init.signal?.reason;
          const error = reason instanceof Error ? reason : new Error("aborted");
          aborts.push({
            method: url.split("/").at(-1) ?? "",
            afterMs: Date.now() - startedAt,
            reason: error.message,
          });
          reject(error);
        },
        { once: true },
      );
    });

  beforeEach(() => {
    vi.useFakeTimers();
    aborts.length = 0;
    resetTelegramClientOptionsCacheForTests();
    resolveTelegramTransport.mockReturnValue({
      fetch: pendingUploadFetch as typeof fetch,
      sourceFetch: pendingUploadFetch as typeof fetch,
      close: vi.fn(async () => undefined),
    });
  });

  afterEach(() => {
    resetTelegramClientOptionsCacheForTests();
    vi.useRealTimers();
  });

  it("keeps a 40 MiB document upload open past the 30s senddocument guard", async () => {
    loadWebMedia.mockResolvedValue({
      buffer: Buffer.alloc(40 * MIB),
      contentType: "application/zip",
      fileName: "archive.zip",
    });

    const outcome = sendMessageTelegram("123", "archive", {
      cfg,
      mediaUrl: "file:///tmp/archive.zip",
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(40_000);

    // 40 MiB at the assumed 2 MiB/s is 20s, plus the 15s response margin.
    expect(aborts).toEqual([
      {
        method: "sendDocument",
        afterMs: 35_000,
        reason: "Telegram senddocument timed out after 35000ms",
      },
    ]);
    await expect(outcome).resolves.toBeInstanceOf(Error);
  });
});
