// Telegram plugin module maps bot-authored inbound turns onto the shared bot-pair loop guard.
import type { Message } from "grammy/types";
import type { ChannelBotLoopProtectionFacts } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

/**
 * Bot-pair facts for the core turn runner, or undefined when this turn is not another
 * bot's message. Core records the pair and drops the turn before session record and
 * dispatch once the pair exceeds its budget; Telegram only identifies the two bots.
 *
 * Channel posts reach here with the synthetic `is_bot` sender that the inbound pipeline
 * stamps on them, so two bots answering each other in a channel count as a pair too.
 * Telegram declares no channel or account override, so only
 * `channels.defaults.botLoopProtection` applies, as for Feishu.
 */
export function resolveTelegramBotLoopProtection(params: {
  cfg: OpenClawConfig;
  accountId: string;
  msg: Message;
  botUserId: number | undefined;
}): ChannelBotLoopProtectionFacts | undefined {
  const sender = params.msg.from;
  if (sender?.is_bot !== true || params.botUserId == null || sender.id === params.botUserId) {
    return undefined;
  }
  return {
    scopeId: params.accountId,
    conversationId: String(params.msg.chat.id),
    senderId: String(sender.id),
    receiverId: String(params.botUserId),
    // A spooled replay of the same update must not spend the pair budget twice.
    eventId: String(params.msg.message_id),
    defaultsConfig: params.cfg.channels?.defaults?.botLoopProtection,
    defaultEnabled: true,
    nowMs: params.msg.date * 1000,
  };
}
