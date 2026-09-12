// Line plugin module wires the native approval capability for LINE accounts.
import { createApproverRestrictedNativeApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  createNativeApprovalChannelRouteGates,
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
  mapApprover: (approver, params) => ({
    to: `line:user:${approver}`,
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

const lineNativeApprovalCapability = createApproverRestrictedNativeApprovalCapability({
  channel: "line",
  channelLabel: "LINE",
  describeExecApprovalSetup: () =>
    "Approve it from the Web UI or terminal UI for now. LINE supports native approval cards in an approver's one-to-one chat. Configure `channels.line.allowFrom` with the LINE user ids allowed to approve.",
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
  // to approver DMs keeps the tap attributable and leaves group chats the origin
  // notice plus the `/approve` text path.
  resolveNativeDeliveryMode: () => "dm",
  requireMatchingTurnSourceChannel: true,
  resolveSuppressionAccountId: ({ target, request }) =>
    normalizeOptionalString(target.accountId) ??
    normalizeOptionalString(request.request.turnSourceAccountId),
  resolveOriginTarget: resolveLineOriginTarget,
  resolveApproverDmTargets: resolveLineApproverDmTargets,
  nativeRuntime: lineLazyApprovalNativeRuntime,
});

export const lineApprovalCapability: ChannelApprovalCapability = {
  ...lineNativeApprovalCapability,
  // Preserve implicit same-chat authorization when no explicit approvers exist.
  authorizeActorAction: (params) => lineApprovalAuth.authorizeActorAction?.(params),
};
