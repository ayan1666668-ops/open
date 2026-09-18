import type { Message } from "grammy/types";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import type { TelegramMediaKind, TelegramThreadSpec } from "./bot/helpers.js";
import type {
  PersistedTelegramMessageCacheEntry,
  PersistedTelegramMessagePrivacyEntry,
  TelegramMessageThreadBinding,
  TelegramResolvedMedia,
} from "./message-cache-persistence.js";
import type {
  TelegramPromptContextProjection,
  TelegramPromptContextProjectionMarker,
} from "./prompt-context-projection.js";

export type TelegramReplyChainEntry = NonNullable<MsgContext["ReplyChain"]>[number] & {
  mediaKind?: TelegramMediaKind;
};

export type TelegramCachedMessageNode = Omit<TelegramReplyChainEntry, "messageId"> & {
  messageId: string;
  resolvedMedia?: TelegramResolvedMedia;
  sourceMessage: Message;
  promptContextProjectionMarker?: TelegramPromptContextProjectionMarker;
  threadBinding?: TelegramMessageThreadBinding;
};

export type TelegramConversationContextNode = {
  node: TelegramCachedMessageNode;
  isReplyTarget?: boolean;
};

export type TelegramMessageCache = {
  record: (params: {
    accountId: string;
    chatId: string | number;
    msg: Message;
    botUserId?: number;
    botUsername?: string;
    promptContextProjection?: TelegramPromptContextProjection;
    /** Set only while recording an authenticated provider event or response. */
    providerObservedThread?: TelegramThreadSpec;
    threadId?: number;
  }) => Promise<TelegramCachedMessageNode>;
  recordResolvedMedia: (params: {
    accountId: string;
    botUserId?: number;
    chatId: string | number;
    messageId: string;
    media: TelegramResolvedMedia & { path?: string; fileName?: string };
  }) => Promise<void>;
  remove: (params: {
    accountId: string;
    chatId: string | number;
    messageId: string;
    mediaGroupId?: string;
  }) => Promise<boolean>;
  isIgnored: (params: {
    accountId: string;
    chatId: string | number;
    messageId: string;
    mediaGroupId?: string;
  }) => Promise<boolean>;
  get: (params: {
    accountId: string;
    chatId: string | number;
    messageId?: string;
  }) => Promise<TelegramCachedMessageNode | null>;
  recentBefore: (params: {
    accountId: string;
    chatId: string | number;
    messageId?: string;
    threadId?: number;
    limit: number;
  }) => Promise<TelegramCachedMessageNode[]>;
  around: (params: {
    accountId: string;
    chatId: string | number;
    messageId?: string;
    threadId?: number;
    before: number;
    after: number;
  }) => Promise<TelegramCachedMessageNode[]>;
  latestMatchingAtOrBefore: (params: {
    accountId: string;
    chatId: string | number;
    messageId?: string;
    threadId?: number;
    matches: (node: TelegramCachedMessageNode) => boolean;
  }) => Promise<TelegramCachedMessageNode | null>;
};

export type TelegramMessageCachePersistentStore = {
  register(key: string, value: PersistedTelegramMessageCacheEntry): Promise<void>;
  lookup(key: string): Promise<PersistedTelegramMessageCacheEntry | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<Array<{ key: string; value: unknown }>>;
};

export type TelegramMessagePrivacyPersistentStore = {
  register(key: string, value: PersistedTelegramMessagePrivacyEntry): Promise<void>;
  lookup(key: string): Promise<PersistedTelegramMessagePrivacyEntry | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<Array<{ key: string; value: unknown }>>;
};

export type TelegramMessageCacheBucket = {
  messages: Map<string, TelegramCachedMessageNode>;
  ignoredMessages: Set<string>;
  ignoredMediaGroups: Set<string>;
  privacyIdentities: Map<
    string,
    { kind: "ignored-message" | "ignored-media-group"; identity: string }
  >;
  hydrated: boolean;
  hydratePromise?: Promise<void>;
  persistentStore?: TelegramMessageCachePersistentStore;
  privacyStore?: TelegramMessagePrivacyPersistentStore;
};

export type TelegramMessageObservationMode = "authoritative" | "partial";

export type TelegramCachedMessageObservation = {
  node: TelegramCachedMessageNode;
  mode: TelegramMessageObservationMode;
};
