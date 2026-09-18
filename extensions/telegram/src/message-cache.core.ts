// Telegram plugin module implements message cache behavior.
import type { Message } from "grammy/types";
import { formatLocationText } from "openclaw/plugin-sdk/channel-inbound";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveTelegramPrimaryMedia, resolveTelegramRichMessageBody } from "./bot/body-helpers.js";
import {
  buildSenderName,
  extractTelegramLocation,
  getTelegramTextParts,
  normalizeForwardedContext,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import {
  isTelegramMessageCacheSourceMessage,
  parsePersistedTelegramIgnoredMediaGroup,
  parsePersistedTelegramIgnoredMessage,
  parseTelegramResolvedMedia,
  type PersistedTelegramMessageCacheEntry,
  type PersistedTelegramMessagePrivacyEntry,
  type TelegramResolvedMedia,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
  TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION,
  TELEGRAM_MESSAGE_PRIVACY_PERSISTENT_MAX_ENTRIES,
  TELEGRAM_MESSAGE_PRIVACY_PERSISTENT_NAMESPACE,
  type TelegramMessageThreadBinding,
} from "./message-cache-persistence.js";
import {
  detachIgnoredReplyTarget,
  detachReplyTargetsByPrivacy,
  registerPrivacyIdentity,
  resolveEmbeddedReplyMessage,
  resolveReplyMessage,
  telegramIgnoredMediaGroupIdentity,
  telegramIgnoredMediaGroupKey,
  telegramIgnoredMessageIdentity,
} from "./message-cache.privacy.js";
import type {
  TelegramCachedMessageNode,
  TelegramCachedMessageObservation,
  TelegramMessageCacheBucket,
  TelegramMessageCachePersistentStore,
  TelegramMessageObservationMode,
  TelegramMessagePrivacyPersistentStore,
} from "./message-cache.types.js";
import { parseTelegramMessageThreadId } from "./outbound-params.js";
import {
  parseTelegramPromptContextProjection,
  type TelegramPromptContextProjectionMarker,
} from "./prompt-context-projection.js";
import { getOptionalTelegramRuntime } from "./runtime.js";

export type { TelegramCachedMessageNode, TelegramReplyChainEntry } from "./message-cache.types.js";

type MessageWithPromptContextTimestamp = Message & {
  openclaw_prompt_context_timestamp_ms?: unknown;
};

export const DEFAULT_MAX_MESSAGES = 5000;
export const PERSISTENT_BUCKET_KEY = `plugin-state:${TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE}`;
const TELEGRAM_MESSAGE_CACHE_BUCKETS_KEY = Symbol.for("openclaw.telegram.messageCacheBuckets");

function getPersistedMessageCacheBuckets(): Map<string, TelegramMessageCacheBucket> {
  // SAFETY: OpenClaw owns this global symbol slot and stores only the declared bucket map there.
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  // SAFETY: the symbol-keyed slot is populated only by this function with this exact map type.
  const existing = globalRecord[TELEGRAM_MESSAGE_CACHE_BUCKETS_KEY] as
    | Map<string, TelegramMessageCacheBucket>
    | undefined;
  if (existing) {
    return existing;
  }
  const created = new Map<string, TelegramMessageCacheBucket>();
  globalRecord[TELEGRAM_MESSAGE_CACHE_BUCKETS_KEY] = created;
  return created;
}

export function telegramMessageCacheKey(params: {
  scopeKey: string | undefined;
  accountId: string;
  chatId: string | number;
  messageId: string;
}) {
  const key = `${params.accountId}:${params.chatId}:${params.messageId}`;
  return params.scopeKey ? `${params.scopeKey}:${key}` : key;
}

export function telegramMessageCacheKeyPrefix(params: {
  scopeKey: string | undefined;
  accountId: string;
  chatId: string | number;
}) {
  const prefix = `${params.accountId}:${params.chatId}:`;
  return params.scopeKey ? `${params.scopeKey}:${prefix}` : prefix;
}

export function isTelegramMessageFromCurrentBot(msg: Message, botUserId?: number): boolean {
  const currentBotUserId = parseStrictPositiveInteger(botUserId);
  if (currentBotUserId === undefined) {
    return msg.from?.is_bot === true;
  }
  return msg.from?.id === currentBotUserId || msg.sender_business_bot?.id === currentBotUserId;
}

function resolveMessageBody(msg: Message, preserveWhitespace: boolean): string | undefined {
  const text = getTelegramTextParts(msg).text;
  if (text.trim()) {
    return preserveWhitespace ? text : text.trim();
  }
  const location = extractTelegramLocation(msg);
  if (location) {
    return formatLocationText(location);
  }
  return resolveTelegramRichMessageBody(msg);
}

function resolveMessageTimestamp(msg: Message): number | undefined {
  // SAFETY: this optional OpenClaw projection field is read as unknown and validated below.
  const promptContextTimestamp = (msg as MessageWithPromptContextTimestamp)
    .openclaw_prompt_context_timestamp_ms;
  return typeof promptContextTimestamp === "number" && Number.isFinite(promptContextTimestamp)
    ? promptContextTimestamp
    : msg.date
      ? msg.date * 1000
      : undefined;
}

export function normalizeMessageNode(
  msg: Message,
  params: {
    chatId?: string | number;
    threadId?: number;
    promptContextProjectionMarker?: TelegramPromptContextProjectionMarker;
    resolvedMedia?: TelegramResolvedMedia;
    threadBinding?: TelegramMessageThreadBinding;
    botUsername?: string;
  },
): TelegramCachedMessageNode {
  const media = resolveTelegramPrimaryMedia(msg);
  const fileId = media?.fileRef.file_id;
  const forwardedFrom = normalizeForwardedContext(msg);
  const replyMessage = resolveReplyMessage(msg);
  const body = resolveMessageBody(msg, params.promptContextProjectionMarker !== undefined);
  const threadBinding = normalizeTelegramMessageThreadBinding(params.threadBinding);
  const threadId = parseTelegramMessageThreadId(threadBinding?.threadSpec.id ?? params.threadId);
  const timestamp = resolveMessageTimestamp(msg);
  return {
    sourceMessage: msg,
    messageId: String(msg.message_id),
    sender: buildSenderName(msg) ?? "unknown sender",
    ...(msg.from?.id != null ? { senderId: String(msg.from.id) } : {}),
    ...(msg.from?.username ? { senderUsername: msg.from.username } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(body ? { body } : {}),
    ...(media ? { mediaType: media.kind } : {}),
    ...(fileId ? { mediaRef: `telegram:file/${fileId}` } : {}),
    ...(replyMessage?.message_id != null ? { replyToId: String(replyMessage.message_id) } : {}),
    ...(forwardedFrom?.from ? { forwardedFrom: forwardedFrom.from } : {}),
    ...(forwardedFrom?.fromId ? { forwardedFromId: forwardedFrom.fromId } : {}),
    ...(forwardedFrom?.fromUsername ? { forwardedFromUsername: forwardedFrom.fromUsername } : {}),
    ...(forwardedFrom?.date ? { forwardedDate: forwardedFrom.date * 1000 } : {}),
    ...(threadId !== undefined ? { threadId: String(threadId) } : {}),
    ...(params.promptContextProjectionMarker
      ? { promptContextProjectionMarker: params.promptContextProjectionMarker }
      : {}),
    ...(params.resolvedMedia ? { resolvedMedia: params.resolvedMedia } : {}),
    ...(threadBinding ? { threadBinding } : {}),
  };
}

function normalizeTelegramMessageThreadBinding(
  value: unknown,
): TelegramMessageThreadBinding | undefined {
  if (!isRecord(value) || value.kind !== "provider-observed-v1") {
    return undefined;
  }
  const threadSpec = value.threadSpec;
  if (!isRecord(threadSpec)) {
    return undefined;
  }
  const id = parseTelegramMessageThreadId(threadSpec.id);
  if (
    id === undefined ||
    (threadSpec.scope !== "direct-messages" &&
      threadSpec.scope !== "dm" &&
      threadSpec.scope !== "forum")
  ) {
    return undefined;
  }
  return { kind: "provider-observed-v1", threadSpec: { scope: threadSpec.scope, id } };
}

export function createTelegramMessageThreadBinding(
  threadSpec: TelegramThreadSpec | undefined,
): TelegramMessageThreadBinding | undefined {
  return normalizeTelegramMessageThreadBinding({ kind: "provider-observed-v1", threadSpec });
}

export function hasProviderObservedTelegramThreadBinding(
  node: TelegramCachedMessageNode | null | undefined,
  threadId: unknown,
): boolean {
  const normalizedThreadId = parseTelegramMessageThreadId(threadId);
  return (
    normalizedThreadId !== undefined &&
    resolveProviderObservedTelegramThreadSpec(node)?.id === normalizedThreadId
  );
}

export function resolveProviderObservedTelegramThreadSpec(
  node: TelegramCachedMessageNode | null | undefined,
): TelegramMessageThreadBinding["threadSpec"] | undefined {
  return normalizeTelegramMessageThreadBinding(node?.threadBinding)?.threadSpec;
}

export function normalizeMessageNodes(
  msg: Message,
  params: {
    chatId: string | number;
    threadId?: number;
    promptContextProjectionMarker?: TelegramPromptContextProjectionMarker;
    resolvedMedia?: TelegramResolvedMedia;
    threadBinding?: TelegramMessageThreadBinding;
    botUsername?: string;
    ignoreEnabled?: boolean;
    ignoredMessageIds?: ReadonlySet<string>;
    ignoredMediaGroupIds?: ReadonlySet<string>;
  },
): TelegramCachedMessageObservation[] {
  const observations: TelegramCachedMessageObservation[] = [];
  const visited = new Set<string>();
  const nodeThreadId = (node: TelegramCachedMessageNode) =>
    parseTelegramMessageThreadId(node.threadId);
  const visit = (
    observed: Message,
    inheritedThreadId: number | undefined,
    mode: TelegramMessageObservationMode,
    promptContextProjectionMarker?: TelegramPromptContextProjectionMarker,
    threadBinding?: TelegramMessageThreadBinding,
    resolvedMedia?: TelegramResolvedMedia,
  ) => {
    const message = detachIgnoredReplyTarget(
      observed,
      params.chatId,
      params.botUsername,
      params.ignoreEnabled === true,
      params.ignoredMessageIds,
      params.ignoredMediaGroupIds,
    );
    // SAFETY: Telegram may include message_thread_id even when this grammY Message union omits it.
    const messageWithThread = message as { message_thread_id?: unknown };
    const embeddedThreadId = parseTelegramMessageThreadId(messageWithThread.message_thread_id);
    const inheritedThread = parseTelegramMessageThreadId(inheritedThreadId);
    const observedBinding = normalizeTelegramMessageThreadBinding(threadBinding);
    const threadId =
      mode === "authoritative"
        ? (observedBinding?.threadSpec.id ?? inheritedThread ?? embeddedThreadId)
        : (embeddedThreadId ?? inheritedThread);
    const matchingBinding =
      observedBinding?.threadSpec.id === threadId ? observedBinding : undefined;
    const node = normalizeMessageNode(message, {
      ...(threadId !== undefined ? { threadId } : {}),
      ...(promptContextProjectionMarker ? { promptContextProjectionMarker } : {}),
      ...(resolvedMedia ? { resolvedMedia } : {}),
      ...(matchingBinding ? { threadBinding: matchingBinding } : {}),
    });
    if (visited.has(node.messageId)) {
      return;
    }
    visited.add(node.messageId);
    const replyMessage = resolveEmbeddedReplyMessage(message);
    if (replyMessage?.message_id != null) {
      visit(
        replyMessage,
        nodeThreadId(node) ?? inheritedThreadId,
        "partial",
        undefined,
        node.threadBinding,
        undefined,
      );
    }
    observations.push({ node, mode });
  };
  visit(
    msg,
    params.threadId,
    "authoritative",
    params.promptContextProjectionMarker,
    params.threadBinding,
    params.resolvedMedia,
  );
  return observations;
}

export function parseSafeMessageId(value: string | undefined): number | undefined {
  return value === undefined ? undefined : parseStrictPositiveInteger(value);
}

function parsePersistedCacheValue(key: string, value: unknown) {
  if (
    !isRecord(value) ||
    (value.version !== undefined && value.version !== TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION)
  ) {
    return [];
  }
  const separatorIndex = key.lastIndexOf(":");
  if (separatorIndex === -1 || !isTelegramMessageCacheSourceMessage(value.sourceMessage)) {
    return [];
  }
  const threadId = parseTelegramMessageThreadId(value.threadId);
  const botUserId = parseStrictPositiveInteger(value.botUserId);
  const promptContextProjectionMarker =
    value.version === TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION &&
    isTelegramMessageFromCurrentBot(value.sourceMessage, botUserId)
      ? parseTelegramPromptContextProjection(value.promptContextProjection)
      : undefined;
  const threadBinding =
    value.version === TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION
      ? normalizeTelegramMessageThreadBinding(value.threadBinding)
      : undefined;
  const resolvedMedia = parseTelegramResolvedMedia(value.resolvedMedia);
  return normalizeMessageNodes(value.sourceMessage, {
    chatId: value.sourceMessage.chat.id,
    ...(threadId !== undefined ? { threadId } : {}),
    ...(promptContextProjectionMarker ? { promptContextProjectionMarker } : {}),
    ...(threadBinding ? { threadBinding } : {}),
    ...(resolvedMedia ? { resolvedMedia } : {}),
  }).map(({ node, mode }) => ({
    key: `${key.slice(0, separatorIndex + 1)}${node.messageId}`,
    node,
    mode,
  }));
}

export function trimMessages(
  messages: Map<string, TelegramCachedMessageNode>,
  maxMessages: number,
): void {
  while (messages.size > maxMessages) {
    const oldest = messages.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    messages.delete(oldest);
  }
}

function mergeTelegramSourceMessage(existing: Message, incoming: Message): Message {
  const existingReply = resolveEmbeddedReplyMessage(existing);
  const incomingReply = resolveEmbeddedReplyMessage(incoming);
  if (existingReply?.message_id != null && incomingReply?.message_id === existingReply.message_id) {
    return Object.assign({}, existing, incoming, {
      reply_to_message: mergeTelegramSourceMessage(existingReply, incomingReply),
    });
  }
  return Object.assign({}, existing, incoming);
}

function mergeAuthoritativeTelegramSourceMessage(existing: Message, incoming: Message): Message {
  const existingReply = resolveEmbeddedReplyMessage(existing);
  const incomingReply = resolveEmbeddedReplyMessage(incoming);
  if (existingReply?.message_id != null && incomingReply?.message_id === existingReply.message_id) {
    return Object.assign({}, incoming, {
      reply_to_message: mergeTelegramSourceMessage(existingReply, incomingReply),
    });
  }
  return incoming;
}

function mergeCachedMessageNode(
  existing: TelegramCachedMessageNode,
  incoming: TelegramCachedMessageNode,
  mode: TelegramMessageObservationMode,
): TelegramCachedMessageNode {
  const mergedSourceMessage =
    mode === "authoritative"
      ? mergeAuthoritativeTelegramSourceMessage(existing.sourceMessage, incoming.sourceMessage)
      : mergeTelegramSourceMessage(existing.sourceMessage, incoming.sourceMessage);
  const syntheticOutboundFrom =
    existing.senderId === "0" && incoming.sourceMessage.sender_chat
      ? existing.sourceMessage.from
      : undefined;
  // sender_chat pairs with a fake `from`; preserve our outbound-only id=0 sentinel.
  const sourceMessage: Message = syntheticOutboundFrom
    ? { ...mergedSourceMessage, from: syntheticOutboundFrom }
    : mergedSourceMessage;
  const promptContextProjectionMarker =
    incoming.promptContextProjectionMarker ?? existing.promptContextProjectionMarker;
  const threadBinding =
    normalizeTelegramMessageThreadBinding(incoming.threadBinding) ??
    normalizeTelegramMessageThreadBinding(existing.threadBinding);
  const threadId = parseTelegramMessageThreadId(
    threadBinding?.threadSpec.id ?? incoming.threadId ?? existing.threadId,
  );
  const primaryMedia = resolveTelegramPrimaryMedia(sourceMessage);
  const resolvedMedia =
    existing.resolvedMedia?.fileUniqueId === primaryMedia?.fileRef.file_unique_id
      ? existing.resolvedMedia
      : undefined;
  return normalizeMessageNode(sourceMessage, {
    ...(threadId !== undefined ? { threadId } : {}),
    ...(promptContextProjectionMarker ? { promptContextProjectionMarker } : {}),
    ...(threadBinding ? { threadBinding } : {}),
    ...(resolvedMedia ? { resolvedMedia } : {}),
  });
}

export function upsertCachedMessageNode(params: {
  messages: Map<string, TelegramCachedMessageNode>;
  key: string;
  node: TelegramCachedMessageNode;
  mode: TelegramMessageObservationMode;
}): TelegramCachedMessageNode {
  const existing = params.messages.get(params.key);
  const node = existing ? mergeCachedMessageNode(existing, params.node, params.mode) : params.node;
  params.messages.delete(params.key);
  params.messages.set(params.key, node);
  return node;
}

export function resolveDefaultPersistentStore(): TelegramMessageCachePersistentStore | undefined {
  const runtime = getOptionalTelegramRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    return runtime.state.openKeyedStore<PersistedTelegramMessageCacheEntry>({
      namespace: TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
      maxEntries: TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
    });
  } catch (error) {
    logVerbose(`telegram: failed to open message cache plugin state: ${String(error)}`);
    return undefined;
  }
}

export function resolveDefaultPrivacyStore(params: {
  requiredForPersistentMessageCache: boolean;
}): TelegramMessagePrivacyPersistentStore | undefined {
  const runtime = getOptionalTelegramRuntime();
  if (!runtime) {
    if (params.requiredForPersistentMessageCache) {
      throw new Error(
        "Telegram message privacy state is unavailable while message cache persistence is enabled",
      );
    }
    return undefined;
  }
  try {
    return runtime.state.openKeyedStore<PersistedTelegramMessagePrivacyEntry>({
      namespace: TELEGRAM_MESSAGE_PRIVACY_PERSISTENT_NAMESPACE,
      maxEntries: TELEGRAM_MESSAGE_PRIVACY_PERSISTENT_MAX_ENTRIES,
    });
  } catch (error) {
    logVerbose(`telegram: failed to open message privacy state: ${String(error)}`);
    if (params.requiredForPersistentMessageCache) {
      throw error;
    }
    return undefined;
  }
}

export function resolveMessageCacheBucket(params: {
  bucketKey?: string;
  persistentStore?: TelegramMessageCachePersistentStore;
  privacyStore?: TelegramMessagePrivacyPersistentStore;
}): TelegramMessageCacheBucket {
  const { bucketKey } = params;
  if (!bucketKey) {
    return {
      messages: new Map<string, TelegramCachedMessageNode>(),
      ignoredMessages: new Set<string>(),
      ignoredMediaGroups: new Set<string>(),
      privacyIdentities: new Map(),
      hydrated: true,
      ...(params.privacyStore ? { privacyStore: params.privacyStore } : {}),
    };
  }
  const persistedMessageCacheBuckets = getPersistedMessageCacheBuckets();
  const existing = persistedMessageCacheBuckets.get(bucketKey);
  if (existing) {
    existing.persistentStore = params.persistentStore ?? existing.persistentStore;
    existing.privacyStore = params.privacyStore ?? existing.privacyStore;
    return existing;
  }
  const bucket = {
    messages: new Map<string, TelegramCachedMessageNode>(),
    ignoredMessages: new Set<string>(),
    ignoredMediaGroups: new Set<string>(),
    privacyIdentities: new Map(),
    hydrated: false,
    ...(params.persistentStore ? { persistentStore: params.persistentStore } : {}),
    ...(params.privacyStore ? { privacyStore: params.privacyStore } : {}),
  };
  persistedMessageCacheBuckets.set(bucketKey, bucket);
  return bucket;
}

export async function hydrateMessageCacheBucket(
  bucket: TelegramMessageCacheBucket,
  maxMessages: number,
  scopeKey?: string,
): Promise<void> {
  if (bucket.hydrated) {
    return;
  }
  if (bucket.hydratePromise) {
    await bucket.hydratePromise;
    return;
  }
  bucket.hydratePromise = (async () => {
    let storeEntries: Array<{ key: string; value: unknown }> = [];
    let privacyEntries: Array<{ key: string; value: unknown }>;
    try {
      storeEntries = (await bucket.persistentStore?.entries()) ?? [];
    } catch (error) {
      logVerbose(`telegram: failed to hydrate message cache from plugin state: ${String(error)}`);
    }
    try {
      privacyEntries = (await bucket.privacyStore?.entries()) ?? [];
    } catch (error) {
      logVerbose(`telegram: failed to hydrate message privacy state: ${String(error)}`);
      // Message rows are unsafe to expose when their authoritative revocations cannot be read.
      throw error;
    }
    const scopedStoreEntries = scopeKey
      ? storeEntries.filter(({ key }) => key.startsWith(`${scopeKey}:`))
      : storeEntries;
    const scopedPrivacyEntries = scopeKey
      ? privacyEntries.filter(({ key }) => key.startsWith(`${scopeKey}:`))
      : privacyEntries;

    const ignoredMessages = scopedPrivacyEntries.flatMap(({ value }) => {
      const ignored = parsePersistedTelegramIgnoredMessage(value);
      return ignored ? [ignored] : [];
    });
    const ignoredMediaGroups = [
      ...scopedPrivacyEntries,
      // Read the shipped legacy location so existing revocations survive the namespace split.
      ...scopedStoreEntries,
    ].flatMap(({ value }) => {
      const ignored = parsePersistedTelegramIgnoredMediaGroup(value);
      return ignored ? [ignored] : [];
    });
    for (const ignored of ignoredMessages) {
      registerPrivacyIdentity(bucket, {
        kind: "ignored-message",
        identity: telegramIgnoredMessageIdentity(ignored),
      });
    }
    for (const ignored of ignoredMediaGroups) {
      registerPrivacyIdentity(bucket, {
        kind: "ignored-media-group",
        identity: telegramIgnoredMediaGroupIdentity(ignored),
      });
    }

    // Migrate legacy album markers into the independent privacy LRU opportunistically.
    if (bucket.privacyStore) {
      for (const { key, value } of scopedStoreEntries) {
        const ignored = parsePersistedTelegramIgnoredMediaGroup(value);
        if (!ignored) {
          continue;
        }
        try {
          await bucket.privacyStore.register(
            telegramIgnoredMediaGroupKey({ scopeKey, ...ignored }),
            ignored,
          );
          await bucket.persistentStore?.delete(key);
        } catch (error) {
          logVerbose(`telegram: failed to migrate ignored album privacy state: ${String(error)}`);
        }
      }
    }

    for (const { key, value } of scopedStoreEntries) {
      if (parsePersistedTelegramIgnoredMediaGroup(value)) {
        continue;
      }
      if (!isRecord(value) || !isTelegramMessageCacheSourceMessage(value.sourceMessage)) {
        continue;
      }
      const relevantIgnoredMessages = ignoredMessages.filter((ignored) =>
        key.startsWith(
          telegramMessageCacheKeyPrefix({
            scopeKey,
            accountId: ignored.accountId,
            chatId: ignored.chatId,
          }),
        ),
      );
      const relevantIgnoredMediaGroups = ignoredMediaGroups.filter((ignored) =>
        key.startsWith(
          telegramMessageCacheKeyPrefix({
            scopeKey,
            accountId: ignored.accountId,
            chatId: ignored.chatId,
          }),
        ),
      );
      const ignoredMessageIds = new Set(
        relevantIgnoredMessages.map((ignored) => ignored.messageId),
      );
      const ignoredMediaGroupIds = new Set(
        relevantIgnoredMediaGroups.map((ignored) => ignored.mediaGroupId),
      );
      const sourceMessage = value.sourceMessage;
      const sourceIsIgnored =
        ignoredMessageIds.has(String(sourceMessage.message_id)) ||
        (typeof sourceMessage.media_group_id === "string" &&
          ignoredMediaGroupIds.has(sourceMessage.media_group_id));
      if (sourceIsIgnored) {
        try {
          await bucket.persistentStore?.delete(key);
        } catch (error) {
          logVerbose(`telegram: failed to purge ignored hydrated message: ${String(error)}`);
        }
        continue;
      }
      const detachedSourceMessage = detachReplyTargetsByPrivacy(sourceMessage, {
        chatId: sourceMessage.chat.id,
        ignoredMessageIds,
        ignoredMediaGroupIds,
      });
      if (detachedSourceMessage !== sourceMessage) {
        try {
          const scrubbedValue = {
            ...value,
            sourceMessage: detachedSourceMessage,
          };
          await bucket.persistentStore?.register(
            key,
            // SAFETY: hydration validated the source Message; replacement preserves other fields.
            scrubbedValue as PersistedTelegramMessageCacheEntry,
          );
        } catch (error) {
          logVerbose(`telegram: failed to scrub ignored hydrated reply: ${String(error)}`);
        }
      }
      for (const entry of parsePersistedCacheValue(key, {
        ...value,
        sourceMessage: detachedSourceMessage,
      })) {
        upsertCachedMessageNode({
          messages: bucket.messages,
          key: entry.key,
          node: entry.node,
          mode: entry.mode,
        });
        trimMessages(bucket.messages, maxMessages);
      }
    }
    bucket.hydrated = true;
  })().finally(() => {
    bucket.hydratePromise = undefined;
  });
  await bucket.hydratePromise;
}

export async function persistCachedNode(params: {
  bucket: TelegramMessageCacheBucket;
  key: string;
  node: TelegramCachedMessageNode;
  botUserId?: number;
}): Promise<void> {
  const { persistentStore } = params.bucket;
  if (!persistentStore) {
    return;
  }
  try {
    const marker = params.node.promptContextProjectionMarker;
    const promptContextProjection =
      marker?.kind === "valid"
        ? marker.projection
        : marker
          ? { transcriptMessageId: marker.transcriptMessageId }
          : undefined;
    await persistentStore.register(params.key, {
      version: TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION,
      sourceMessage: params.node.sourceMessage,
      ...(params.botUserId !== undefined ? { botUserId: params.botUserId } : {}),
      ...(promptContextProjection ? { promptContextProjection } : {}),
      ...(params.node.resolvedMedia ? { resolvedMedia: params.node.resolvedMedia } : {}),
      ...(params.node.threadBinding ? { threadBinding: params.node.threadBinding } : {}),
      ...(params.node.threadId ? { threadId: params.node.threadId } : {}),
    });
  } catch (error) {
    logVerbose(`telegram: failed to persist message cache: ${String(error)}`);
    const marker = params.node.promptContextProjectionMarker;
    if (marker) {
      params.node.promptContextProjectionMarker = {
        kind: "invalid",
        transcriptMessageId:
          marker.kind === "valid"
            ? marker.projection.transcriptMessageId
            : marker.transcriptMessageId,
      };
      throw error;
    }
  }
}
