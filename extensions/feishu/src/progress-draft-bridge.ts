// Feishu progress-draft bridge.
//
// Progress mode coalesces the whole work timeline (headline + tools +
// narration/commentary + plan) into one live CardKit draft, then repaints that
// same card in place with the final answer. This module owns the shared
// compositor and the streaming/progress reply callbacks so the reply
// dispatcher stays under the oxlint line cap. Feishu only owns transport: the
// callbacks below render the compositor text into the same CardKit streaming
// card; when progress mode is off the bridge stays inert and the callbacks
// preserve the existing partial-preview behavior byte-for-byte.
import { formatReasoningMessage } from "openclaw/plugin-sdk/agent-runtime";
import {
  createChannelProgressDraftCompositor,
  formatChannelProgressDraftLineForEntry,
} from "openclaw/plugin-sdk/channel-outbound";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { stripReasoningTagsFromText } from "openclaw/plugin-sdk/text-chunking";
import type { ReplyPayload } from "../runtime-api.js";
import type { FeishuConfig } from "./types.js";

type StreamTextUpdateMode = "snapshot" | "delta";

type ProgressDraftMode = Parameters<typeof createChannelProgressDraftCompositor>[0]["mode"];
type ToolStartPayload = Parameters<NonNullable<GetReplyOptions["onToolStart"]>>[0];
type ItemEventPayload = Parameters<NonNullable<GetReplyOptions["onItemEvent"]>>[0];
type PlanUpdatePayload = Parameters<NonNullable<GetReplyOptions["onPlanUpdate"]>>[0];

type CreateFeishuProgressDraftBridgeParams = {
  accountConfig: FeishuConfig;
  accountId: string;
  sendTarget: string;
  previewStreamMode: ProgressDraftMode;
  previewStreamingEnabled: boolean;
  progressStreamingEnabled: boolean;
  reasoningPreviewEnabled: boolean;
  startStreaming: () => void;
  flushStreamingCardUpdate: (combined: string) => void;
  queueStreamingUpdate: (
    nextText: string,
    options?: { dedupeWithLastPartial?: boolean; mode?: StreamTextUpdateMode },
  ) => void;
  queueReasoningUpdate: (nextThinking: string) => void;
  updateStreamingStatusLine: (
    nextStatusLine: string,
    options?: { startIfNeeded?: boolean },
  ) => boolean;
};

// In progress mode the shared compositor defaults tool rows and commentary OFF
// (a quiet default for channels that render rolling lines natively). Feishu
// renders the draft text itself, so default both ON; an explicit
// streaming.progress.* value still overrides them. The spread puts these
// defaults ahead of the user-supplied block, so `toolProgress: false` /
// `commentary: false` win when set.
function resolveProgressDraftEntry(
  accountConfig: FeishuConfig,
  progressStreamingEnabled: boolean,
): FeishuConfig {
  if (!progressStreamingEnabled) {
    return accountConfig;
  }
  const streaming = accountConfig.streaming;
  const progress = streaming?.progress;
  return {
    ...accountConfig,
    streaming: {
      ...streaming,
      progress: {
        toolProgress: true,
        commentary: true,
        ...progress,
      },
    },
  };
}

export function createFeishuProgressDraftBridge(params: CreateFeishuProgressDraftBridgeParams) {
  const {
    accountConfig,
    accountId,
    sendTarget,
    previewStreamMode,
    previewStreamingEnabled,
    progressStreamingEnabled,
    reasoningPreviewEnabled,
    startStreaming,
    flushStreamingCardUpdate,
    queueStreamingUpdate,
    queueReasoningUpdate,
    updateStreamingStatusLine,
  } = params;

  const progressDraftEntry = resolveProgressDraftEntry(accountConfig, progressStreamingEnabled);

  const progressDraft = createChannelProgressDraftCompositor({
    // Feishu renders the shared, prepared activity timeline: tool lifecycle
    // events only stage diffstat bookkeeping, while prepared item events own
    // the visible rows (routine polls stay quiet; failures/approvals remain).
    preparedItems: true,
    entry: progressDraftEntry,
    mode: previewStreamMode,
    active: progressStreamingEnabled,
    seed: `${accountId}:${sendTarget}`,
    // Feishu opens the live card on the first real tool or item row.
    shouldStartNow: (line) =>
      typeof line === "object" && line !== null && (line.kind === "item" || line.kind === "tool"),
    update: (previewText) => {
      startStreaming();
      flushStreamingCardUpdate(previewText);
    },
  });

  const callbacks = {
    ...(progressStreamingEnabled
      ? { allowProgressCallbacksWhenSourceDeliverySuppressed: true }
      : {}),
    ...(progressStreamingEnabled ? { preserveProgressCallbackStartOrder: true } : {}),
    ...(progressStreamingEnabled ? { suppressDefaultToolProgressMessages: true } : {}),
    ...(progressStreamingEnabled ? { suppressToolProgressMessages: true } : {}),
    onPartialReply: previewStreamingEnabled
      ? (payload: ReplyPayload) => {
          // In progress mode the answer is not streamed as partial text; the draft card
          // keeps showing the work timeline until the final answer repaints it.
          if (progressStreamingEnabled) {
            return false;
          }
          if (!payload.text) {
            return false;
          }
          const cleaned = stripReasoningTagsFromText(payload.text, {
            mode: "strict",
            trim: "both",
          });
          if (!cleaned) {
            return false;
          }
          startStreaming();
          queueStreamingUpdate(cleaned, {
            dedupeWithLastPartial: true,
            mode: "snapshot",
          });
          return false;
        }
      : undefined,
    onReasoningStream:
      reasoningPreviewEnabled || progressStreamingEnabled
        ? (payload: ReplyPayload) => {
            if (progressStreamingEnabled) {
              return progressDraft.pushReasoningProgress(payload.text || "Thinking…", {
                snapshot: payload.isReasoningSnapshot === true,
              });
            }
            if (!payload.text) {
              return false;
            }
            startStreaming();
            queueReasoningUpdate(formatReasoningMessage(payload.text));
            return false;
          }
        : undefined,
    onReasoningEnd:
      reasoningPreviewEnabled || progressStreamingEnabled
        ? () => {
            if (progressStreamingEnabled) {
              progressDraft.resetReasoningProgress();
            }
            return false;
          }
        : undefined,
    onAssistantMessageStart: previewStreamingEnabled
      ? () => {
          if (progressStreamingEnabled) {
            // The compositor owns card content in progress mode. Only rotate its
            // internal message boundary; do NOT flush an empty status line over
            // the rendered work timeline (that would blank the live card).
            progressDraft.beginAssistantMessage();
            return false;
          }
          return updateStreamingStatusLine("", { startIfNeeded: false });
        }
      : undefined,
    // The reply-options contract requires void here; await the compositor push
    // so core preserves callback start order instead of fire-and-forget.
    ...(progressStreamingEnabled
      ? {
          onNarrationUpdate: async (payload: { text: string }) => {
            await progressDraft.pushNarrationProgress(payload.text);
          },
        }
      : {}),
    ...(progressStreamingEnabled ? { isProgressDraftVisible: () => progressDraft.isVisible } : {}),
    ...(progressStreamingEnabled
      ? { commentaryProgressEnabled: progressDraft.commentaryProgressEnabled }
      : {}),
    ...(progressStreamingEnabled ? { progressPreambleEnabled: true } : {}),
    // Route 💬 commentary into the draft card rather than standalone messages.
    ...(progressStreamingEnabled ? { commentaryPayloadsEnabled: true } : {}),
    ...(progressStreamingEnabled ? { shouldDeliverCommentaryPayloads: () => false } : {}),
    ...(progressStreamingEnabled
      ? {
          onPlanUpdate: (payload: PlanUpdatePayload) => {
            if (payload.phase !== "update") {
              return false;
            }
            return progressDraft.pushPlanProgress(payload.steps, {
              explanation: payload.explanation,
              explanationFormat: payload.explanationFormat,
            });
          },
        }
      : {}),
    // In progress mode, tool lifecycle events feed shared diffstat bookkeeping;
    // the visible rows arrive through the prepared onItemEvent pipeline. In
    // partial mode feishu has no onToolStart handler (routine polls stay quiet).
    ...(progressStreamingEnabled
      ? {
          onToolStart: (payload: ToolStartPayload) =>
            progressDraft.pushToolEvent({
              itemId: payload.itemId,
              toolCallId: payload.toolCallId,
              name: payload.name,
              phase: payload.phase,
              args: payload.args,
              ...(payload.detailMode ? { detailMode: payload.detailMode } : {}),
            }),
        }
      : {}),
    onItemEvent: previewStreamingEnabled
      ? (payload: ItemEventPayload) => {
          if (progressStreamingEnabled) {
            return progressDraft.pushItemEvent(payload);
          }
          if (
            payload.kind === "preamble" ||
            payload.hideFromChannelProgress ||
            payload.suppressChannelProgress
          ) {
            return false;
          }
          const { kind: itemKind, ...item } = payload;
          const statusLineLocal = formatChannelProgressDraftLineForEntry(accountConfig, {
            event: "item",
            itemKind,
            ...item,
          });
          if (statusLineLocal) {
            return updateStreamingStatusLine(statusLineLocal);
          }
          return false;
        }
      : undefined,
    onCompactionStart: previewStreamingEnabled
      ? () => {
          // In progress mode the compositor owns the card; leave its timeline intact.
          if (progressStreamingEnabled) {
            return false;
          }
          return updateStreamingStatusLine("📦 **Compacting context...**");
        }
      : undefined,
    onCompactionEnd:
      previewStreamingEnabled && !progressStreamingEnabled
        ? () => updateStreamingStatusLine("")
        : undefined,
  };

  return {
    // Flip the single draft card from the work timeline to the answer.
    markFinalReplyStarted: () => progressDraft.markFinalReplyStarted(),
    callbacks,
  };
}
