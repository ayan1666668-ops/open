// Line tests cover resolving a tapped approval decision through the Gateway.
import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLineApprovalPostbackTap } from "./approval-postback.js";

const gateway = vi.hoisted(() => ({
  resolveApprovalOverGateway: vi.fn<(params: unknown) => Promise<ApprovalResolveResult>>(),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: gateway.resolveApprovalOverGateway,
}));

const approver = "U0123456789abcdef0123456789abcdef";
const cfg: OpenClawConfig = {
  channels: {
    line: { channelAccessToken: "token", channelSecret: "secret", allowFrom: [approver] },
  },
};
const common = {
  id: "approval-1",
  urlPath: "/approve/approval-1",
  createdAtMs: 1,
  expiresAtMs: 61_000,
  resolvedAtMs: 2,
  presentation: {
    kind: "exec",
    commandText: "date",
    allowedDecisions: ["allow-once", "allow-always", "deny"],
  },
} satisfies Partial<ApprovalResolveResult["approval"]>;

function tap(decision: "allow-once" | "allow-always" | "deny") {
  return resolveLineApprovalPostbackTap({
    cfg,
    accountId: "default",
    data: `line.approval=approval-1&line.approvalKind=exec&line.decision=${decision}`,
    senderId: approver,
  });
}

describe("resolveLineApprovalPostbackTap", () => {
  beforeEach(() => {
    gateway.resolveApprovalOverGateway.mockReset();
  });

  // The Gateway publishes the reviewer display name as the outcome's "Resolved by", so
  // the tap has to leave the sender-derived default in place.
  it("records the decision as the tapping approver and stays silent when it applies", async () => {
    gateway.resolveApprovalOverGateway.mockResolvedValue({
      applied: true,
      approval: { ...common, status: "allowed", decision: "allow-once", reason: "user" },
    });

    await expect(tap("allow-once")).resolves.toBeUndefined();
    expect(gateway.resolveApprovalOverGateway).toHaveBeenCalledWith({
      cfg,
      approvalId: "approval-1",
      approvalKind: "exec",
      decision: "allow-once",
      channel: "line",
      accountId: "default",
      senderId: approver,
    });
  });

  // LINE cannot remove the buttons after the first decision, so a later tap on the
  // same card must hear what stands instead of looking recorded.
  it.each([
    {
      name: "allowed always",
      approval: { ...common, status: "allowed", decision: "allow-always", reason: "user" },
      notice: "This approval was already resolved: Allowed always.",
    },
    {
      name: "denied",
      approval: { ...common, status: "denied", decision: "deny", reason: "user" },
      notice: "This approval was already resolved: Denied.",
    },
    {
      name: "expired",
      approval: { ...common, status: "expired", reason: "timeout" },
      notice: "This approval was already resolved: Expired.",
    },
  ] satisfies { name: string; approval: ApprovalResolveResult["approval"]; notice: string }[])(
    "tells a late tap the outcome that stands when the approval was $name",
    async ({ approval, notice }) => {
      gateway.resolveApprovalOverGateway.mockResolvedValue({ applied: false, approval });

      await expect(tap("deny")).resolves.toBe(notice);
    },
  );
});
