// Line tests cover the native approval capability routing contract.
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import { createNativeApprovalTestFixture } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import { lineApprovalCapability } from "./approval-native.js";

const APPROVER = "U0123456789abcdef0123456789abcdef";

const { buildConfig, buildExecRequest, checks } = createNativeApprovalTestFixture({
  channel: "line",
  capability: lineApprovalCapability,
  buildConfig: ({ channel, approvals } = {}) => ({
    channels: {
      line: { channelAccessToken: "test-token-placeholder", channelSecret: "secret", ...channel },
    },
    approvals,
  }),
});

const configured = buildConfig({
  channel: { allowFrom: [APPROVER] },
  approvals: { exec: { enabled: true } },
});

describe("line approval capability", () => {
  it("subscribes the native runtime to system-agent approval events", checks.systemAgentEvents);

  it(
    "does not enable exec or plugin native approvals from LINE credentials alone",
    checks.disabledByDefault,
  );

  // A group postback carries no userId, so cards go to approver DMs and the chat that
  // raised the request has to be told where they went.
  it("delivers to approver DMs and notifies the originating chat", () => {
    const request = buildExecRequest("line:group:C0123456789abcdef0123456789abcdef");

    expect(
      lineApprovalCapability.native?.describeDeliveryCapabilities({
        cfg: configured,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toMatchObject({
      enabled: true,
      preferredSurface: "approver-dm",
      notifyOriginWhenDmOnly: true,
    });
  });

  // The route coordinator compares these keys to decide whether the originating chat
  // already has the card; a mismatch sends a "sent to DMs" notice into that same chat.
  it("treats a card sent to the approver who raised the request as delivered to its origin", async () => {
    const input = {
      cfg: configured,
      accountId: "default",
      approvalKind: "exec" as const,
      request: buildExecRequest(`line:${APPROVER}`),
    };
    const origin = await lineApprovalCapability.native?.resolveOriginTarget?.(input);
    const approverTargets = await lineApprovalCapability.native?.resolveApproverDmTargets?.(input);

    const originKey = origin ? buildChannelApprovalNativeTargetKey(origin) : undefined;

    expect(originKey).toBeDefined();
    expect(approverTargets?.map(buildChannelApprovalNativeTargetKey)).toEqual([originKey]);
  });

  it("names both settings native cards need, for the account that raised the request", () => {
    const params = { channel: "line", channelLabel: "LINE", accountId: "work" };

    const exec = lineApprovalCapability.describeExecApprovalSetup?.(params) ?? "";
    const plugin = lineApprovalCapability.describePluginApprovalSetup?.(params) ?? "";

    expect(exec).toContain("`approvals.exec.enabled`");
    expect(exec).toContain("`channels.line.accounts.work.allowFrom`");
    expect(plugin).toContain("`approvals.plugin.enabled`");
    expect(plugin).toContain("`channels.line.accounts.work.allowFrom`");
  });
});
