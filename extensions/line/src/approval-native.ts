// Line plugin module wires the native approval capability for LINE accounts.
import { createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutes } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import { shouldSuppressLocalNativeExecApprovalPrompt } from "openclaw/plugin-sdk/approval-native-runtime";
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
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { hasLineCredentials } from "./account-helpers.js";
import { listLineAccountIds, resolveDefaultLineAccountId, resolveLineAccount } from "./accounts.js";
import { getLineApprovalApprovers, lineApprovalAuth } from "./approval-auth.js";
import { inferLineTargetChatType, normalizeLineMessagingTarget } from "./messaging-target.js";

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

// A group or room postback carries no `userId` (`GroupSource.userId` is documented as
// message-event only), so a card there could not name who tapped it. A card in a
// one-to-one chat is tapped by that user, who must be able to approve: anyone while no
// approvers are configured (same-chat authorization), otherwise only a listed approver.
// Requests that cannot stay in their chat go to approver DMs instead.
function isLineApprovalOriginAllowed(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  target: { to: string };
}): boolean {
  if (inferLineTargetChatType(params.target.to) !== "direct") {
    return false;
  }
  const approvers = getLineApprovalApprovers(params);
  return approvers.length === 0 || approvers.includes(params.target.to);
}

function describeLineApprovalSetup(
  approvalKind: "exec" | "plugin",
  accountId: string | null | undefined,
): string {
  const prefix =
    accountId && accountId !== "default" ? `channels.line.accounts.${accountId}` : "channels.line";
  return `LINE supports native approval cards. Set \`approvals.${approvalKind}.enabled\` to \`true\` with \`mode\` \`session\` or \`both\`. Cards stay in the one-to-one chat that raised the request; list approver LINE user IDs in \`${prefix}.allowFrom\` to route group requests to approvers.`;
}

const lineApproval = createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutes({
  channel: "line",
  channelLabel: "LINE",
  describeExecApprovalSetup: ({ accountId }) =>
    `Approve it from the Web UI or terminal UI for now. ${describeLineApprovalSetup("exec", accountId)}`,
  // A plugin approval without a route is cancelled before it reaches the Gateway, so
  // there is nothing to approve elsewhere.
  describePluginApprovalSetup: ({ accountId }) => describeLineApprovalSetup("plugin", accountId),
  // Keeps implicit same-chat authorization when no explicit approvers exist.
  authorizeActorAction: (params) => lineApprovalAuth.authorizeActorAction(params),
  routing: {
    defaultForwardingMode: "session",
    isTransportEnabled: isLineApprovalTransportEnabled,
    // Resolved per call, not at module evaluation: reading the account bindings while
    // this module loads breaks every consumer that partially mocks `./accounts.js`.
    listAccountIds: (cfg) => listLineAccountIds(cfg),
    resolveDefaultAccountId: (cfg) => resolveDefaultLineAccountId(cfg),
    normalizeTo: normalizeLineMessagingTarget,
    resolveApprovers: getLineApprovalApprovers,
    isOriginTargetAllowed: isLineApprovalOriginAllowed,
  },
  createNativeRuntime: (routing) =>
    createLazyChannelApprovalNativeRuntimeAdapter({
      capabilityBoundary: true,
      eventKinds: ["exec", "plugin", "system-agent"],
      isConfigured: ({ cfg, accountId }) =>
        routing.isNativeApprovalHandlerConfigured({ cfg, accountId }),
      shouldHandle: ({ cfg, accountId, approvalKind, request }) =>
        routing.shouldHandleApprovalRequest({ cfg, accountId, approvalKind, request }),
      load: async () => (await import("./approval-handler.runtime.js")).lineApprovalNativeRuntime,
    }),
});

/** Whether LINE can deliver native approval cards for one account. */
export function isLineNativeApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return lineApproval.routing.isNativeApprovalHandlerConfigured(params);
}

/** Whether one approval request should reach LINE as a native card. */
export function shouldHandleLineNativeApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: ChannelApprovalKind;
  request: LineApprovalRequest;
}): boolean {
  return lineApproval.routing.shouldHandleApprovalRequest(params);
}

function isLineGroupSessionKey(sessionKey?: string | null): boolean {
  const rest = parseAgentSessionKey(sessionKey)?.rest ?? sessionKey ?? "";
  return /^line:(group|room):/i.test(rest);
}

export function shouldSuppressLocalLineExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
  hint?: ChannelOutboundPayloadHint;
}): boolean {
  return shouldSuppressLocalNativeExecApprovalPrompt({
    ...params,
    isTransportEnabled: isLineApprovalTransportEnabled,
    // With approvers, a card reaches them and this chat gets a routed notice. Without
    // them the card can only return to a one-to-one chat, so a group keeps its prompt.
    isSessionRouteEligible: ({ cfg, accountId, metadata }) =>
      getLineApprovalApprovers({ cfg, accountId }).length > 0 ||
      !isLineGroupSessionKey(metadata.sessionKey),
  });
}

export const lineApprovalCapability: ChannelApprovalCapability = lineApproval.capability;
