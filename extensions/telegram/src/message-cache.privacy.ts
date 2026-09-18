import type { Message } from "grammy/types";
import { resolveTelegramIgnoreDisposition } from "./ignore-command.js";
import { TELEGRAM_MESSAGE_PRIVACY_PERSISTENT_MAX_ENTRIES } from "./message-cache-persistence.js";
import type { TelegramMessageCacheBucket } from "./message-cache.types.js";

type MessageWithExternalReply = Message & { external_reply?: Message };

export function telegramIgnoredMediaGroupIdentity(params: {
  accountId: string;
  chatId: string | number;
  mediaGroupId: string;
}): string {
  return JSON.stringify([params.accountId, String(params.chatId), params.mediaGroupId]);
}

export function telegramIgnoredMessageIdentity(params: {
  accountId: string;
  chatId: string | number;
  messageId: string;
}): string {
  return JSON.stringify([params.accountId, String(params.chatId), params.messageId]);
}

export function telegramIgnoredMessageKey(params: {
  scopeKey: string | undefined;
  accountId: string;
  chatId: string | number;
  messageId: string;
}): string {
  const digest = Buffer.from(telegramIgnoredMessageIdentity(params), "utf8").toString("base64url");
  return `${params.scopeKey ? `${params.scopeKey}:` : ""}ignored-message:${digest}`;
}

export function telegramIgnoredMediaGroupKey(params: {
  scopeKey: string | undefined;
  accountId: string;
  chatId: string | number;
  mediaGroupId: string;
}): string {
  const digest = Buffer.from(telegramIgnoredMediaGroupIdentity(params), "utf8").toString(
    "base64url",
  );
  return `${params.scopeKey ? `${params.scopeKey}:` : ""}ignored-media-group:${digest}`;
}

export function readIgnoredMessageIds(params: {
  bucket: TelegramMessageCacheBucket;
  accountId: string;
  chatId: string | number;
}): Set<string> {
  const expectedAccountId = params.accountId;
  const expectedChatId = String(params.chatId);
  return new Set(
    Array.from(params.bucket.ignoredMessages, (identity) => {
      // SAFETY: ignored-message identities are created above as three-string JSON tuples.
      const parsed = JSON.parse(identity) as [string, string, string];
      return parsed[0] === expectedAccountId && parsed[1] === expectedChatId ? parsed[2] : "";
    }).filter(Boolean),
  );
}

export function registerPrivacyIdentity(
  bucket: TelegramMessageCacheBucket,
  entry: { kind: "ignored-message" | "ignored-media-group"; identity: string },
): void {
  const key = `${entry.kind}\0${entry.identity}`;
  bucket.privacyIdentities.delete(key);
  bucket.privacyIdentities.set(key, entry);
  const target =
    entry.kind === "ignored-message" ? bucket.ignoredMessages : bucket.ignoredMediaGroups;
  target.delete(entry.identity);
  target.add(entry.identity);
  while (bucket.privacyIdentities.size > TELEGRAM_MESSAGE_PRIVACY_PERSISTENT_MAX_ENTRIES) {
    const oldest = bucket.privacyIdentities.entries().next().value;
    if (!oldest) {
      break;
    }
    const [oldestKey, oldestEntry] = oldest;
    bucket.privacyIdentities.delete(oldestKey);
    const oldestTarget =
      oldestEntry.kind === "ignored-message" ? bucket.ignoredMessages : bucket.ignoredMediaGroups;
    oldestTarget.delete(oldestEntry.identity);
  }
}

export function readIgnoredMediaGroupIds(params: {
  bucket: TelegramMessageCacheBucket;
  accountId: string;
  chatId: string | number;
}): Set<string> {
  const expectedAccountId = params.accountId;
  const expectedChatId = String(params.chatId);
  return new Set(
    Array.from(params.bucket.ignoredMediaGroups, (identity) => {
      // SAFETY: ignored-media-group identities are created above as three-string JSON tuples.
      const parsed = JSON.parse(identity) as [string, string, string];
      return parsed[0] === expectedAccountId && parsed[1] === expectedChatId ? parsed[2] : "";
    }).filter(Boolean),
  );
}

export function detachReplyTargetsByPrivacy(
  msg: Message,
  params: {
    chatId: string | number;
    ignoredMessageIds: ReadonlySet<string>;
    ignoredMediaGroupIds: ReadonlySet<string>;
  },
): Message {
  const expectedChatId = String(params.chatId);
  return detachMatchingReplyTarget(msg, (reply, kind) => {
    if (
      kind === "external_reply" &&
      (reply.chat?.id == null || String(reply.chat.id) !== expectedChatId)
    ) {
      return false;
    }
    return (
      params.ignoredMessageIds.has(String(reply.message_id)) ||
      (typeof reply.media_group_id === "string" &&
        params.ignoredMediaGroupIds.has(reply.media_group_id))
    );
  });
}

export function resolveReplyMessage(msg: Message): Message | undefined {
  // SAFETY: Telegram can supply external_reply even though this grammY Message version omits it.
  const externalReply = (msg as MessageWithExternalReply).external_reply;
  return msg.reply_to_message ?? externalReply;
}

export function resolveEmbeddedReplyMessage(msg: Message): Message | undefined {
  return msg.reply_to_message;
}

type TelegramReplyTargetKind = "reply_to_message" | "external_reply";

function detachMatchingReplyTarget<T extends Message>(
  msg: T,
  matches: (reply: Message, kind: TelegramReplyTargetKind) => boolean,
  visited = new Set<string>(),
): T {
  let detached: T = msg;
  // SAFETY: Telegram can supply external_reply even though this grammY Message version omits it.
  const externalReply = (msg as MessageWithExternalReply).external_reply;
  if (externalReply && matches(externalReply, "external_reply")) {
    detached = { ...detached };
    // SAFETY: the cloned Message preserves T while removing only Telegram's optional extension.
    delete (detached as MessageWithExternalReply).external_reply;
    // TextQuote belongs to the detached direct target on external replies too.
    delete detached.quote;
  }

  // Telegram external replies are a single, non-recursive envelope. Only an embedded
  // reply_to_message can carry a reply chain that needs recursive detachment.
  const replyMessage = msg.reply_to_message;
  if (!replyMessage) {
    return detached;
  }
  const replyId = String(replyMessage.message_id);
  if (visited.has(replyId)) {
    return detached;
  }
  visited.add(replyId);
  if (matches(replyMessage, "reply_to_message")) {
    const withoutReply = { ...detached };
    delete withoutReply.reply_to_message;
    // Telegram's TextQuote belongs to the direct reply target. Keeping it after
    // detaching an ignored reply would persist a second copy of the hidden text.
    delete withoutReply.quote;
    return withoutReply;
  }
  const detachedReply = detachMatchingReplyTarget(replyMessage, matches, visited);
  return detachedReply === replyMessage
    ? detached
    : Object.assign({}, detached, { reply_to_message: detachedReply });
}

export function detachReplyTargetsById(
  msg: Message,
  messageIds: ReadonlySet<string>,
  chatId: string | number,
): Message {
  const expectedChatId = String(chatId);
  return detachMatchingReplyTarget(msg, (reply, kind) => {
    if (!messageIds.has(String(reply.message_id))) {
      return false;
    }
    if (kind === "reply_to_message") {
      return true;
    }
    // external_reply message numbers are chat-local. Missing or different chat identity must
    // fail closed so removing one chat's message cannot detach another chat's same-number reply.
    return reply.chat?.id != null && String(reply.chat.id) === expectedChatId;
  });
}

/**
 * Telegram embeds reply payloads. Keep an ignored target available to the live turn, but never
 * persist it (or a dangling replyToId) where cache hydration could restore it later.
 */
export function detachIgnoredReplyTarget(
  msg: Message,
  chatId: string | number | undefined,
  botUsername: string | undefined,
  ignoreEnabled: boolean,
  ignoredMessageIds?: ReadonlySet<string>,
  ignoredMediaGroupIds?: ReadonlySet<string>,
): Message {
  if (!ignoreEnabled && !ignoredMessageIds?.size && !ignoredMediaGroupIds?.size) {
    return msg;
  }
  const expectedChatId = chatId == null ? undefined : String(chatId);
  return detachMatchingReplyTarget(msg, (reply, kind) => {
    if (
      kind === "external_reply" &&
      (expectedChatId === undefined ||
        reply.chat?.id == null ||
        String(reply.chat.id) !== expectedChatId)
    ) {
      return false;
    }
    return (
      (ignoreEnabled && resolveTelegramIgnoreDisposition(reply, botUsername) !== "keep") ||
      ignoredMessageIds?.has(String(reply.message_id)) === true ||
      (typeof reply.media_group_id === "string" &&
        ignoredMediaGroupIds?.has(reply.media_group_id) === true)
    );
  });
}
