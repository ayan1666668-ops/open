// Feishu plugin module implements message action parameter resolution behavior.
import { resolveReactionMessageId } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { normalizeFeishuTarget } from "./targets.js";

type FeishuReactionActionContext = Pick<ChannelMessageActionContext, "params" | "toolContext">;

export function readFirstString(
  params: Record<string, unknown>,
  keys: string[],
  fallback?: string | null,
): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  return undefined;
}

export function resolveFeishuActionTarget(ctx: {
  params: Record<string, unknown>;
  toolContext?: { currentChannelId?: string } | null;
}): string | undefined {
  return readFirstString(ctx.params, ["to", "target"], ctx.toolContext?.currentChannelId);
}

export function resolveFeishuMessageId(params: Record<string, unknown>): string | undefined {
  return readFirstString(params, ["messageId", "message_id", "replyTo", "reply_to"]);
}

function reactionTargetsCurrentConversation(ctx: FeishuReactionActionContext): boolean {
  if (
    ctx.toolContext?.currentChannelProvider &&
    ctx.toolContext.currentChannelProvider !== "feishu"
  ) {
    return false;
  }
  const currentTarget =
    ctx.toolContext?.currentMessagingTarget ?? ctx.toolContext?.currentChannelId;
  const target = resolveFeishuActionTarget(ctx);
  return Boolean(
    currentTarget &&
    target &&
    normalizeFeishuTarget(currentTarget) === normalizeFeishuTarget(target),
  );
}

/**
 * Reaction actions default to the message that triggered this turn, the contract the
 * shared core resolver owns. The fallback stays inside the current conversation: a
 * reaction aimed at another chat would otherwise act on the inbound message while
 * reporting the requested destination, so it still requires an explicit id.
 */
export function resolveFeishuReactionMessageId(
  ctx: FeishuReactionActionContext,
): string | undefined {
  const explicit = resolveFeishuMessageId(ctx.params);
  if (explicit || !reactionTargetsCurrentConversation(ctx)) {
    return explicit;
  }
  const resolved = resolveReactionMessageId({
    args: ctx.params,
    toolContext: { currentMessageId: ctx.toolContext?.currentMessageId },
  });
  return typeof resolved === "string" && resolved.trim() ? resolved.trim() : undefined;
}
