/**
 * The Telegram "Current message:" carrier block, split out of inbound-meta.test.ts
 * so that file stays under the line cap (the ratchet rejects growth on a file that
 * is already over it). Subject: src/auto-reply/reply/inbound-meta.current-message.ts.
 */
import { describe, expect, it } from "vitest";
import type { TemplateContext } from "../templating.js";
import { buildInboundUserContextPrefix } from "./inbound-meta.js";

describe("buildInboundUserContextPrefix — Telegram current-message carrier", () => {
  it("states the current message body inside the Telegram current-message block", () => {
    const body = "What's the end result?";
    const text = buildInboundUserContextPrefix(
      {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        ChatType: "group",
        MessageSid: "34974",
        ReplyToId: "34971",
        ReplyToBody: "The full message should not be preferred.",
        ReplyToQuoteText: " selected quote\n",
        SenderName: "obviyus",
        Timestamp: Date.UTC(2026, 4, 10, 17, 8),
        agentText: body,
        Body: body,
        BodyForAgent: body,
      } as TemplateContext,
      { timezone: "utc" },
    );

    // The carrier block is a separate model-facing message; a bare "#34974:"
    // header is read as an empty (elided) current-message body and real
    // instructions get treated as absent/duplicate. The body must be stated
    // inside the block itself.
    expect(text).toContain(`Current message:\n[Replying to: "selected quote"]\n#34974: ${body}`);
    const currentMessageBlock = text.split("Current message:").at(-1) ?? "";
    expect(currentMessageBlock.trimEnd().endsWith("#34974:")).toBe(false);
  });
  it("preserves the bare Telegram current-message header when the turn has no body", () => {
    const text = buildInboundUserContextPrefix(
      {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        ChatType: "group",
        MessageSid: "34974",
        ReplyToId: "34971",
        ReplyToQuoteText: " selected quote\n",
        SenderName: "obviyus",
      } as TemplateContext,
      { timezone: "utc" },
    );

    expect(text).toContain('Current message:\n[Replying to: "selected quote"]\n#34974:');
    expect(text.trimEnd().endsWith("#34974:")).toBe(true);
  });
});
