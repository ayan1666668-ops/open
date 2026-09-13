// Line tests cover the native approval capability routing contract.
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import {
  createLocalApprovalPromptTestFixture,
  createNativeApprovalTestFixture,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import {
  lineApprovalCapability,
  shouldSuppressLocalLineExecApprovalPrompt,
} from "./approval-native.js";

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

const { suppressLocalSessionPrompt } = createLocalApprovalPromptTestFixture({
  channel: "line",
  buildConfig,
  suppress: shouldSuppressLocalLineExecApprovalPrompt,
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

  // Forwarding without approvers must not answer "not configured" while the forwarder
  // sends a working `/approve` prompt; that chat keeps the prompt and command
  // authorization, and no card is drawn.
  it("keeps the typed /approve path when forwarding is on without approvers", () => {
    const forwardingOnly = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest(`line:${APPROVER}`);

    expect(
      lineApprovalCapability.getExecInitiatingSurfaceState?.({
        cfg: forwardingOnly,
        accountId: "default",
        action: "approve",
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      lineApprovalCapability.native?.describeDeliveryCapabilities({
        cfg: forwardingOnly,
        accountId: "default",
        approvalKind: "exec",
        request,
      })?.enabled,
    ).toBe(false);
    expect(suppressLocalSessionPrompt(forwardingOnly, "agent:main:main")).toBe(false);
  });

  it("sends the card to every listed approver", async () => {
    const second = "U11111111111111111111111111111111";
    const targets = await lineApprovalCapability.native?.resolveApproverDmTargets?.({
      cfg: buildConfig({
        channel: { allowFrom: [APPROVER, second] },
        approvals: { exec: { enabled: true } },
      }),
      accountId: "default",
      approvalKind: "exec",
      request: buildExecRequest("line:group:C0123456789abcdef0123456789abcdef"),
    });

    expect(targets?.map((target) => target.to)).toEqual([APPROVER, second]);
  });

  it("names the forwarding settings cards need, for the account that raised the request", () => {
    const params = { channel: "line", channelLabel: "LINE", accountId: "work" };

    const exec = lineApprovalCapability.describeExecApprovalSetup?.(params) ?? "";
    const plugin = lineApprovalCapability.describePluginApprovalSetup?.(params) ?? "";

    expect(exec).toContain("`approvals.exec.enabled`");
    expect(exec).toContain("`session` or `both`");
    expect(exec).toContain("`channels.line.accounts.work.allowFrom`");
    expect(plugin).toContain("`approvals.plugin.enabled`");
    expect(plugin).toContain("`channels.line.accounts.work.allowFrom`");
    // A plugin approval without a route never reaches the Gateway.
    expect(plugin).not.toContain("Web UI");
  });
});
