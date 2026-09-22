import { sendTextMediaPayload } from "openclaw/plugin-sdk/reply-payload";
// Telegram tests cover telegram outbound plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { telegramOutbound } from "./outbound-adapter.js";
import { clearTelegramRuntimeForTest as clearTelegramRuntime } from "./runtime.test-support.js";

describe("telegramPlugin outbound", () => {
  it("uses the rich-message limit before the shared outbound chunker", () => {
    const resolveLimit = telegramOutbound.resolveEffectiveTextChunkLimit;
    expect(resolveLimit?.({ cfg: {}, accountId: "default", fallbackLimit: 4000 })).toBe(4000);
    expect(
      resolveLimit?.({
        cfg: { channels: { telegram: { richMessages: true } } },
        accountId: "default",
        fallbackLimit: 4000,
      }),
    ).toBe(32768);
  });

  it("preserves an explicitly configured lower rich-message limit", () => {
    expect(
      telegramOutbound.resolveEffectiveTextChunkLimit?.({
        cfg: {
          channels: { telegram: { richMessages: true, textChunkLimit: 1200 } },
        },
        accountId: "default",
        fallbackLimit: 4000,
      }),
    ).toBe(1200);
  });

  it("uses the selected account's rich-message limit", () => {
    expect(
      telegramOutbound.resolveEffectiveTextChunkLimit?.({
        cfg: {
          channels: {
            telegram: {
              richMessages: false,
              accounts: { rich: { richMessages: true } },
            },
          },
        },
        accountId: "rich",
        fallbackLimit: 4000,
      }),
    ).toBe(32768);
  });

  it("preserves a selected account's lower rich-message limit", () => {
    expect(
      telegramOutbound.resolveEffectiveTextChunkLimit?.({
        cfg: {
          channels: {
            telegram: {
              accounts: { rich: { richMessages: true, textChunkLimit: 1200 } },
            },
          },
        },
        accountId: "rich",
        fallbackLimit: 4000,
      }),
    ).toBe(1200);
  });
  it("strips assistant-visible tool traces before outbound delivery", () => {
    clearTelegramRuntime();
    const text = 'Done.\n⚠️ 🛠️ `search "Pipeline" in ~/.openclaw/workspace-* (agent)` failed';

    expect(telegramOutbound.sanitizeText?.({ text, payload: { text } })).toBe("Done.");
  });

  it("delivers bounded HTML through the shared payload path without an initialized runtime", async () => {
    clearTelegramRuntime();
    const oversizedLink = `<a href="https://example.com/${"x".repeat(4_000)}">first</a>`;
    const text = `${oversizedLink}<b>second</b>`;
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "tg-1", chatId: "12345" });

    await sendTextMediaPayload({
      channel: "telegram",
      ctx: {
        cfg: {},
        to: "12345",
        text: "",
        payload: { text },
        formatting: { parseMode: "HTML" },
        deps: { sendTelegram },
      },
      adapter: telegramOutbound,
    });

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledWith(
      "12345",
      "first<b>second</b>",
      expect.objectContaining({ textMode: "html" }),
    );
  });

  it("keeps rich-account legacy HTML chunks within Telegram's text limit", async () => {
    clearTelegramRuntime();
    const text = "x".repeat(4_001);
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "tg-1", chatId: "12345" });

    await sendTextMediaPayload({
      channel: "telegram",
      ctx: {
        cfg: { channels: { telegram: { richMessages: true } } },
        to: "12345",
        text: "",
        payload: { text },
        formatting: { parseMode: "HTML" },
        deps: { sendTelegram },
      },
      adapter: telegramOutbound,
    });

    expect(sendTelegram.mock.calls.map((call) => call[1])).toEqual(["x".repeat(4_000), "x"]);
    expect(sendTelegram.mock.calls.every((call) => call[2]?.textMode === "html")).toBe(true);
  });

  it("keeps astral characters whole at positive configured chunk limits", () => {
    clearTelegramRuntime();

    expect(telegramOutbound.chunker?.("A😀B", 1)).toEqual(["A", "😀", "B"]);
    expect(telegramOutbound.chunker?.("A😀B", 1, { formatting: { parseMode: "HTML" } })).toEqual([
      "A",
      "😀",
      "B",
    ]);
  });
});
