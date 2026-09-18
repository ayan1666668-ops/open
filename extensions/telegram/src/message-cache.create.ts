import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveTelegramPrimaryMedia } from "./bot/body-helpers.js";
import {
  isTelegramMessageCacheSourceMessage,
  resolveTelegramMessageCachePersistentScopeKey,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
  TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION,
} from "./message-cache-persistence.js";
import { compareCachedMessageNodes } from "./message-cache.context.js";
import {
  createTelegramMessageThreadBinding,
  DEFAULT_MAX_MESSAGES,
  hydrateMessageCacheBucket,
  isTelegramMessageFromCurrentBot,
  normalizeMessageNode,
  normalizeMessageNodes,
  parseSafeMessageId,
  persistCachedNode,
  PERSISTENT_BUCKET_KEY,
  resolveDefaultPersistentStore,
  resolveDefaultPrivacyStore,
  resolveMessageCacheBucket,
  telegramMessageCacheKey,
  telegramMessageCacheKeyPrefix,
  trimMessages,
  upsertCachedMessageNode,
} from "./message-cache.core.js";
import {
  detachReplyTargetsById,
  readIgnoredMediaGroupIds,
  readIgnoredMessageIds,
  registerPrivacyIdentity,
  telegramIgnoredMediaGroupIdentity,
  telegramIgnoredMediaGroupKey,
  telegramIgnoredMessageIdentity,
  telegramIgnoredMessageKey,
} from "./message-cache.privacy.js";
import type {
  TelegramCachedMessageNode,
  TelegramMessageCache,
  TelegramMessageCachePersistentStore,
  TelegramMessagePrivacyPersistentStore,
} from "./message-cache.types.js";
import { parseTelegramMessageThreadId } from "./outbound-params.js";

export function createTelegramMessageCache(params?: {
  maxMessages?: number;
  scope?: string;
  persistentStore?: TelegramMessageCachePersistentStore;
  privacyStore?: TelegramMessagePrivacyPersistentStore;
  bucketKey?: string;
  botUsername?: string;
  ignoreEnabled?: boolean;
}): TelegramMessageCache {
  const botUsername = params?.botUsername;
  const ignoreEnabled = params?.ignoreEnabled !== false;
  const persistentStore = params?.persistentStore ?? resolveDefaultPersistentStore();
  const privacyStore =
    params?.privacyStore ??
    resolveDefaultPrivacyStore({
      requiredForPersistentMessageCache: persistentStore !== undefined,
    });
  const maxMessages =
    params?.maxMessages ??
    (persistentStore ? TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES : DEFAULT_MAX_MESSAGES);
  const scopeKey =
    persistentStore || privacyStore
      ? resolveTelegramMessageCachePersistentScopeKey(params?.scope ?? "default")
      : undefined;
  const bucketKey =
    params?.bucketKey ??
    (persistentStore || privacyStore ? `${PERSISTENT_BUCKET_KEY}:${scopeKey}` : undefined);
  const bucket = resolveMessageCacheBucket({
    bucketKey,
    ...(persistentStore ? { persistentStore } : {}),
    ...(privacyStore ? { privacyStore } : {}),
  });
  const { messages } = bucket;

  const isIgnored: TelegramMessageCache["isIgnored"] = async ({
    accountId,
    chatId,
    messageId,
    mediaGroupId,
  }) => {
    await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey);
    if (
      bucket.ignoredMessages.has(telegramIgnoredMessageIdentity({ accountId, chatId, messageId }))
    ) {
      return true;
    }
    return mediaGroupId
      ? bucket.ignoredMediaGroups.has(
          telegramIgnoredMediaGroupIdentity({ accountId, chatId, mediaGroupId }),
        )
      : false;
  };

  const get: TelegramMessageCache["get"] = async ({ accountId, chatId, messageId }) => {
    await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey);
    if (!messageId) {
      return null;
    }
    const key = telegramMessageCacheKey({ scopeKey, accountId, chatId, messageId });
    const entry = messages.get(key);
    if (!entry) {
      return null;
    }
    messages.delete(key);
    messages.set(key, entry);
    return entry;
  };

  const listChatMessages = async (paramsLocal: {
    accountId: string;
    chatId: string | number;
    threadId?: number;
  }) => {
    await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey);
    const prefix = telegramMessageCacheKeyPrefix({ scopeKey, ...paramsLocal });
    const normalizedThreadId = parseTelegramMessageThreadId(paramsLocal.threadId);
    if (paramsLocal.threadId != null && normalizedThreadId === undefined) {
      return [];
    }
    const threadId = normalizedThreadId !== undefined ? String(normalizedThreadId) : undefined;
    return Array.from(messages, ([key, node]) => ({ key, node }))
      .filter(({ key, node }) => {
        if (!key.startsWith(prefix)) {
          return false;
        }
        return threadId === undefined || node.threadId === threadId;
      })
      .map(({ node }) => node)
      .toSorted(compareCachedMessageNodes);
  };

  const detachCachedReplyDescendants = (
    prefix: string,
    messageIds: ReadonlySet<string>,
    chatId: string | number,
  ): boolean => {
    let removed = false;
    for (const [cachedKey, node] of messages) {
      if (!cachedKey.startsWith(prefix)) {
        continue;
      }
      const sourceMessage = detachReplyTargetsById(node.sourceMessage, messageIds, chatId);
      if (sourceMessage === node.sourceMessage) {
        continue;
      }
      const threadId = parseTelegramMessageThreadId(node.threadId);
      messages.set(
        cachedKey,
        normalizeMessageNode(sourceMessage, {
          ...(threadId !== undefined ? { threadId } : {}),
          ...(node.promptContextProjectionMarker
            ? { promptContextProjectionMarker: node.promptContextProjectionMarker }
            : {}),
          ...(node.resolvedMedia ? { resolvedMedia: node.resolvedMedia } : {}),
          ...(node.threadBinding ? { threadBinding: node.threadBinding } : {}),
        }),
      );
      removed = true;
    }
    return removed;
  };

  return {
    record: async ({
      accountId,
      botUserId,
      botUsername: observedBotUsername,
      chatId,
      msg,
      promptContextProjection,
      providerObservedThread,
      threadId,
    }) => {
      const effectiveBotUsername = observedBotUsername ?? botUsername;
      await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey);
      const ignoredMessageIds = readIgnoredMessageIds({ bucket, accountId, chatId });
      const ignoredMediaGroupIds = readIgnoredMediaGroupIds({ bucket, accountId, chatId });
      const threadBinding = createTelegramMessageThreadBinding(providerObservedThread);
      const observations = normalizeMessageNodes(msg, {
        chatId,
        threadId,
        ...(promptContextProjection && isTelegramMessageFromCurrentBot(msg, botUserId)
          ? {
              promptContextProjectionMarker: {
                kind: "valid",
                projection: promptContextProjection,
              },
            }
          : {}),
        ...(threadBinding ? { threadBinding } : {}),
        ...(effectiveBotUsername ? { botUsername: effectiveBotUsername } : {}),
        ignoreEnabled,
        ignoredMessageIds,
        ignoredMediaGroupIds,
      });
      const currentObservation = observations.at(-1)!;
      let recordedEntry = currentObservation.node;
      for (const { node, mode } of observations) {
        const { messageId } = node;
        if (
          ignoredMessageIds.has(messageId) ||
          (typeof node.sourceMessage.media_group_id === "string" &&
            ignoredMediaGroupIds.has(node.sourceMessage.media_group_id))
        ) {
          continue;
        }
        const key = telegramMessageCacheKey({ scopeKey, accountId, chatId, messageId });
        const cachedNode = upsertCachedMessageNode({ messages, key, node, mode });
        if (messageId === currentObservation.node.messageId) {
          recordedEntry = cachedNode;
        }
        trimMessages(messages, maxMessages);
        await persistCachedNode({
          bucket,
          key,
          node: cachedNode,
          ...(botUserId !== undefined ? { botUserId } : {}),
        });
      }
      return recordedEntry;
    },
    recordResolvedMedia: async ({ accountId, botUserId, chatId, messageId, media }) => {
      await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey);
      const key = telegramMessageCacheKey({ scopeKey, accountId, chatId, messageId });
      const node = messages.get(key);
      if (!node) {
        throw new Error(`Telegram message ${messageId} was not recorded before media resolution`);
      }
      const fileUniqueId = resolveTelegramPrimaryMedia(node.sourceMessage)?.fileRef.file_unique_id;
      if (fileUniqueId !== media.fileUniqueId) {
        throw new Error(`Telegram message ${messageId} media changed during resolution`);
      }
      // Runtime downloads carry private paths/names; cache only the existing persisted projection.
      const { path: _path, fileName: _fileName, ...resolvedMedia } = media;
      const resolvedNode = { ...node, resolvedMedia };
      messages.delete(key);
      messages.set(key, resolvedNode);
      await persistCachedNode({
        bucket,
        key,
        node: resolvedNode,
        ...(botUserId !== undefined ? { botUserId } : {}),
      });
    },
    remove: async ({ accountId, chatId, messageId, mediaGroupId }) => {
      await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey);
      const prefix = telegramMessageCacheKeyPrefix({ scopeKey, accountId, chatId });
      const messageIds = new Set([messageId]);
      const ignoredMessageIdentity = telegramIgnoredMessageIdentity({
        accountId,
        chatId,
        messageId,
      });
      const ignoredMediaGroupIdentity = mediaGroupId
        ? telegramIgnoredMediaGroupIdentity({ accountId, chatId, mediaGroupId })
        : undefined;
      // Revoke live context synchronously before any durable I/O yields.
      if (ignoredMediaGroupIdentity) {
        registerPrivacyIdentity(bucket, {
          kind: "ignored-media-group",
          identity: ignoredMediaGroupIdentity,
        });
      }
      registerPrivacyIdentity(bucket, {
        kind: "ignored-message",
        identity: ignoredMessageIdentity,
      });
      // Album members are separate reply nodes but one prompt event. Ignoring any member must
      // remove the whole album and every embedded reply path that could restore it.
      if (mediaGroupId) {
        for (const [cachedKey, node] of messages) {
          if (cachedKey.startsWith(prefix) && node.sourceMessage.media_group_id === mediaGroupId) {
            messageIds.add(node.messageId);
          }
        }
      }
      const removeFromMemory = () => {
        const initialSize = messages.size;
        for (const targetId of messageIds) {
          messages.delete(
            telegramMessageCacheKey({ scopeKey, accountId, chatId, messageId: targetId }),
          );
        }
        return (
          detachCachedReplyDescendants(prefix, messageIds, chatId) || messages.size !== initialSize
        );
      };
      // No concurrent prompt-context read may observe an authorized revocation while its durable
      // tombstone is waiting on storage. A second pass below covers album ids found only on disk.
      const removedFromMemory = removeFromMemory();
      let removed = removedFromMemory;
      const errors: unknown[] = [];
      if (bucket.privacyStore) {
        if (mediaGroupId) {
          try {
            await bucket.privacyStore.register(
              telegramIgnoredMediaGroupKey({ scopeKey, accountId, chatId, mediaGroupId }),
              {
                version: TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION,
                kind: "ignored-media-group",
                accountId,
                chatId: String(chatId),
                mediaGroupId,
              },
            );
            removed = true;
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await bucket.privacyStore.register(
            telegramIgnoredMessageKey({ scopeKey, accountId, chatId, messageId }),
            {
              version: TELEGRAM_MESSAGE_CACHE_PERSISTED_VERSION,
              kind: "ignored-message",
              accountId,
              chatId: String(chatId),
              messageId,
            },
          );
          removed = true;
        } catch (error) {
          errors.push(error);
        }
      }
      if (bucket.persistentStore) {
        let persistedEntries:
          | Awaited<ReturnType<TelegramMessageCachePersistentStore["entries"]>>
          | undefined;
        try {
          persistedEntries = await bucket.persistentStore.entries();
        } catch (error) {
          errors.push(error);
        }
        if (mediaGroupId && persistedEntries) {
          for (const { key: persistedKey, value } of persistedEntries) {
            if (!persistedKey.startsWith(prefix) || !isRecord(value)) {
              continue;
            }
            const sourceMessage = value.sourceMessage;
            if (
              isTelegramMessageCacheSourceMessage(sourceMessage) &&
              sourceMessage.media_group_id === mediaGroupId
            ) {
              messageIds.add(String(sourceMessage.message_id));
            }
          }
        }
        const targetKeys = new Set(
          Array.from(messageIds, (targetId) =>
            telegramMessageCacheKey({ scopeKey, accountId, chatId, messageId: targetId }),
          ),
        );
        const descendantKeys =
          persistedEntries
            ?.filter(({ key: persistedKey, value }) => {
              if (
                targetKeys.has(persistedKey) ||
                !persistedKey.startsWith(prefix) ||
                !isRecord(value)
              ) {
                return false;
              }
              const sourceMessage = value.sourceMessage;
              return (
                isTelegramMessageCacheSourceMessage(sourceMessage) &&
                detachReplyTargetsById(sourceMessage, messageIds, chatId) !== sourceMessage
              );
            })
            .map(({ key: persistedKey }) => persistedKey) ?? [];
        for (const descendantKey of descendantKeys) {
          let current: Awaited<ReturnType<TelegramMessageCachePersistentStore["lookup"]>>;
          try {
            current = await bucket.persistentStore.lookup(descendantKey);
          } catch (error) {
            errors.push(error);
            continue;
          }
          if (
            !current ||
            !("sourceMessage" in current) ||
            !isTelegramMessageCacheSourceMessage(current.sourceMessage)
          ) {
            continue;
          }
          const sourceMessage = detachReplyTargetsById(current.sourceMessage, messageIds, chatId);
          if (sourceMessage === current.sourceMessage) {
            continue;
          }
          try {
            await bucket.persistentStore.register(descendantKey, { ...current, sourceMessage });
            removed = true;
          } catch (error) {
            errors.push(error);
          }
        }
        for (const targetKey of targetKeys) {
          try {
            removed = (await bucket.persistentStore.delete(targetKey)) || removed;
          } catch (error) {
            errors.push(error);
          }
        }
      }

      const removedAfterPersistence = removeFromMemory() || removed;
      if (errors.length > 0) {
        const error =
          errors.length === 1
            ? errors[0]
            : new AggregateError(errors, "Telegram message privacy cleanup failed");
        logVerbose(`telegram: failed to remove message from persistent cache: ${String(error)}`);
        throw error;
      }
      return removedAfterPersistence;
    },
    isIgnored,
    get,
    recentBefore: async ({ accountId, chatId, messageId, threadId, limit }) => {
      if (!messageId || limit <= 0) {
        return [];
      }
      const targetId = parseSafeMessageId(messageId);
      if (targetId === undefined) {
        return [];
      }
      return (await listChatMessages({ accountId, chatId, threadId }))
        .filter((entry) => {
          const entryId = parseSafeMessageId(entry.messageId);
          return entryId !== undefined && entryId < targetId;
        })
        .slice(-limit);
    },
    around: async ({ accountId, chatId, messageId, threadId, before, after }) => {
      if (!messageId) {
        return [];
      }
      const entries = await listChatMessages({ accountId, chatId, threadId });
      const targetIndex = entries.findIndex((entry) => entry.messageId === messageId);
      if (targetIndex === -1) {
        return [];
      }
      return entries.slice(
        Math.max(0, targetIndex - Math.max(0, before)),
        targetIndex + Math.max(0, after) + 1,
      );
    },
    latestMatchingAtOrBefore: async ({ accountId, chatId, messageId, threadId, matches }) => {
      if (!messageId) {
        return null;
      }
      const targetId = parseSafeMessageId(messageId);
      if (targetId === undefined) {
        return null;
      }
      await hydrateMessageCacheBucket(bucket, maxMessages, scopeKey);
      const prefix = telegramMessageCacheKeyPrefix({ scopeKey, accountId, chatId });
      const normalizedThreadId = parseTelegramMessageThreadId(threadId);
      if (threadId != null && normalizedThreadId === undefined) {
        return null;
      }
      const normalizedThread =
        normalizedThreadId !== undefined ? String(normalizedThreadId) : undefined;
      let latest: TelegramCachedMessageNode | null = null;
      for (const [key, entry] of messages) {
        if (!key.startsWith(prefix)) {
          continue;
        }
        if (normalizedThread !== undefined && entry.threadId !== normalizedThread) {
          continue;
        }
        const entryId = parseSafeMessageId(entry.messageId);
        if (entryId === undefined || entryId > targetId || !matches(entry)) {
          continue;
        }
        if (!latest || compareCachedMessageNodes(entry, latest) > 0) {
          latest = entry;
        }
      }
      return latest;
    },
  };
}
