import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

// Telegram reports the sender's app UI language on every message. It is the only
// language signal available before the guest has written anything, so commands
// that answer /start (plugin-registered welcome flows) can greet in it instead of
// falling back to English.
describe("buildTelegramMessageContext sender language", () => {
  async function buildCtx(from: Record<string, unknown>) {
    return await buildTelegramMessageContextForTest({
      message: {
        message_id: 1,
        chat: { id: -99, type: "supergroup", title: "Dev Chat" },
        date: 1700000000,
        text: "hello",
        from,
      },
    });
  }

  it("carries language_code through as SenderLanguage", async () => {
    const ctx = await buildCtx({ id: 42, first_name: "Alice", language_code: "ru" });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.SenderLanguage).toBe("ru");
  });

  it("preserves regional tags verbatim", async () => {
    const ctx = await buildCtx({ id: 42, first_name: "Alice", language_code: "pt-br" });

    expect(ctx?.ctxPayload?.SenderLanguage).toBe("pt-br");
  });

  it("leaves SenderLanguage undefined when Telegram omits it", async () => {
    const ctx = await buildCtx({ id: 42, first_name: "Alice" });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.SenderLanguage).toBeUndefined();
  });
});
