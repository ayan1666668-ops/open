// Line plugin module owns the postback encoding for approval decision controls.
import { buildApprovalResolutionRef } from "openclaw/plugin-sdk/approval-reference-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import type { MessagePresentationAction } from "openclaw/plugin-sdk/interactive-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LINE_ACTION_DATA_LIMIT } from "./actions.js";
import { lineApprovalAuth } from "./approval-auth.js";

export type LineApprovalPostback = Extract<MessagePresentationAction, { type: "approval" }>;

const APPROVAL_PARAM = "line.approval";
const APPROVAL_KIND_PARAM = "line.approvalKind";
const DECISION_PARAM = "line.decision";
// Both params always carry `=`, so the marker cannot collide with the kind param.
const APPROVAL_MARKER = `${APPROVAL_PARAM}=`;

// The send-time action validator truncates over-limit postback data, which would
// leave a button pointing at a mangled approval, so the reference has to fit before
// it reaches that validator. LINE counts this field in UTF-16 units.
function fitsLinePostbackData(data: string): boolean {
  return data.length <= LINE_ACTION_DATA_LIMIT;
}

function encodeLineApprovalPostbackData(action: LineApprovalPostback, approvalRef: string): string {
  return new URLSearchParams({
    [APPROVAL_PARAM]: approvalRef,
    [APPROVAL_KIND_PARAM]: action.approvalKind,
    [DECISION_PARAM]: action.decision,
  }).toString();
}

/** Reserve the approval namespace even for postback data this module cannot read. */
export function hasLineApprovalPostbackData(data?: string | null): boolean {
  return data?.includes(APPROVAL_MARKER) === true;
}

/** Encode one approval decision into LINE postback data. */
export function buildLineApprovalPostbackData(action: LineApprovalPostback): string | undefined {
  const approvalId = normalizeOptionalString(action.approvalId);
  if (!approvalId) {
    return undefined;
  }
  const exact = encodeLineApprovalPostbackData(action, approvalId);
  if (fitsLinePostbackData(exact)) {
    return exact;
  }
  // Approval ids carry no length ceiling. A digest locator keeps the control
  // tappable instead of dropping it; Gateway authorization still guards the
  // canonical record this resolves to.
  const ref = encodeLineApprovalPostbackData(
    action,
    buildApprovalResolutionRef({ approvalId, approvalKind: action.approvalKind }),
  );
  return fitsLinePostbackData(ref) ? ref : undefined;
}

/** Read an approval decision back out of inbound postback data, if it carries one. */
export function parseLineApprovalPostbackData(data: string): LineApprovalPostback | undefined {
  if (!hasLineApprovalPostbackData(data)) {
    return undefined;
  }
  const params = new URLSearchParams(data);
  const approvalId = normalizeOptionalString(params.get(APPROVAL_PARAM));
  const approvalKind = normalizeOptionalString(params.get(APPROVAL_KIND_PARAM));
  const decision = normalizeOptionalString(params.get(DECISION_PARAM));
  if (
    !approvalId ||
    (approvalKind !== "exec" && approvalKind !== "plugin" && approvalKind !== "system-agent") ||
    (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny")
  ) {
    return undefined;
  }
  return { type: "approval", approvalId, approvalKind, decision };
}

/**
 * Record the decision a LINE tap carried, and return only what the approver must be told.
 *
 * A recorded decision stays silent: LINE echoes the chosen label through the action's
 * `displayText`, and the approval runtime publishes the outcome as its own message. A tap
 * that changes nothing, because the approval was already decided or is gone, says so.
 * Unreadable data returns nothing so the caller still consumes the reserved namespace.
 */
export async function resolveLineApprovalPostbackTap(params: {
  cfg: OpenClawConfig;
  accountId: string;
  data: string;
  senderId?: string;
}): Promise<string | undefined> {
  const callback = parseLineApprovalPostbackData(params.data);
  if (!callback) {
    return undefined;
  }
  const authorization = lineApprovalAuth.authorizeActorAction?.({
    cfg: params.cfg,
    accountId: params.accountId,
    senderId: params.senderId,
    action: "approve",
    approvalKind: callback.approvalKind,
  });
  if (authorization && !authorization.authorized) {
    // The approver allowlist owns this wording; it is written to be shown.
    return authorization.reason;
  }
  try {
    const { resolveApprovalOverGateway } =
      await import("openclaw/plugin-sdk/approval-gateway-runtime");
    // Reviewer identity is all-or-nothing for the gateway, and it is what binds the
    // resolution to this LINE account's approver custody. It also names the sender in
    // the published outcome, so no display name overrides it.
    const result = await resolveApprovalOverGateway({
      cfg: params.cfg,
      approvalId: callback.approvalId,
      approvalKind: callback.approvalKind,
      decision: callback.decision,
      ...(params.senderId
        ? { channel: "line", accountId: params.accountId, senderId: params.senderId }
        : {}),
    });
    if (!result || result.applied) {
      return undefined;
    }
    // A tap that raced the first decision changes nothing; the loser hears what stands.
    const { approval } = result;
    const { formatApprovalDecisionLabel } = await import("openclaw/plugin-sdk/approval-runtime");
    const outcome =
      approval.status === "allowed"
        ? formatApprovalDecisionLabel(approval.decision)
        : approval.status === "denied"
          ? "Denied"
          : approval.status === "expired"
            ? "Expired"
            : "Cancelled";
    return `This approval was already resolved: ${outcome}.`;
  } catch (error) {
    logVerbose(`line: approval decision could not be recorded: ${String(error)}`);
    if (isApprovalNotFoundError(error)) {
      // A resolved approval leaves the pending set within moments, and LINE keeps its
      // buttons forever, so this is the usual late tap. `/approve` would fail the same
      // way, and resolved, expired and restarted-away requests look identical here.
      return "That approval is no longer waiting for a decision.";
    }
    // The tap is the approver's only signal that anything happened; a swallowed
    // failure would leave the decision looking recorded while the run still waits.
    // True whether the request is still pending or was already decided elsewhere: the
    // command answers authoritatively either way, so the notice claims neither.
    return `Could not record that decision. Reply /approve ${callback.approvalId} ${callback.decision} instead.`;
  }
}
