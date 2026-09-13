// Line plugin module wires the native approval capability for LINE accounts.
import { createApproverRestrictedNativeApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  createNativeApprovalChannelRouteGates,
  createNativeApprovalForwardingFallbackSuppressor,
  createNativeApprovalMessagingTargetResolvers,
  shouldSuppressLocalNativeExecApprovalPrompt,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type {
  ChannelApprovalCapability,
  ChannelOutboundPayloadHint,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { hasLineCredentials } from "./account-helpers.js";
import { listLineAccountIds, resolveDefaultLineAccountId, resolveLineAccount } from "./accounts.js";
import { getLineApprovalApprovers, lineApprovalAuth } from "./approval-auth.js";
import { normalizeLineMessagingTarget } from "./messaging-target.js";

type LineApprovalRequest = ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest;

function isLineApprovalTransportEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const account = resolveLineAccount({
    cfg: params.cfg,
    ...(params.accountId ? { accountId: params.accountId } : {}),
  });
  return account.enabled && hasLineCredentials(account);
}

const lineApprovalTargetResolvers = createNativeApprovalMessagingTargetResolvers({
  channel: "line",
  normalizeTo: normalizeLineMessagingTarget,
});

const lineApprovalRouteGates = createNativeApprovalChannelRouteGates({
  channel: "line",
  defaultForwardingMode: "session",
  isTransportEnabled: isLineApprovalTransportEnabled,
  // Resolved per call, not at module evaluation: reading the account bindings while
  // this module loads breaks every consumer that partially mocks `./accounts.js`.
  listAccountIds: (cfg) => listLineAccountIds(cfg),
  resolveDefaultAccountId: (cfg) => resolveDefaultLineAccountId(cfg),
  normalizeForwardTarget: lineApprovalTargetResolvers.normalizeForwardTarget,
  resolveTurnSourceTarget: lineApprovalTargetResolvers.resolveTurnSourceTarget,
});

/** Whether LINE can deliver native approval cards for one account. */
export function isLineNativeApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return (
    lineApprovalRouteGates.canAnyApprovalPotentiallyRouteToChannel({
      ...params,
      nativeSessionOnly: true,
    }) && getLineApprovalApprovers(params).length > 0
  );
}

/** Whether one approval request should reach LINE as a native card. */
export function shouldHandleLineNativeApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ChannelApprovalKind;
  request: LineApprovalRequest;
}): boolean {
  return (
    lineApprovalRouteGates.shouldHandleApprovalRequest(params) &&
    getLineApprovalApprovers(params).length > 0
  );
}

export function shouldSuppressLocalLineExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
  hint?: ChannelOutboundPayloadHint;
}): boolean {
  return shouldSuppressLocalNativeExecApprovalPrompt({
    ...params,
    isNativeDeliveryEnabled: isLineNativeApprovalClientEnabled,
  });
}

const resolveLineOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "line",
  shouldHandleRequest: shouldHandleLineNativeApprovalRequest,
  resolveTurnSourceTarget: lineApprovalTargetResolvers.resolveTurnSourceTarget,
  resolveSessionTarget: lineApprovalTargetResolvers.resolveSessionTarget,
  normalizeTarget: lineApprovalTargetResolvers.normalizeTarget,
});

const resolveLineApproverDmTargets = createChannelApproverDmTargetResolver({
  shouldHandleRequest: shouldHandleLineNativeApprovalRequest,
  resolveApprovers: getLineApprovalApprovers,
  // Approvers are already normalized user ids, the same form the origin resolver
  // yields, so a card sent to the chat that raised the request counts as delivered
  // there instead of drawing a "sent to DMs" notice into that same chat.
  mapApprover: (approver, params) => ({
    to: approver,
    accountId: normalizeOptionalString(params.accountId),
  }),
});

const lineLazyApprovalNativeRuntime = createLazyChannelApprovalNativeRuntimeAdapter({
  capabilityBoundary: true,
  eventKinds: ["exec", "plugin", "system-agent"],
  isConfigured: ({ cfg, accountId }) => isLineNativeApprovalClientEnabled({ cfg, accountId }),
  shouldHandle: ({ cfg, accountId, approvalKind, request }) =>
    shouldHandleLineNativeApprovalRequest({ cfg, accountId, approvalKind, request }),
  load: async () => {
    const { lineApprovalNativeRuntime } = await import("./approval-handler.runtime.js");
    return lineApprovalNativeRuntime;
  },
});

// Both settings are required: approvers alone leave forwarding off, and forwarding
// alone has nobody to send the card to.
function describeLineApprovalSetup(
  approvalKind: "exec" | "plugin",
  accountId: string | null | undefined,
): string {
  const prefix =
    accountId && accountId !== "default" ? `channels.line.accounts.${accountId}` : "channels.line";
  return `LINE supports native approval cards in approvers' one-to-one chats. Set \`approvals.${approvalKind}.enabled\` to \`true\` with \`mode\` \`session\` or \`both\`, and list approver LINE user IDs in \`${prefix}.allowFrom\`.`;
}

const lineNativeApprovalCapability = createApproverRestrictedNativeApprovalCapability({
  channel: "line",
  channelLabel: "LINE",
  describeExecApprovalSetup: ({ accountId }) =>
    `Approve it from the Web UI or terminal UI for now. ${describeLineApprovalSetup("exec", accountId)}`,
  // A plugin approval without a route is cancelled before it reaches the Gateway, so
  // there is nothing to approve elsewhere.
  describePluginApprovalSetup: ({ accountId }) => describeLineApprovalSetup("plugin", accountId),
  listAccountIds: (cfg) => listLineAccountIds(cfg),
  hasApprovers: ({ cfg, accountId }) => getLineApprovalApprovers({ cfg, accountId }).length > 0,
  isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
    lineApprovalAuth.authorizeActorAction?.({
      cfg,
      accountId,
      senderId,
      action: "approve",
      approvalKind: "exec",
    })?.authorized ?? false,
  isPluginAuthorizedSender: ({ cfg, accountId, senderId }) =>
    lineApprovalAuth.authorizeActorAction?.({
      cfg,
      accountId,
      senderId,
      action: "approve",
      approvalKind: "plugin",
    })?.authorized ?? false,
  isNativeDeliveryEnabled: isLineNativeApprovalClientEnabled,
  // A group postback carries no `userId` (`GroupSource.userId` is documented as
  // message-event only), so a card in a group could not name who tapped it. Routing
  // to approver DMs keeps the tap attributable; the chat that raised the request is
  // told where the approval went.
  resolveNativeDeliveryMode: () => "dm",
  notifyOriginWhenDmOnly: true,
  resolveOriginTarget: resolveLineOriginTarget,
  resolveApproverDmTargets: resolveLineApproverDmTargets,
  nativeRuntime: lineLazyApprovalNativeRuntime,
});

// Forwarding is dropped only for the chats native delivery already covers: the
// originating chat (its card or routed notice) and the approver DMs. Any other
// configured target, such as an operations group, still gets the text prompt.
const shouldSuppressLineForwardingFallback = createNativeApprovalForwardingFallbackSuppressor<
  NonNullable<ReturnType<typeof resolveLineOriginTarget>>
>({
  channel: "line",
  normalizeForwardTarget: lineApprovalTargetResolvers.normalizeForwardTarget,
  resolveAccountId: ({ target, request }) =>
    normalizeOptionalString(target.accountId) ??
    normalizeOptionalString(request.request.turnSourceAccountId),
  // Native targets carry the account; a forwarding target without one matches them
  // under the account the request resolved to.
  resolveForwardingTargetForMatch: ({ forwardingTarget, accountId }) => ({
    ...forwardingTarget,
    accountId,
  }),
  isSessionRouteEligible: shouldHandleLineNativeApprovalRequest,
  isExplicitTargetEligible: shouldHandleLineNativeApprovalRequest,
  resolveOriginTarget: resolveLineOriginTarget,
  resolveApproverDmTargets: resolveLineApproverDmTargets,
});

// Availability follows forwarding, as the forwarding-routes builder defines it, not
// approvers: with forwarding on and no approvers listed, a LINE chat keeps its typed
// `/approve` prompt instead of being told approvals are not configured while the
// forwarder sends that same prompt. Cards still require approvers.
const lineApprovalAvailability: (
  enabled: boolean,
) => ReturnType<NonNullable<ChannelApprovalCapability["getExecInitiatingSurfaceState"]>> = (
  enabled,
) => (enabled ? { kind: "enabled" } : { kind: "disabled" });

export const lineApprovalCapability: ChannelApprovalCapability = {
  ...lineNativeApprovalCapability,
  delivery: {
    ...lineNativeApprovalCapability.delivery,
    shouldSuppressForwardingFallback: shouldSuppressLineForwardingFallback,
  },
  getActionAvailabilityState: ({ cfg, accountId, approvalKind }) =>
    lineApprovalAvailability(
      approvalKind
        ? lineApprovalRouteGates.canApprovalPotentiallyRouteToChannel({
            cfg,
            accountId,
            approvalKind,
          })
        : lineApprovalRouteGates.canAnyApprovalPotentiallyRouteToChannel({ cfg, accountId }),
    ),
  getExecInitiatingSurfaceState: ({ cfg, accountId }) =>
    lineApprovalAvailability(
      lineApprovalRouteGates.canApprovalPotentiallyRouteToChannel({
        cfg,
        accountId,
        approvalKind: "exec",
      }),
    ),
  // Preserve implicit same-chat authorization when no explicit approvers exist.
  authorizeActorAction: (params) => lineApprovalAuth.authorizeActorAction?.(params),
};
