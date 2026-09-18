import type { Message } from "grammy/types";
import { shouldDebounceTextInbound } from "openclaw/plugin-sdk/channel-inbound";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  buildTelegramInboundDebounceConversationKey,
  buildTelegramInboundDebounceKey,
} from "./bot-handlers.debounce-key.js";
import { createTelegramBufferedDispatchAdmission } from "./bot-handlers.inbound-buffer-admission.js";
import { createTelegramBufferedMessageTracker } from "./bot-handlers.inbound-buffer.tracking.js";
import type {
  TelegramDebounceEntry,
  TelegramDebounceLane,
  TelegramInboundBuffers,
  TelegramTextFragmentInput,
  TextFragmentEntry,
  TextFragmentMessage,
} from "./bot-handlers.inbound-buffer.types.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type {
  RegisterTelegramHandlerParams,
  TelegramPendingInboundTarget,
} from "./bot-handlers.types.js";
import type {
  TelegramMessageProcessingResult,
  TelegramSpooledReplayDeferredParticipant,
} from "./bot-processing-outcome.js";
import {
  buildTelegramThreadParams,
  getTelegramTextParts,
  joinTelegramTextParts,
  type TelegramThreadSpec,
} from "./bot/helpers.js";

export type {
  PendingBufferedMessageIgnore,
  TelegramDebounceEntry,
} from "./bot-handlers.inbound-buffer.types.js";

export function createTelegramInboundBuffers({
  params: { cfg, accountId, bot, runtime, opts, removeMessageFromGroupHistory },
  message,
}: {
  params: Pick<
    RegisterTelegramHandlerParams,
    "cfg" | "accountId" | "bot" | "runtime" | "opts" | "removeMessageFromGroupHistory"
  >;
  message: TelegramMessagePipeline;
}): TelegramInboundBuffers {
  const {
    promptContextBoundaryOptions,
    latestPromptContextMinTimestampMs,
    latestPromptContextAmbientWatermark,
    mergeDispatchDedupeClaims,
    releaseDispatchDedupeClaims,
    buildFailedProcessingResult,
    settleSpooledReplayParticipants,
    createSpooledReplayParticipantForBufferedWork,
    spooledReplayOptions,
    buildSyntheticTextMessage,
    buildSyntheticContext,
    formatTelegramAmbientTranscriptBody,
    processMessageWithReplyChain,
    removeMessageFromReplyChain,
  } = message;
  const readConfig = createRuntimeConfigReader(cfg);
  const resolveDebounceMs = () =>
    resolveInboundDebounceMs({ cfg: readConfig(), channel: "telegram" });
  const FORWARD_BURST_DEBOUNCE_MS = 80;
  const resolveTelegramDebounceEntryMs = (entry: TelegramDebounceEntry): number =>
    entry.debounceLane === "forward" ? FORWARD_BURST_DEBOUNCE_MS : resolveDebounceMs();
  const shouldDebounceTelegramEntry = (entry: TelegramDebounceEntry): boolean => {
    if (entry.textFragment) {
      return false;
    }
    const hasDebounceableText = shouldDebounceTextInbound({
      text: getTelegramTextParts(entry.msg).text,
      cfg,
      commandOptions: { botUsername: entry.botUsername },
    });
    if (entry.debounceLane === "forward") {
      return hasDebounceableText || entry.allMedia.length > 0;
    }
    return hasDebounceableText && entry.allMedia.length === 0;
  };
  const resolveTelegramDebounceLane = (msg: Message): TelegramDebounceLane => {
    const forwardMeta = msg as {
      forward_origin?: unknown;
      forward_from?: unknown;
      forward_from_chat?: unknown;
      forward_sender_name?: unknown;
      forward_date?: unknown;
    };
    return (forwardMeta.forward_origin ??
      forwardMeta.forward_from ??
      forwardMeta.forward_from_chat ??
      forwardMeta.forward_sender_name ??
      forwardMeta.forward_date)
      ? "forward"
      : "default";
  };
  const {
    registerDebounceEntry,
    forgetDebounceEntry,
    registerTextFragment,
    forgetTextFragment,
    waitForPendingIgnore,
    beginPendingBufferedMessageIgnore,
  } = createTelegramBufferedMessageTracker();
  const purgeIgnoredBufferedMessages = async (
    entries: readonly { msg: Message; threadSpec: TelegramThreadSpec }[],
  ) => {
    await Promise.all(
      entries.map(async (entry) => {
        // Context construction records rolling history before final dispatch admission. Repeat the
        // privacy purge here so a late context write cannot race an authorized edited /ignore.
        removeMessageFromGroupHistory(entry.msg, entry.threadSpec);
        try {
          await removeMessageFromReplyChain(entry.msg);
        } catch (error) {
          runtime.error?.(
            danger(`telegram buffered ignore privacy purge failed: ${String(error)}`),
          );
        }
      }),
    );
  };
  const settleCancelledDebounceEntries = async (entries: readonly TelegramDebounceEntry[]) => {
    for (const entry of entries) {
      releaseDispatchDedupeClaims(entry.dispatchDedupeClaims);
      if (entry.spooledReplayParticipant) {
        settleSpooledReplayParticipants([entry.spooledReplayParticipant], { kind: "skipped" });
      }
      forgetDebounceEntry(entry);
    }
    await purgeIgnoredBufferedMessages(entries);
  };
  const inboundDebouncer = createInboundDebouncer<TelegramDebounceEntry>({
    debounceMs: resolveDebounceMs(),
    serializeImmediate: true,
    resolveDebounceMs: resolveTelegramDebounceEntryMs,
    buildKey: (entry) => entry.debounceKey,
    shouldDebounce: shouldDebounceTelegramEntry,
    onFlush: (queuedEntries) => {
      const fragment = queuedEntries[0]?.textFragment;
      if (fragment) {
        const completion = (async () => {
          await fragment.ready;
          if (!fragment.canceled) {
            await flushTextFragments(fragment);
          }
        })();
        return { admission: completion, completion };
      }
      const processEntries = async (candidateEntries: TelegramDebounceEntry[]): Promise<void> => {
        await Promise.all(candidateEntries.map(waitForPendingIgnore));
        const cancelledEntries = candidateEntries.filter((entry) => entry.cancelled);
        await settleCancelledDebounceEntries(cancelledEntries);
        const entries = candidateEntries.filter((entry) => !entry.cancelled);
        const participants = entries
          .map((entry) => entry.spooledReplayParticipant)
          .filter(
            (participant): participant is TelegramSpooledReplayDeferredParticipant =>
              participant !== undefined,
          );
        const last = entries.at(-1);
        if (!last) {
          return;
        }
        const bufferedDispatch = createTelegramBufferedDispatchAdmission(entries);
        let result: TelegramMessageProcessingResult;
        try {
          if (entries.length === 1) {
            result = await processMessageWithReplyChain({
              ctx: last.ctx,
              msg: last.msg,
              allMedia: last.allMedia,
              storeAllowFrom: last.storeAllowFrom,
              options: {
                receivedAtMs: last.receivedAtMs,
                ingressBuffer: "inbound-debounce",
                threadSpec: last.threadSpec,
                ...promptContextBoundaryOptions(
                  last.promptContextMinTimestampMs,
                  last.promptContextAmbientWatermark,
                ),
                ...spooledReplayOptions(participants),
                channelIngressResolvers: last.channelIngressResolvers,
              },
              dispatchDedupeClaims: last.dispatchDedupeClaims,
              spooledReplayParticipants: participants,
              shouldSkipBeforeDispatch: async () => {
                await waitForPendingIgnore(last);
                return last.cancelled;
              },
              deferCancelledBeforeDispatchSettlement: true,
              dispatchAdmission: bufferedDispatch.admission,
            });
          } else {
            const combinedTextParts = joinTelegramTextParts(
              entries.map((entry) => entry.msg),
              "\n",
            );
            const combinedText = combinedTextParts.text;
            const combinedMedia = entries.flatMap((entry) => entry.allMedia);
            if (!combinedText.trim() && combinedMedia.length === 0) {
              releaseDispatchDedupeClaims(
                mergeDispatchDedupeClaims(...entries.map((entry) => entry.dispatchDedupeClaims)),
              );
              settleSpooledReplayParticipants(participants, { kind: "skipped" });
              for (const entry of entries) {
                forgetDebounceEntry(entry);
              }
              return;
            }
            const first = expectDefined(entries.at(0), "multi-entry Telegram debounce batch");
            const syntheticMessage = {
              ...buildSyntheticTextMessage({
                base: first.msg,
                text: combinedText,
                entities: combinedTextParts.entities,
                date: last.msg.date ?? first.msg.date,
              }),
              forward_origin: undefined,
            };
            result = await processMessageWithReplyChain({
              ctx: buildSyntheticContext(first.ctx, syntheticMessage),
              msg: syntheticMessage,
              allMedia: combinedMedia,
              storeAllowFrom: first.storeAllowFrom,
              options: {
                ...(last.msg.message_id ? { messageIdOverride: String(last.msg.message_id) } : {}),
                ambientTranscriptBody: formatTelegramAmbientTranscriptBody(
                  entries.map((entry) => entry.msg),
                ),
                receivedAtMs: first.receivedAtMs,
                ingressBuffer: "inbound-debounce",
                threadSpec: first.threadSpec,
                bufferedMessages: entries.map((entry) => entry.msg),
                ...promptContextBoundaryOptions(
                  latestPromptContextMinTimestampMs(
                    ...entries.map((entry) => entry.promptContextMinTimestampMs),
                  ),
                  latestPromptContextAmbientWatermark(
                    ...entries.map((entry) => entry.promptContextAmbientWatermark),
                  ),
                ),
                ...spooledReplayOptions(participants),
                channelIngressResolvers: entries.flatMap((entry) => entry.channelIngressResolvers),
              },
              dispatchDedupeClaims: mergeDispatchDedupeClaims(
                ...entries.map((entry) => entry.dispatchDedupeClaims),
              ),
              spooledReplayParticipants: participants,
              shouldSkipBeforeDispatch: async () => {
                await Promise.all(entries.map(waitForPendingIgnore));
                return entries.some((entry) => entry.cancelled);
              },
              deferCancelledBeforeDispatchSettlement: true,
              dispatchAdmission: bufferedDispatch.admission,
            });
          }
        } catch (error) {
          await purgeIgnoredBufferedMessages(entries.filter((entry) => entry.cancelled));
          settleSpooledReplayParticipants(participants, buildFailedProcessingResult(error));
          for (const entry of entries) {
            forgetDebounceEntry(entry);
          }
          throw error;
        } finally {
          bufferedDispatch.release();
        }
        if (result.kind === "skipped" && result.reason === "cancelled-before-dispatch") {
          await Promise.all(entries.map(waitForPendingIgnore));
          if (
            entries.some((entry) => entry.cancelled) ||
            bufferedDispatch.wasPausedForPendingIgnore()
          ) {
            try {
              await processEntries(entries);
            } finally {
              for (const entry of entries) {
                forgetDebounceEntry(entry);
              }
            }
            return;
          }
        }
        settleSpooledReplayParticipants(participants, result);
        for (const entry of entries) {
          forgetDebounceEntry(entry);
        }
      };
      const completion = processEntries(queuedEntries);
      // Spooled Telegram processing already returns at durable turn adoption;
      // its participant owns the remaining agent-turn lifecycle.
      return { admission: completion, completion };
    },
    onError: (error, items) => {
      const fragment = items[0]?.textFragment;
      if (fragment) {
        failTextFragments(fragment, error);
        return;
      }
      const participants = items
        .map((item) => item.spooledReplayParticipant)
        .filter(
          (participant): participant is TelegramSpooledReplayDeferredParticipant =>
            participant !== undefined,
        );
      settleSpooledReplayParticipants(participants, buildFailedProcessingResult(error));
      runtime.error?.(danger(`telegram debounce flush failed: ${String(error)}`));
      if (participants.length > 0) {
        return;
      }
      const chatId = items[0]?.msg.chat.id;
      if (chatId != null) {
        const threadParams = buildTelegramThreadParams(items[0]?.threadSpec);
        void bot.api
          .sendMessage(
            chatId,
            "Something went wrong while processing your message. Please try again.",
            threadParams,
          )
          .catch((sendError: unknown) => {
            logVerbose(`telegram: error fallback send failed: ${String(sendError)}`);
          });
      }
    },
    onCancel: (items) => {
      const fragment = items[0]?.textFragment;
      if (fragment) {
        cancelTextFragments(fragment);
        return;
      }
      releaseDispatchDedupeClaims(
        mergeDispatchDedupeClaims(...items.map((item) => item.dispatchDedupeClaims)),
      );
      settleSpooledReplayParticipants(
        items
          .map((item) => item.spooledReplayParticipant)
          .filter(
            (participant): participant is TelegramSpooledReplayDeferredParticipant =>
              participant !== undefined,
          ),
        { kind: "skipped" },
      );
      for (const item of items) {
        forgetDebounceEntry(item);
      }
    },
  });
  const enqueueDebounceEntry = async (entry: TelegramDebounceEntry) => {
    registerDebounceEntry(entry);
    try {
      await inboundDebouncer.enqueue(entry);
    } catch (error) {
      forgetDebounceEntry(entry);
      throw error;
    }
  };

  const maxGapMs =
    typeof opts.testTimings?.textFragmentGapMs === "number" &&
    Number.isFinite(opts.testTimings.textFragmentGapMs)
      ? Math.max(10, Math.floor(opts.testTimings.textFragmentGapMs))
      : 1500;
  const textBuffer = new Map<string, TextFragmentEntry>();
  const pendingTextFragments = new Map<string, Set<TextFragmentEntry>>();

  const untrackTextFragments = (entry: TextFragmentEntry) => {
    const pending = pendingTextFragments.get(entry.key);
    pending?.delete(entry);
    if (pending?.size === 0) {
      pendingTextFragments.delete(entry.key);
    }
  };

  const releaseTextFragments = (entry: TextFragmentEntry) => {
    if (textBuffer.get(entry.key) === entry) {
      textBuffer.delete(entry.key);
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.releaseReady();
  };
  const cancelTextFragments = (entry: TextFragmentEntry) => {
    if (entry.canceled) {
      return;
    }
    entry.canceled = true;
    untrackTextFragments(entry);
    releaseTextFragments(entry);
    for (const fragment of entry.messages) {
      releaseDispatchDedupeClaims(fragment.dispatchDedupeClaims);
      if (fragment.spooledReplayParticipant) {
        settleSpooledReplayParticipants([fragment.spooledReplayParticipant], { kind: "skipped" });
      }
      forgetTextFragment(fragment);
    }
  };
  const failTextFragments = (entry: TextFragmentEntry, error: unknown) => {
    untrackTextFragments(entry);
    releaseTextFragments(entry);
    for (const fragment of entry.messages) {
      releaseDispatchDedupeClaims(fragment.dispatchDedupeClaims, error);
      if (fragment.spooledReplayParticipant) {
        settleSpooledReplayParticipants(
          [fragment.spooledReplayParticipant],
          buildFailedProcessingResult(error),
        );
      }
      forgetTextFragment(fragment);
    }
    runtime.error?.(danger(`text fragment handler failed: ${String(error)}`));
  };

  const textFragmentParticipants = (messages: readonly TextFragmentMessage[]) =>
    messages.flatMap((fragment) =>
      fragment.spooledReplayParticipant ? [fragment.spooledReplayParticipant] : [],
    );
  const settleTextFragments = (messages: readonly TextFragmentMessage[]) => {
    for (const fragment of messages) {
      releaseDispatchDedupeClaims(fragment.dispatchDedupeClaims);
      if (fragment.spooledReplayParticipant) {
        settleSpooledReplayParticipants([fragment.spooledReplayParticipant], { kind: "skipped" });
      }
      forgetTextFragment(fragment);
    }
  };
  const createTextFragmentMessage = (
    params: TelegramTextFragmentInput,
    key: string,
    receivedAtMs: number,
  ): TextFragmentMessage => {
    const fragment: TextFragmentMessage = {
      msg: params.msg,
      ctx: params.ctx,
      receivedAtMs,
      ...promptContextBoundaryOptions(
        params.promptContextMinTimestampMs,
        params.promptContextAmbientWatermark,
      ),
      dispatchDedupeClaims: params.dispatchDedupeClaims,
      spooledReplayParticipant: createSpooledReplayParticipantForBufferedWork(
        `text-fragment:${key}:${params.msg.message_id}`,
      ),
      channelIngressResolver: params.channelIngressResolver,
      cancelled: false,
      dispatchAdmission: "pending",
      dispatchAbortControllers: new Set(),
      pendingIgnoreSettlements: new Set(),
    };
    registerTextFragment(fragment);
    return fragment;
  };

  const flushTextFragments = async (
    entry: TextFragmentEntry,
    candidateMessages: TextFragmentMessage[] = entry.messages,
  ): Promise<void> => {
    // Timer expiry seals collection; only processing releases cancellation ownership.
    untrackTextFragments(entry);
    await Promise.all(candidateMessages.map(waitForPendingIgnore));
    const cancelledMessages = candidateMessages.filter((fragment) => fragment.cancelled);
    settleTextFragments(cancelledMessages);
    await purgeIgnoredBufferedMessages(
      cancelledMessages.map((fragment) => ({ msg: fragment.msg, threadSpec: entry.threadSpec })),
    );
    const messages = candidateMessages.filter((fragment) => !fragment.cancelled);
    const dispatchDedupeClaims = mergeDispatchDedupeClaims(
      ...messages.map((fragment) => fragment.dispatchDedupeClaims),
    );
    const spooledReplayParticipants = textFragmentParticipants(messages);
    const bufferedDispatch = createTelegramBufferedDispatchAdmission(messages);
    try {
      messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
      const bufferedMessages = messages.map((bufferedMessage) => bufferedMessage.msg);
      const first = messages[0];
      const last = messages.at(-1);
      if (!first || !last) {
        return;
      }
      const combinedTextParts = joinTelegramTextParts(bufferedMessages, "");
      const combinedText = combinedTextParts.text;
      if (!combinedText.trim()) {
        releaseDispatchDedupeClaims(dispatchDedupeClaims);
        settleSpooledReplayParticipants(spooledReplayParticipants, { kind: "skipped" });
        for (const fragment of messages) {
          forgetTextFragment(fragment);
        }
        return;
      }
      const syntheticMessage = buildSyntheticTextMessage({
        base: first.msg,
        text: combinedText,
        entities: combinedTextParts.entities,
        date: last.msg.date ?? first.msg.date,
      });
      const result = await processMessageWithReplyChain({
        ctx: buildSyntheticContext(first.ctx, syntheticMessage),
        msg: syntheticMessage,
        allMedia: [],
        storeAllowFrom: entry.storeAllowFrom,
        options: {
          messageIdOverride: String(last.msg.message_id),
          ambientTranscriptBody: formatTelegramAmbientTranscriptBody(bufferedMessages),
          receivedAtMs: first.receivedAtMs,
          ingressBuffer: "text-fragment",
          threadSpec: entry.threadSpec,
          bufferedMessages,
          ...promptContextBoundaryOptions(
            latestPromptContextMinTimestampMs(
              ...messages.map((fragment) => fragment.promptContextMinTimestampMs),
            ),
            latestPromptContextAmbientWatermark(
              ...messages.map((fragment) => fragment.promptContextAmbientWatermark),
            ),
          ),
          ...spooledReplayOptions(spooledReplayParticipants),
          channelIngressResolvers: messages.map((fragment) => fragment.channelIngressResolver),
        },
        dispatchDedupeClaims,
        spooledReplayParticipants,
        shouldSkipBeforeDispatch: async () => {
          await Promise.all(messages.map(waitForPendingIgnore));
          return messages.some((fragment) => fragment.cancelled);
        },
        deferCancelledBeforeDispatchSettlement: true,
        dispatchAdmission: bufferedDispatch.admission,
      });
      if (result.kind === "skipped" && result.reason === "cancelled-before-dispatch") {
        await Promise.all(messages.map(waitForPendingIgnore));
        if (
          messages.some((fragment) => fragment.cancelled) ||
          bufferedDispatch.wasPausedForPendingIgnore()
        ) {
          try {
            await flushTextFragments(entry, messages);
          } finally {
            for (const fragment of messages) {
              forgetTextFragment(fragment);
            }
          }
          return;
        }
      }
      settleSpooledReplayParticipants(spooledReplayParticipants, result);
      for (const fragment of messages) {
        forgetTextFragment(fragment);
      }
    } catch (error) {
      await purgeIgnoredBufferedMessages(
        messages
          .filter((fragment) => fragment.cancelled)
          .map((fragment) => ({ msg: fragment.msg, threadSpec: entry.threadSpec })),
      );
      releaseDispatchDedupeClaims(dispatchDedupeClaims, error);
      settleSpooledReplayParticipants(
        spooledReplayParticipants,
        buildFailedProcessingResult(error),
      );
      runtime.error?.(danger(`text fragment handler failed: ${String(error)}`));
      for (const fragment of messages) {
        forgetTextFragment(fragment);
      }
    } finally {
      bufferedDispatch.release();
    }
  };
  const scheduleTextFlush = (entry: TextFragmentEntry) => {
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entry.timer = setTimeout(() => releaseTextFragments(entry), maxGapMs);
  };
  const cancelPending = ({ chatId, threadSpec, senderId }: TelegramPendingInboundTarget) => {
    if (!senderId) {
      return;
    }
    const key = `text:${chatId}:${threadSpec.scope}:${threadSpec.id ?? "main"}:${senderId}`;
    for (const entry of pendingTextFragments.get(key) ?? []) {
      cancelTextFragments(entry);
    }
    const conversationKey = buildTelegramInboundDebounceConversationKey({ chatId, threadSpec });
    for (const debounceLane of ["default", "forward"] as const) {
      inboundDebouncer.cancelKey(
        buildTelegramInboundDebounceKey({ accountId, conversationKey, senderId, debounceLane }),
      );
    }
  };
  const handleTextFragment = async (params: TelegramTextFragmentInput): Promise<boolean> => {
    const text = typeof params.msg.text === "string" ? params.msg.text : undefined;
    const isCommand = getTelegramTextParts(params.msg).entities.some(
      (entity) => entity.type === "bot_command" && entity.offset === 0,
    );
    const senderId = params.msg.from?.id != null ? String(params.msg.from.id) : "unknown";
    const key = `text:${params.chatId}:${params.threadSpec.scope}:${params.threadSpec.id ?? "main"}:${senderId}`;
    if (text && !isCommand && !params.isAbortControlMessage) {
      const nowMs = Date.now();
      const existing = textBuffer.get(key);
      if (existing) {
        const last = existing.messages.at(-1);
        const idGap = last ? params.msg.message_id - last.msg.message_id : Infinity;
        const timeGapMs = nowMs - (last?.receivedAtMs ?? nowMs);
        const canAppend = idGap > 0 && idGap <= 1 && timeGapMs >= 0 && timeGapMs <= maxGapMs;
        const nextTotalChars =
          existing.messages.reduce(
            (sum, bufferedMessage) => sum + (bufferedMessage.msg.text?.length ?? 0),
            0,
          ) + text.length;
        if (canAppend && existing.messages.length < 12 && nextTotalChars <= 50_000) {
          existing.messages.push(createTextFragmentMessage(params, key, nowMs));
          scheduleTextFlush(existing);
          return true;
        }
        releaseTextFragments(existing);
        await existing.completion;
      }
      if (text.length >= 4000) {
        let releaseReady!: () => void;
        const ready = new Promise<void>((resolve) => {
          releaseReady = resolve;
        });
        let resolveCompletion!: () => void;
        const completion = new Promise<void>((resolve) => {
          resolveCompletion = resolve;
        });
        const entry: TextFragmentEntry = {
          key,
          storeAllowFrom: params.storeAllowFrom,
          threadSpec: params.threadSpec,
          messages: [createTextFragmentMessage(params, key, nowMs)],
          timer: null,
          ready,
          releaseReady,
          completion,
          canceled: false,
        };
        textBuffer.set(key, entry);
        const pending = pendingTextFragments.get(key) ?? new Set<TextFragmentEntry>();
        pending.add(entry);
        pendingTextFragments.set(key, pending);
        scheduleTextFlush(entry);
        const debounceLane = resolveTelegramDebounceLane(params.msg);
        // Reserve on the first fragment, while later updates can still append.
        // The existing immediate boundary seals earlier ordinary text separately.
        void inboundDebouncer
          .enqueue({
            ctx: params.ctx,
            msg: params.msg,
            allMedia: [],
            storeAllowFrom: params.storeAllowFrom,
            receivedAtMs: nowMs,
            debounceKey: buildTelegramInboundDebounceKey({
              accountId,
              conversationKey: buildTelegramInboundDebounceConversationKey(params),
              senderId,
              debounceLane,
            }),
            debounceLane,
            threadSpec: params.threadSpec,
            dispatchDedupeClaims: params.dispatchDedupeClaims,
            channelIngressResolvers: [params.channelIngressResolver],
            textFragment: entry,
            cancelled: false,
            dispatchAdmission: "pending",
            dispatchAbortControllers: new Set(),
            pendingIgnoreSettlements: new Set(),
          })
          .then(resolveCompletion, (error: unknown) => {
            failTextFragments(entry, error);
            resolveCompletion();
          });
        return true;
      }
    }
    return false;
  };
  return {
    cancelPending,
    inboundDebouncer: { ...inboundDebouncer, enqueue: enqueueDebounceEntry },
    resolveTelegramDebounceEntryMs,
    shouldDebounceTelegramEntry,
    resolveTelegramDebounceLane,
    handleTextFragment,
    beginPendingBufferedMessageIgnore,
  };
}
