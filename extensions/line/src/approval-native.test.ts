// Line tests cover the native approval capability routing contract.
import { isImplicitSameChatApprovalAuthorization } from "openclaw/plugin-sdk/approval-auth-runtime";
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
import { linePlugin } from "./channel.js";

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
    expect(
      lineApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
        cfg: forwardingOnly,
        approvalKind: "exec",
        target: { channel: "line", to: `line:${APPROVER}`, source: "session" },
        request,
      }),
    ).toBe(false);
    expect(
      lineApprovalCapability.getActionAvailabilityState?.({
        cfg: buildConfig({ approvals: { plugin: { enabled: true } } }),
        accountId: "default",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ kind: "enabled" });
  });

  // Availability follows forwarding, not approvers: listing approvers alone does not
  // turn approvals on.
  it("keeps approvals disabled when approvers are listed but forwarding is off", () => {
    const approversOnly = buildConfig({ channel: { allowFrom: [APPROVER] } });

    expect(
      lineApprovalCapability.getExecInitiatingSurfaceState?.({
        cfg: approversOnly,
        accountId: "default",
        action: "approve",
      }),
    ).toEqual({ kind: "disabled" });
    expect(
      lineApprovalCapability.getActionAvailabilityState?.({
        cfg: approversOnly,
        accountId: "default",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ kind: "disabled" });
  });

  // A typed `/approve` without approvers is same-chat authorization, which still has to
  // pass command authorization; an explicit grant would skip it.
  it("keeps implicit same-chat authorization when no approvers are configured", () => {
    const authorization = lineApprovalCapability.authorizeActorAction?.({
      cfg: buildConfig({ approvals: { exec: { enabled: true } } }),
      senderId: "U11111111111111111111111111111111",
      action: "approve",
      approvalKind: "exec",
    });

    expect(authorization).toEqual({ authorized: true });
    expect(isImplicitSameChatApprovalAuthorization(authorization)).toBe(true);
  });

  // Native delivery replaces the forwarded prompt only in the chats it reaches; a
  // configured operations group is not one of them and keeps its text prompt.
  it("keeps forwarded prompts for targets native delivery does not reach", () => {
    const opsGroup = "line:group:C11111111111111111111111111111111";
    const cfg = buildConfig({
      channel: { allowFrom: [APPROVER] },
      approvals: {
        exec: { enabled: true, mode: "both", targets: [{ channel: "line", to: opsGroup }] },
      },
    });
    const request = buildExecRequest(`line:${APPROVER}`);
    const suppressed = (to: string, source: "session" | "target") =>
      lineApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
        cfg,
        approvalKind: "exec",
        target: { channel: "line", to, source },
        request,
      });

    expect(suppressed(opsGroup, "target")).toBe(false);
    expect(suppressed(`line:${APPROVER}`, "target")).toBe(true);
    expect(suppressed(`line:${APPROVER}`, "session")).toBe(true);

    // A group that raised the request gets the routed notice, not a second prompt, and
    // the approver's DM, reached here only as an approver and not as the origin, keeps
    // just the card.
    const raisingGroup = "line:group:C0123456789abcdef0123456789abcdef";
    const fromGroup = (to: string, source: "session" | "target") =>
      lineApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
        cfg,
        approvalKind: "exec",
        target: { channel: "line", to, source },
        request: buildExecRequest(raisingGroup),
      });
    expect(fromGroup(raisingGroup, "session")).toBe(true);
    expect(fromGroup(`line:${APPROVER}`, "target")).toBe(true);
  });

  it("suppresses the local prompt when approvers receive the card", () => {
    expect(suppressLocalSessionPrompt(configured, "agent:main:main")).toBe(true);
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

// The capability and the local-prompt hook only matter once the plugin registers them.
describe("line plugin approval wiring", () => {
  it("registers the approval capability on the LINE plugin", () => {
    expect(linePlugin.approvalCapability).toBe(lineApprovalCapability);
  });

  it("suppresses the local prompt through the registered outbound hook", () => {
    const suppress = linePlugin.outbound?.shouldSuppressLocalPayloadPrompt;
    expect(suppress).toBeDefined();
    const { suppressLocalSessionPrompt: throughPlugin } = createLocalApprovalPromptTestFixture({
      channel: "line",
      buildConfig,
      suppress: (input) => suppress?.(input) ?? false,
    });

    expect(throughPlugin(configured, "agent:main:main")).toBe(true);
  });
});
