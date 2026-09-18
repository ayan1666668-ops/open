import type { Message } from "grammy/types";
import type { TelegramPendingInboundTarget } from "./bot-handlers.types.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type {
  TelegramAmbientTranscriptWatermark,
  TelegramChannelIngressResolver,
} from "./bot-message-context.types.js";
import type { TelegramSpooledReplayDeferredParticipant } from "./bot-processing-outcome.js";
import type { TelegramThreadSpec } from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import type { TelegramMessageDispatchReplayClaim } from "./message-dispatch-dedupe.js";

export type TelegramDebounceLane = "default" | "forward";

export type TelegramDebounceEntry = {
  ctx: TelegramContext;
  msg: Message;
  allMedia: TelegramMediaRef[];
  storeAllowFrom: string[];
  receivedAtMs: number;
  debounceKey: string | null;
  debounceLane: TelegramDebounceLane;
  botUsername?: string;
  threadSpec: TelegramThreadSpec;
  promptContextMinTimestampMs?: number;
  promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
  dispatchDedupeClaims: TelegramMessageDispatchReplayClaim[];
  spooledReplayParticipant?: TelegramSpooledReplayDeferredParticipant;
  channelIngressResolvers: readonly TelegramChannelIngressResolver[];
  textFragment?: TextFragmentEntry;
  cancelled: boolean;
  dispatchAdmission: "pending" | "admitted" | "cancelled";
  dispatchAbortControllers: Set<AbortController>;
  pendingIgnoreSettlements: Set<Promise<void>>;
};

export type TextFragmentMessage = {
  msg: Message;
  ctx: TelegramContext;
  receivedAtMs: number;
  promptContextMinTimestampMs?: number;
  promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
  dispatchDedupeClaims: TelegramMessageDispatchReplayClaim[];
  spooledReplayParticipant?: TelegramSpooledReplayDeferredParticipant;
  channelIngressResolver: TelegramChannelIngressResolver;
  cancelled: boolean;
  dispatchAdmission: "pending" | "admitted" | "cancelled";
  dispatchAbortControllers: Set<AbortController>;
  pendingIgnoreSettlements: Set<Promise<void>>;
};

export type PendingBufferedMessageIgnore = {
  settle: (authorized: boolean) => boolean;
};

export type TextFragmentEntry = {
  key: string;
  storeAllowFrom: string[];
  messages: TextFragmentMessage[];
  threadSpec: TelegramThreadSpec;
  timer: ReturnType<typeof setTimeout> | null;
  ready: Promise<void>;
  releaseReady: () => void;
  completion: Promise<void>;
  canceled: boolean;
};

export type TelegramTextFragmentInput = {
  ctx: TelegramContext;
  msg: Message;
  chatId: number;
  threadSpec: TelegramThreadSpec;
  storeAllowFrom: string[];
  isAbortControlMessage: boolean;
  promptContextMinTimestampMs?: number;
  promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
  dispatchDedupeClaims: TelegramMessageDispatchReplayClaim[];
  channelIngressResolver: TelegramChannelIngressResolver;
};

export interface TelegramInboundBuffers {
  cancelPending: (target: TelegramPendingInboundTarget) => void;
  inboundDebouncer: {
    enqueue: (entry: TelegramDebounceEntry) => Promise<void>;
    flushKey: (key: string) => Promise<void>;
    cancelKey: (key: string) => boolean;
    drain: () => Promise<void>;
  };
  resolveTelegramDebounceEntryMs: (entry: TelegramDebounceEntry) => number;
  shouldDebounceTelegramEntry: (entry: TelegramDebounceEntry) => boolean;
  resolveTelegramDebounceLane: (msg: Message) => TelegramDebounceLane;
  handleTextFragment: (params: TelegramTextFragmentInput) => Promise<boolean>;
  beginPendingBufferedMessageIgnore: (msg: Message) => PendingBufferedMessageIgnore | undefined;
}
