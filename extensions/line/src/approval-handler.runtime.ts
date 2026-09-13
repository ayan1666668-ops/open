// Line plugin module implements the native approval runtime for LINE accounts.
import {
  buildChannelApprovalExpiredText,
  buildChannelApprovalResolvedText,
  createChannelApprovalNativeRuntimeAdapter,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildLinePendingApprovalCard, type LinePendingApprovalCard } from "./approval-card.js";
import {
  isLineNativeApprovalClientEnabled,
  shouldHandleLineNativeApprovalRequest,
} from "./approval-native.js";
import { normalizeLineMessagingTarget } from "./messaging-target.js";
import { pushFlexMessage, pushMessageLine } from "./send.js";

type LinePreparedTarget = { to: string; accountId?: string };
type LinePendingEntry = { to: string; accountId?: string; messageId?: string };

// The view already publishes each decision as the command a non-interactive surface
// would use, so the notice quotes those instead of composing its own syntax.
function buildApprovalCommandFallbackText(params: {
  approvalId: string;
  commands: readonly string[];
}): string {
  return [
    `⚠️ Could not deliver the approval card for ${params.approvalId}. Reply with one of:`,
    ...params.commands,
  ].join("\n");
}

async function sendLineApprovalText(params: {
  target: LinePreparedTarget;
  text: string;
  cfg: OpenClawConfig;
  logLabel: string;
}): Promise<void> {
  try {
    await pushMessageLine(params.target.to, params.text, {
      cfg: params.cfg,
      ...(params.target.accountId ? { accountId: params.target.accountId } : {}),
    });
  } catch (error) {
    // Same contract as every other LINE send: a partial-delivery error means LINE
    // already showed this text, so it is not a failure to report.
    logVerbose(`${params.logLabel}: ${String(error)}`);
  }
}

export const lineApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  LinePendingApprovalCard | null,
  LinePreparedTarget,
  LinePendingEntry,
  never,
  { text: string }
>({
  eventKinds: ["exec", "plugin", "system-agent"],
  availability: {
    isConfigured: ({ cfg, accountId }) => isLineNativeApprovalClientEnabled({ cfg, accountId }),
    shouldHandle: ({ cfg, accountId, approvalKind, request }) =>
      shouldHandleLineNativeApprovalRequest({ cfg, accountId, approvalKind, request }),
  },
  presentation: {
    buildPendingPayload: ({ view, nowMs }) => buildLinePendingApprovalCard({ view, nowMs }),
    // LINE cannot edit a delivered message, so the terminal state is a new message
    // the transport sends, the way Signal and iMessage publish theirs.
    buildResolvedResult: ({ request, resolved, view }) => ({
      kind: "update",
      payload: { text: buildChannelApprovalResolvedText({ request, resolved, view }) },
    }),
    buildExpiredResult: ({ request, view }) => ({
      kind: "update",
      payload: { text: buildChannelApprovalExpiredText({ request, view }) },
    }),
  },
  transport: {
    prepareTarget: ({ accountId, plannedTarget }) => {
      const to = normalizeLineMessagingTarget(plannedTarget.target.to);
      if (!to) {
        return null;
      }
      const preparedAccountId = normalizeOptionalString(accountId);
      const target: LinePreparedTarget = {
        to,
        ...(preparedAccountId ? { accountId: preparedAccountId } : {}),
      };
      return { dedupeKey: buildChannelApprovalNativeTargetKey({ to }), target };
    },
    deliverPending: async ({ cfg, preparedTarget, pendingPayload, view, request }) => {
      if (!pendingPayload) {
        // Native delivery already suppressed the local prompt, so an undrawable card
        // still owes the approver a way to decide.
        await sendLineApprovalText({
          target: preparedTarget,
          cfg,
          text: buildApprovalCommandFallbackText({
            approvalId: request.id,
            commands: view.actions.map(({ command }) => command),
          }),
          logLabel: "line approvals: command fallback failed",
        });
        return null;
      }
      try {
        const sent = await pushFlexMessage(
          preparedTarget.to,
          pendingPayload.altText,
          pendingPayload.bubble,
          {
            cfg,
            ...(preparedTarget.accountId ? { accountId: preparedTarget.accountId } : {}),
          },
        );
        return { ...preparedTarget, messageId: sent.messageId };
      } catch (error) {
        // LINE accepted the card and only its receipt was unreadable. The card is on the
        // approver's screen, so it is tracked like any delivered card: the outcome still
        // gets published, and the origin is not told the request went undelivered.
        if (isChannelPartialDeliveryError(error)) {
          return { ...preparedTarget };
        }
        throw error;
      }
    },
    updateEntry: async ({ cfg, entry, payload }) => {
      await sendLineApprovalText({
        target: entry,
        cfg,
        text: payload.text,
        logLabel: "line approvals: terminal notice failed",
      });
    },
  },
  observe: {
    onDeliveryError: ({ accountId, cfg, error, plannedTarget, request, pendingPayload, view }) => {
      logVerbose(`line approvals: failed to deliver request ${request.id}: ${String(error)}`);
      const to = normalizeLineMessagingTarget(plannedTarget.target.to);
      if (!to || !pendingPayload) {
        return;
      }
      const preparedAccountId = normalizeOptionalString(accountId);
      void sendLineApprovalText({
        target: { to, ...(preparedAccountId ? { accountId: preparedAccountId } : {}) },
        cfg,
        text: buildApprovalCommandFallbackText({
          approvalId: request.id,
          commands: view.actions.map(({ command }) => command),
        }),
        logLabel: "line approvals: delivery fallback failed",
      });
    },
  },
});
