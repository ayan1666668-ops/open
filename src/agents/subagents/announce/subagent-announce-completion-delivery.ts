/**
 * Requester completion calls, direct fallback, and source-delivery evidence.
 */
import { sanitizePendingFinalDeliveryText } from "../../../auto-reply/reply/pending-final-delivery-state.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { waitForGatewayDispatch } from "../../../gateway/server-in-process-dispatch.js";
import { normalizeOutboundReplyPayloadCore } from "../../../infra/outbound/reply-payload-normalize.js";
import { sourceDeliveryTargetsMatch } from "../../../infra/outbound/source-delivery-plan.js";
import { splitMediaFromOutput } from "../../../media/parse.js";
import { shouldPreserveUserFacingSessionStateForInputProvenance } from "../../../sessions/input-provenance.js";
import { deriveSessionChatTypeFromKey } from "../../../sessions/session-chat-type-shared.js";
import { isNonTerminalAgentRunStatus } from "../../../shared/agent-run-status.js";
import { buildAgentRunTerminalOutcomeFromWaitResult } from "../../agent-run-terminal-outcome.js";
import { sanitizeAgentRunTerminalReplyText } from "../../agent-run-terminal-reply.js";
import {
  hasCommittedSourceReplyDeliveryEvidence,
  hasMessagingToolDeliveryEvidence,
  hasUnaccountedMessagingToolAggregateEvidence,
  resolveExplicitFinalSourceReplyDeliveryEvidence,
} from "../../embedded-agent-runner/delivery-evidence.js";
import { hasVisibleAgentPayload } from "../../embedded-agent-runner/message-visibility.js";
import { hasVisibleCompletionResult } from "../../internal-event-contract.js";
import { collectAgentInternalEventMedia, type AgentInternalEvent } from "../../internal-events.js";
import { createAgentRunDirectAbortError } from "../../run-termination.js";
import {
  hasAnnounceSendEvidence,
  SourceOwnerChangedError,
  sourceOwnerChangedResult,
  summarizeDeliveryError,
} from "./subagent-announce-delivery-retry.js";
import {
  dispatchSubagentAnnounceAgent,
  sendSubagentAnnounceMessage,
  tryResolveSubagentRequesterAgentId,
} from "./subagent-announce-delivery.runtime.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import type { SubagentCompletionToolHandoffRegistration } from "./subagent-announce-handoff.js";
import { inferDeliveryTargetChatType } from "./subagent-announce-origin.js";

export async function runAnnounceAgentCall(params: {
  agentParams: Record<string, unknown>;
  privateCompletion?: true;
  delegatedToolPolicyHandoff?: SubagentCompletionToolHandoffRegistration;
  expectFinal?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  isExecutionAllowed: () => boolean;
  isSourceSessionAdmissionAllowed?: () => boolean;
  resolveGatewayContext?: import("../../../gateway/server-methods/types.js").GatewayContextResolver;
}): Promise<unknown> {
  const deadline = new AbortController();
  const sourceLifecycle = new AbortController();
  const isSourceSessionAdmissionAllowed = params.isSourceSessionAdmissionAllowed;
  const lifecycleSignal = params.signal
    ? AbortSignal.any([params.signal, sourceLifecycle.signal])
    : sourceLifecycle.signal;
  const signal = AbortSignal.any([lifecycleSignal, deadline.signal]);
  // A private input stays owned by Gateway admission when an observer times out.
  // Caller or source lifecycle cancellation still stops that underlying turn.
  const executionSignal = params.privateCompletion ? lifecycleSignal : signal;
  const timer =
    params.timeoutMs === undefined
      ? undefined
      : setTimeout(
          () => deadline.abort(new Error("gateway request timeout for agent")),
          params.timeoutMs,
        );
  timer?.unref?.();
  try {
    signal.throwIfAborted();
    const dispatch = dispatchSubagentAnnounceAgent(params.agentParams, {
      cancelOnDeadline: true,
      privateCompletion: params.privateCompletion,
      expectFinal: params.expectFinal,
      forceSyntheticClient: shouldPreserveUserFacingSessionStateForInputProvenance(
        params.agentParams.inputProvenance,
      ),
      operatorRoleActor: { kind: "system" },
      delegatedToolPolicyHandoff: params.delegatedToolPolicyHandoff,
      signal: executionSignal,
      ...(isSourceSessionAdmissionAllowed
        ? {
            sessionMutationCommitGuard: () => {
              if (!isSourceSessionAdmissionAllowed()) {
                const error = new SourceOwnerChangedError();
                sourceLifecycle.abort(error);
                throw error;
              }
            },
          }
        : {}),
      // Accepted queue waits belong to session admission; execution belongs to
      // the requester runtime budget, not the announcement handoff deadline.
      onAccepted: () => clearTimeout(timer),
      onExecutionStarted: () => {
        executionSignal.throwIfAborted();
        if (!params.isExecutionAllowed()) {
          sourceLifecycle.abort(new SourceOwnerChangedError());
          // Classify execution immediately, before Gateway observes cancellation.
          throw createAgentRunDirectAbortError();
        }
        // Execution can be observed before acceptance on an already-running replay.
        clearTimeout(timer);
      },
      resolveGatewayContext: params.resolveGatewayContext,
    });
    return params.privateCompletion
      ? await waitForGatewayDispatch("agent", dispatch, undefined, signal)
      : await dispatch;
  } catch (error) {
    sourceLifecycle.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const FAILED_COMPLETION_NOTICE =
  "A delegated task failed before it could report a result. Please retry the task.";

export function isGatewayAgentRunPending(response: unknown): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }
  const status = (response as { status?: unknown }).status;
  return isNonTerminalAgentRunStatus(status);
}

export function resolvePrivateCompletionDeliveryResult(
  response: Record<string, unknown> | undefined,
): SubagentAnnounceDeliveryResult {
  const outcome = buildAgentRunTerminalOutcomeFromWaitResult(response);
  if (outcome?.reason === "cancelled" && outcome.stopReason !== "restart") {
    return {
      delivered: false,
      path: "direct",
      terminal: true,
      reason: "delivery_suppressed",
      disposition: "intentional_non_delivery",
      error: "private requester continuation was cancelled",
    };
  }
  // Successful internal consumption may be silent or start the next child.
  // Queue acceptance alone is not consumption, and no external receipt is owed.
  return response?.status === "ok" && response?.inputProcessingCompleted === true
    ? { delivered: true, path: "direct" }
    : {
        delivered: false,
        path: "direct",
        reason: "completion_handoff_pending",
        error: "private requester turn has not completed successfully",
        disposition: "retryable",
      };
}

export function isDirectMessageDeliveryTarget(
  target: { channel?: string; to?: string; threadId?: string },
  requesterSessionKey: string,
): boolean {
  if (target.threadId) {
    return false;
  }
  const targetChatType = inferDeliveryTargetChatType(target);
  if (targetChatType) {
    return targetChatType === "direct";
  }
  return deriveSessionChatTypeFromKey(requesterSessionKey) === "direct";
}

type DirectCompletionContent = { content: string; mediaUrls: string[]; audioAsVoice?: boolean };

function collectDirectCompletionContent(params: {
  agentResult?: { payloads?: unknown };
  events: readonly AgentInternalEvent[] | undefined;
  contentKind: "completed_result" | "failed_notice";
}): DirectCompletionContent | undefined {
  if (params.contentKind === "failed_notice") {
    return { content: FAILED_COMPLETION_NOTICE, mediaUrls: [] };
  }
  const collect = (payloads: readonly unknown[]): DirectCompletionContent | undefined => {
    const textParts: string[] = [];
    const mediaUrls = new Set<string>();
    let audioAsVoice = false;
    for (const payload of payloads) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        continue;
      }
      // SAFETY: The object/array guard above narrows payload to a plain record boundary.
      const record = payload as Record<string, unknown>;
      if (
        !hasVisibleAgentPayload(
          { payloads: [record] },
          {
            includeErrorPayloads: false,
            includeReasoningPayloads: false,
            includeSilentReplyPayloads: false,
            requireTerminalContent: true,
          },
        )
      ) {
        continue;
      }
      const normalized = normalizeOutboundReplyPayloadCore(record);
      // Hidden runtime context must not contribute media directives: strip the
      // protected block before extraction so a MEDIA reference it carries can
      // never become an attachment; visible directives still deliver.
      const parsed = splitMediaFromOutput(sanitizePendingFinalDeliveryText(normalized.text ?? ""));
      if (parsed.audioAsVoice === true || record.audioAsVoice === true) {
        audioAsVoice = true;
      }
      const text = sanitizeAgentRunTerminalReplyText(sanitizePendingFinalDeliveryText(parsed.text));
      // A result that only reads like the producer's placeholder is still a real
      // result: absence is recorded on the event fact, never matched here.
      if (text) {
        textParts.push(text);
      }
      for (const mediaUrl of [
        ...(normalized.mediaUrl ? [normalized.mediaUrl] : []),
        ...(normalized.mediaUrls ?? []),
        ...(parsed.mediaUrls ?? []),
      ]) {
        mediaUrls.add(mediaUrl);
      }
    }
    return textParts.length > 0 || mediaUrls.size > 0
      ? {
          content: textParts.join("\n\n"),
          mediaUrls: [...mediaUrls],
          ...(audioAsVoice ? { audioAsVoice: true as const } : {}),
        }
      : undefined;
  };

  const payloadContent = Array.isArray(params.agentResult?.payloads)
    ? collect(params.agentResult.payloads)
    : undefined;
  if (payloadContent && payloadContent.mediaUrls.length > 0) {
    return payloadContent;
  }
  for (let index = (params.events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = params.events?.[index];
    if (event?.type !== "task_completion" || event.source !== "subagent" || event.status !== "ok") {
      continue;
    }
    // Placeholder copy for an absent child result is not deliverable content.
    if (!hasVisibleCompletionResult(event)) {
      continue;
    }
    const parsedEvent = collect([{ text: event.result }]);
    const eventMediaUrls = collectAgentInternalEventMedia([event]).mediaUrls;
    const mediaUrls = new Set([...(parsedEvent?.mediaUrls ?? []), ...eventMediaUrls]);
    if (parsedEvent || mediaUrls.size > 0) {
      return {
        content: parsedEvent?.content ?? "",
        mediaUrls: [...mediaUrls],
        ...(parsedEvent?.audioAsVoice ? { audioAsVoice: true as const } : {}),
      };
    }
  }
  return undefined;
}

export async function deliverCompletionDirect(params: {
  cfg: OpenClawConfig;
  requesterSessionKey: string;
  requesterAgentId?: string;
  directIdempotencyKey: string;
  deliveryTarget: {
    deliver: boolean;
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string;
  };
  internalEvents?: readonly AgentInternalEvent[];
  contentKind: "completed_result" | "failed_notice";
  signal?: AbortSignal;
  agentResult?: { payloads?: unknown };
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
  isSourceSessionEffectsAllowed?: () => boolean;
}): Promise<SubagentAnnounceDeliveryResult | undefined> {
  const completionContent = collectDirectCompletionContent({
    agentResult: params.agentResult,
    events: params.internalEvents,
    contentKind: params.contentKind,
  });
  // A failed completion must not deliver partial child media as its result.
  const content = completionContent?.content;
  const mediaUrls = completionContent?.mediaUrls ?? [];
  const audioAsVoice = completionContent?.audioAsVoice === true;
  if (
    (!content && mediaUrls.length === 0) ||
    !params.deliveryTarget.deliver ||
    !params.deliveryTarget.channel ||
    !params.deliveryTarget.to ||
    !isDirectMessageDeliveryTarget(params.deliveryTarget, params.requesterSessionKey)
  ) {
    return undefined;
  }
  const agentId = tryResolveSubagentRequesterAgentId(
    params.cfg,
    params.requesterSessionKey,
    params.requesterAgentId,
  );
  if (!agentId) {
    return undefined;
  }
  const idempotencyKey = `${params.directIdempotencyKey}:text-direct`;
  let committedDelivery: SubagentAnnounceDeliveryResult | undefined;
  const commitDirectDelivery = (): void => {
    if (committedDelivery) {
      return;
    }
    committedDelivery = { delivered: true, path: "direct", deliveredAt: Date.now() };
    params.onDeliveryResult?.(committedDelivery);
  };
  try {
    if (params.isSourceSessionEffectsAllowed?.() === false) {
      return sourceOwnerChangedResult();
    }
    if (params.signal?.aborted) {
      return { delivered: false, path: "none" };
    }
    const sendResult = await sendSubagentAnnounceMessage({
      cfg: params.cfg,
      channel: params.deliveryTarget.channel,
      to: params.deliveryTarget.to,
      accountId: params.deliveryTarget.accountId,
      threadId: params.deliveryTarget.threadId,
      requesterSessionKey: params.requesterSessionKey,
      agentId,
      conversationType: "direct",
      content: content ?? "",
      ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
      ...(audioAsVoice ? { asVoice: true } : {}),
      idempotencyKey,
      skipQueue: true,
      abortSignal: params.signal,
      onPlatformSendDispatch: async () => {
        params.signal?.throwIfAborted();
        if (params.isSourceSessionEffectsAllowed?.() === false) {
          throw new SourceOwnerChangedError();
        }
      },
      onDeliveryResult: () => {
        if (committedDelivery) {
          return;
        }
        if (mediaUrls.length > 0) {
          // ponytail: a media payload reports per attachment here; committing
          // on the first attachment would mask a partial post-send failure as
          // delivered. The batch settles at onDeliveredPayload instead.
          return;
        }
        // onDeliveryResult fires on identified platform evidence, before
        // deliver-core awaits transcript mirroring (see mirrorDeliveredPayloads).
        // Commit here so a blocked requester writer holding the mirror cannot
        // keep a fully delivered payload pending.
        commitDirectDelivery();
      },
      // Complete-payload boundary: deliver-core reports the finished payload
      // fanout (every attachment of the media batch) here, still before it
      // awaits transcript mirroring. Settle now so the blocked mirror cannot
      // hold a fully delivered media batch pending until sendMessage returns.
      onDeliveredPayload: commitDirectDelivery,
      mirror: {
        sessionKey: params.requesterSessionKey,
        agentId,
        idempotencyKey,
      },
    });
    if (committedDelivery) {
      return committedDelivery;
    }
    if (sendResult.deliveryStatus === "suppressed") {
      const ambiguous = sendResult.suppressionReason === "adapter_returned_no_identity";
      return {
        delivered: false,
        path: "direct",
        reason: ambiguous ? undefined : "delivery_suppressed",
        error: ambiguous
          ? "text completion direct delivery could not be confirmed: adapter returned no identity"
          : `text completion direct delivery was suppressed: ${sendResult.suppressionReason ?? "unknown reason"}`,
        ...(ambiguous
          ? { disposition: "ambiguous" as const }
          : { disposition: "intentional_non_delivery" as const, terminal: true }),
      };
    }
    if (mediaUrls.length > 0) {
      // Fallback for sends that never reported the complete-payload boundary;
      // a partial failure must stay visible instead of being reported as
      // delivered.
      commitDirectDelivery();
      return committedDelivery;
    }
    return { delivered: true, path: "direct" };
  } catch (err) {
    if (committedDelivery) {
      // Post-send bookkeeping must never turn an identified delivery into a
      // retryable failure and send the same completion twice.
      return committedDelivery;
    }
    if (err instanceof SourceOwnerChangedError) {
      return sourceOwnerChangedResult();
    }
    if (hasAnnounceSendEvidence(err)) {
      // A platform send already began, so another attempt could duplicate the
      // visible completion; report the unconfirmed media instead.
      return {
        delivered: false,
        path: "direct",
        terminal: true,
        disposition: "ambiguous",
        error: `text completion direct delivery partially failed: ${summarizeDeliveryError(err)}`,
        ...(mediaUrls.length > 0 ? { missingMediaUrls: mediaUrls } : {}),
      };
    }
    if (params.signal?.aborted) {
      return { delivered: false, path: "none" };
    }
    return {
      delivered: false,
      path: "direct",
      error: `text completion direct delivery failed: ${summarizeDeliveryError(err)}`,
    };
  }
}

export function hasMessagingToolDeliveryToSource(
  result: {
    didDeliverSourceReplyViaMessageTool?: unknown;
    didSendViaMessagingTool?: unknown;
    messagingToolSentTargets?: unknown;
    messagingToolSourceReplyPayloads?: unknown;
  },
  deliveryTarget: Parameters<typeof sourceDeliveryTargetsMatch>[1],
  options?: { requireFinalReply?: boolean },
): boolean {
  const targets = Array.isArray(result.messagingToolSentTargets)
    ? result.messagingToolSentTargets
    : [];
  const sourceTargets = targets.filter((target) => {
    if (
      !target ||
      typeof target !== "object" ||
      Array.isArray(target) ||
      !deliveryTarget.channel ||
      !deliveryTarget.to
    ) {
      return false;
    }
    const record = target as Parameters<typeof sourceDeliveryTargetsMatch>[0];
    // Older source receipts omit `to`; explicit off-target sends must never satisfy it.
    const sourceTarget =
      typeof record.to === "string" && record.to.trim()
        ? record
        : { ...record, to: deliveryTarget.to };
    return sourceDeliveryTargetsMatch(sourceTarget, deliveryTarget);
  });
  if (options?.requireFinalReply) {
    const hasCommittedSourceDelivery =
      hasCommittedSourceReplyDeliveryEvidence(result) ||
      (hasMessagingToolDeliveryEvidence(result) && sourceTargets.length > 0);
    // Only current-source final markers count; another target's final cannot
    // turn a source progress update into the owed requester reply.
    return (
      hasCommittedSourceDelivery &&
      resolveExplicitFinalSourceReplyDeliveryEvidence({
        messagingToolSentTargets: sourceTargets,
        messagingToolSourceReplyPayloads: result.messagingToolSourceReplyPayloads,
      }) !== false
    );
  }
  if (
    hasCommittedSourceReplyDeliveryEvidence(result) ||
    hasUnaccountedMessagingToolAggregateEvidence({ ...result, didSendViaMessagingTool: false })
  ) {
    return true;
  }

  if (targets.length === 0 || !deliveryTarget.channel || !deliveryTarget.to) {
    return hasMessagingToolDeliveryEvidence(result);
  }

  return hasMessagingToolDeliveryEvidence(result) && sourceTargets.length > 0;
}
