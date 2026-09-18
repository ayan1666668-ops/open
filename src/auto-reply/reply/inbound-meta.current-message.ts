// The Telegram "Current message:" carrier block. Split out of inbound-meta.ts so
// that file stays under the line cap; the block is a self-contained model-facing
// projection and its two helpers are private to it.
import type { TemplateContext } from "../templating.js";
import {
  normalizePromptMetadataString,
  sanitizeTranscriptBody,
  sanitizeTranscriptField,
} from "./inbound-meta.text.js";

function isTelegramInboundContext(ctx: TemplateContext): boolean {
  return [ctx.OriginatingChannel, ctx.Surface, ctx.Provider].some(
    (value) => normalizePromptMetadataString(value) === "telegram",
  );
}

function resolveInlineReplyQuote(ctx: TemplateContext): string | undefined {
  return sanitizeTranscriptField(ctx.ReplyToQuoteText) ?? sanitizeTranscriptBody(ctx.ReplyToBody);
}

export function formatTelegramCurrentMessageContext(ctx: TemplateContext): string | undefined {
  if (!isTelegramInboundContext(ctx)) {
    return undefined;
  }
  const quote = resolveInlineReplyQuote(ctx);
  if (!quote) {
    return undefined;
  }
  const messageId =
    normalizePromptMetadataString(ctx.MessageSid) ??
    normalizePromptMetadataString(ctx.MessageSidFull);
  // This block ships as its own model-facing runtime-context carrier while the
  // live body arrives as a separate user turn (the legacy single-space join
  // only applies to inline pre-carrier projections). A bare "#<id>:" header is
  // read as an empty/elided current-message body, so real instructions get
  // treated as absent or duplicates. State the canonical body inline (sanitized
  // like every other transcript projection; bodyless turns keep the bare header)
  // so the line is self-contained and never renders empty.
  const currentBody =
    sanitizeTranscriptBody(ctx.agentText) ??
    sanitizeTranscriptBody(ctx.BodyForAgent) ??
    sanitizeTranscriptBody(ctx.Body);
  const header = messageId ? `#${messageId}:${currentBody ? ` ${currentBody}` : ""}` : currentBody;
  return ["Current message:", `[Replying to: ${JSON.stringify(quote)}]`, header]
    .filter((line) => line !== undefined)
    .join("\n");
}
