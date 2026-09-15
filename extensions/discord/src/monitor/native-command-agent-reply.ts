// Discord plugin module implements native command agent reply behavior.
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  hasVisibleInboundReplyDispatch,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createChannelProgressDraftCompositor,
  resolveChannelStreamingBlockEnabled,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import {
  PLUGIN_COMMAND_DISPATCH,
  type PluginCommandCatalogDecision,
} from "openclaw/plugin-sdk/plugin-command-runtime";
import { resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import type { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import type {
  ButtonInteraction,
  CommandInteraction,
  StringSelectMenuInteraction,
} from "../internal/discord.js";
import { resolveDiscordPreviewStreamMode } from "../preview-streaming.js";
import type { DiscordChannelConfigResolved } from "./allow-list.js";
import type { buildDiscordNativeCommandContext } from "./native-command-context.js";
import {
  DISCORD_EMPTY_VISIBLE_REPLY_WARNING,
  deliverDiscordInteractionReply,
  safeDiscordInteractionCall,
  settleDiscordInteractionWithoutVisibleReply,
} from "./native-command-reply.js";
import { nativeCommandRuntime } from "./native-command.runtime.js";
import type { DiscordConfig, DiscordDispatchReplyFromConfig } from "./native-command.types.js";

type NativeCommandEffectiveRoute = {
  accountId: string;
  agentId: string;
  sessionKey: string;
};

type DispatchDiscordNativeAgentReplyResult = {
  dispatched: boolean;
  hiddenFinalReply?: ReplyPayload;
};

export async function dispatchDiscordNativeAgentReply(params: {
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  ctxPayload: ReturnType<typeof buildDiscordNativeCommandContext>;
  effectiveRoute: NativeCommandEffectiveRoute;
  channelConfig: DiscordChannelConfigResolved | null;
  mediaLocalRoots: ReturnType<typeof getAgentScopedMediaLocalRoots>;
  preferFollowUp: boolean;
  responseEphemeral?: boolean;
  suppressReplies?: boolean;
  dispatchReplyFromConfig?: DiscordDispatchReplyFromConfig;
  log: ReturnType<typeof createSubsystemLogger>;
  pluginCommandDispatch: PluginCommandCatalogDecision;
}): Promise<DispatchDiscordNativeAgentReplyResult> {
  const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(params.discordConfig);
  const streamMode = resolveDiscordPreviewStreamMode(params.discordConfig);

  let didReply = false;
  let finalReplyOutcome: "accepted" | "failed" | "suppressed" | undefined;
  let hiddenFinalReply: ReplyPayload | undefined;
  const progressDraft =
    streamMode === "progress" && !params.suppressReplies
      ? createChannelProgressDraftCompositor({
          entry: params.discordConfig,
          mode: streamMode,
          active: true,
          seed: `${params.accountId}:${params.interaction.rawData.id}`,
          reasoningLinePrefix: "🧠 ",
          commentaryLinePrefix: "💬 ",
          commentaryItalics: false,
          update: async (text) => {
            const result = await safeDiscordInteractionCall("interaction progress edit", () =>
              params.interaction.editReply({ content: text }),
            );
            if (result === null) {
              return false;
            }
            didReply = true;
            return true;
          },
        })
      : undefined;

  const turnResult = await nativeCommandRuntime.dispatchChannelInboundTurn({
    cfg: params.cfg,
    channel: "discord",
    accountId: params.effectiveRoute.accountId,
    route: {
      agentId: params.effectiveRoute.agentId,
      sessionKey: params.ctxPayload.SessionKey ?? params.effectiveRoute.sessionKey,
    },
    ctxPayload: params.ctxPayload,
    dispatchReplyFromConfig: params.dispatchReplyFromConfig,
    delivery: {
      deliver: async (payload) => {
        if (params.suppressReplies) {
          return {
            visibleReplySent: false,
            suppression: { reason: "channel_transform" as const },
          };
        }
        progressDraft?.markFinalReplyStarted();
        const payloadDelivered = await deliverDiscordInteractionReply({
          interaction: params.interaction,
          payload,
          componentRoute: {
            accountId: params.effectiveRoute.accountId,
            agentId: params.effectiveRoute.agentId,
            sessionKey:
              params.ctxPayload.CommandTargetSessionKey ?? params.effectiveRoute.sessionKey,
          },
          mediaLocalRoots: params.mediaLocalRoots,
          textLimit: resolveTextChunkLimit(params.cfg, "discord", params.accountId, {
            fallbackLimit: 2000,
          }),
          maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({
            cfg: params.cfg,
            discordConfig: params.discordConfig,
            accountId: params.accountId,
          }),
          preferFollowUp: params.preferFollowUp || didReply,
          responseEphemeral: params.responseEphemeral,
          chunkMode: resolveChunkMode(params.cfg, "discord", params.accountId),
        });
        didReply ||= payloadDelivered;
        if (payloadDelivered) {
          progressDraft?.markFinalReplyDelivered();
        }
        return payloadDelivered
          ? { visibleReplySent: true }
          : {
              visibleReplySent: false,
              suppression: { reason: "no_visible_result" as const },
            };
      },
      onDelivered: (payload, info, result) => {
        // Hidden picker dispatch reuses only a real core final suppressed by this adapter.
        if (
          params.suppressReplies &&
          info.kind === "final" &&
          result?.suppression?.reason === "channel_transform" &&
          payload.text?.trim()
        ) {
          hiddenFinalReply = payload;
        }
        // A failed final outweighs later suppression until Discord accepts a final.
        if (
          info.kind === "final" &&
          result?.visibleReplySent !== undefined &&
          (result.visibleReplySent || finalReplyOutcome !== "failed")
        ) {
          finalReplyOutcome = result.visibleReplySent ? "accepted" : "suppressed";
        }
      },
      onError: (err, info) => {
        const partialDelivery = isChannelPartialDeliveryError(err);
        if (partialDelivery) {
          // Preserve failed delivery accounting while preventing an empty fallback from
          // obscuring the prefix that Discord already accepted for this payload.
          didReply = true;
          logVerbose("discord: interaction reply partially delivered before expiry");
        }
        if (info.kind === "final") {
          finalReplyOutcome = partialDelivery ? "accepted" : "failed";
        }
        const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
        params.log.error(`discord slash ${info.kind} reply failed: ${message}`);
      },
    },
    replyPipeline: {},
    dispatcherOptions: {
      humanDelay: resolveHumanDelayConfig(params.cfg, params.effectiveRoute.agentId),
    },
    replyOptions: {
      skillFilter: params.channelConfig?.skills,
      [PLUGIN_COMMAND_DISPATCH]: params.pluginCommandDispatch,
      suppressDefaultToolProgressMessages: progressDraft ? true : undefined,
      progressPreambleEnabled: progressDraft ? true : undefined,
      commentaryPayloadsEnabled: progressDraft?.commentaryProgressEnabled ? true : undefined,
      shouldDeliverCommentaryPayloads: progressDraft?.commentaryProgressEnabled
        ? () => false
        : undefined,
      onAssistantMessageStart: progressDraft
        ? () => {
            progressDraft.beginAssistantMessage();
            return false;
          }
        : undefined,
      onReasoningEnd: progressDraft
        ? () => {
            progressDraft.resetReasoningProgress();
            return false;
          }
        : undefined,
      onQueuedFollowupAdmitted: progressDraft
        ? () => {
            progressDraft.beginNewTurn({ force: true });
          }
        : undefined,
      onReasoningStream: progressDraft
        ? async (payload) =>
            await progressDraft.pushReasoningProgress(payload?.text, {
              snapshot: payload?.isReasoningSnapshot === true,
            })
        : undefined,
      onToolStart: progressDraft
        ? async (payload) => {
            const visible = await progressDraft.pushToolEvent(payload);
            if (!visible && payload.phase === "start") {
              return await progressDraft.noteActivity({ startImmediately: true });
            }
            return visible;
          }
        : undefined,
      onItemEvent: progressDraft
        ? async (payload) => {
            if (payload.kind === "preamble") {
              const headlineAccepted = await progressDraft.pushPreambleHeadline(
                payload.progressText,
                { itemId: payload.itemId },
              );
              const commentaryAccepted = progressDraft.commentaryProgressEnabled
                ? await progressDraft.pushCommentaryProgress(payload.progressText, {
                    itemId: payload.itemId,
                  })
                : false;
              return headlineAccepted || commentaryAccepted;
            }
            return await progressDraft.pushItemEvent(payload);
          }
        : undefined,
      onPlanUpdate: progressDraft
        ? async (payload) =>
            payload.phase === "update"
              ? await progressDraft.pushPlanProgress(payload.steps, {
                  explanation: payload.explanation,
                  explanationFormat: payload.explanationFormat,
                })
              : false
        : undefined,
      onApprovalEvent: progressDraft
        ? async (payload) => await progressDraft.pushApprovalEvent(payload)
        : undefined,
      onCommandOutput: progressDraft
        ? async (payload) => await progressDraft.pushCommandOutputEvent(payload)
        : undefined,
      onPatchSummary: progressDraft
        ? async (payload) => await progressDraft.pushPatchEvent(payload)
        : undefined,
      disableBlockStreaming: progressDraft
        ? true
        : typeof blockStreamingEnabled === "boolean"
          ? !blockStreamingEnabled
          : undefined,
    },
  });
  const shouldSettleWithoutVisibleReply =
    params.suppressReplies ||
    finalReplyOutcome === "suppressed" ||
    (turnResult.dispatched &&
      (turnResult.dispatchResult.deliberateSilentTerminalReply === true ||
        turnResult.dispatchResult.deferredToActiveRun !== undefined));
  const dispatchResult = {
    dispatched: turnResult.dispatched,
    ...(hiddenFinalReply ? { hiddenFinalReply } : {}),
  };

  if (!didReply && shouldSettleWithoutVisibleReply) {
    await settleDiscordInteractionWithoutVisibleReply(params.interaction);
    return dispatchResult;
  }
  if (
    didReply ||
    (turnResult.dispatched && hasVisibleInboundReplyDispatch(turnResult.dispatchResult))
  ) {
    return dispatchResult;
  }

  await safeDiscordInteractionCall("interaction empty fallback", async () => {
    const payload = {
      content: DISCORD_EMPTY_VISIBLE_REPLY_WARNING,
      ephemeral: true,
    };
    if (params.preferFollowUp) {
      await params.interaction.followUp(payload);
      return;
    }
    await params.interaction.reply(payload);
  });
  return dispatchResult;
}
