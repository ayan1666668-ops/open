// Line tests cover the native approval capability routing contract.
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
const OTHER_USER = "U11111111111111111111111111111111";
const GROUP = "C0123456789abcdef0123456789abcdef";

const { buildConfig, buildExecRequest, describeDelivery, checks } = createNativeApprovalTestFixture(
  {
    channel: "line",
    capability: lineApprovalCapability,
    buildConfig: ({ channel, approvals } = {}) => ({
      channels: {
        line: { channelAccessToken: "test-token-placeholder", channelSecret: "secret", ...channel },
      },
      approvals,
    }),
  },
);
const { suppressLocalSessionPrompt } = createLocalApprovalPromptTestFixture({
  channel: "line",
  buildConfig,
  suppress: shouldSuppressLocalLineExecApprovalPrompt,
});

const forwardingOnly = buildConfig({ approvals: { exec: { enabled: true } } });
const withApprover = buildConfig({
  channel: { allowFrom: [APPROVER] },
  approvals: { exec: { enabled: true } },
});

describe("line approval capability", () => {
  it("subscribes the native runtime to system-agent approval events", checks.systemAgentEvents);

  it(
    "does not enable exec or plugin native approvals from LINE credentials alone",
    checks.disabledByDefault,
  );

  // Forwarding without explicit approvers is a working setup on LINE: the card returns
  // to the one-to-one chat that raised the request and same-chat authorization applies.
  it("keeps approvals available and in-chat when forwarding is on without approvers", () => {
    expect(
      lineApprovalCapability.getExecInitiatingSurfaceState?.({
        cfg: forwardingOnly,
        accountId: "default",
        action: "approve",
      }),
    ).toEqual({ kind: "enabled" });
    expect(describeDelivery(forwardingOnly, buildExecRequest(`line:${OTHER_USER}`))).toMatchObject({
      enabled: true,
      preferredSurface: "origin",
    });
  });

  // A group postback carries no userId and a non-approver cannot approve, so neither
  // chat may host the card; approvers get it in their DMs and the chat is told so.
  it.each([
    {
      name: "a group without approvers keeps its text prompt",
      cfg: forwardingOnly,
      to: `line:group:${GROUP}`,
      expected: { enabled: false },
    },
    {
      name: "a group with approvers routes to approver DMs",
      cfg: withApprover,
      to: `line:group:${GROUP}`,
      expected: { enabled: true, preferredSurface: "approver-dm", notifyOriginWhenDmOnly: true },
    },
    {
      name: "a non-approver's chat routes to approver DMs",
      cfg: withApprover,
      to: `line:${OTHER_USER}`,
      expected: { enabled: true, preferredSurface: "approver-dm", notifyOriginWhenDmOnly: true },
    },
    {
      name: "an approver's own chat keeps the card",
      cfg: withApprover,
      to: `line:${APPROVER}`,
      expected: { enabled: true, preferredSurface: "origin" },
    },
  ])("$name", ({ cfg, to, expected }) => {
    expect(describeDelivery(cfg, buildExecRequest(to))).toMatchObject(expected);
  });

  it("suppresses the local prompt only where a card or routed notice replaces it", () => {
    expect(suppressLocalSessionPrompt(forwardingOnly, "agent:main:main")).toBe(true);
    expect(suppressLocalSessionPrompt(forwardingOnly, `agent:main:line:group:${GROUP}`)).toBe(
      false,
    );
    expect(suppressLocalSessionPrompt(withApprover, `agent:main:line:group:${GROUP}`)).toBe(true);
  });

  it("names the forwarding settings cards need, for the account that raised the request", () => {
    const params = { channel: "line", channelLabel: "LINE", accountId: "work" };

    const exec = lineApprovalCapability.describeExecApprovalSetup?.(params) ?? "";
    const plugin = lineApprovalCapability.describePluginApprovalSetup?.(params) ?? "";

    expect(exec).toContain("`approvals.exec.enabled`");
    expect(exec).toContain("`session` or `both`");
    expect(exec).toContain("`channels.line.accounts.work.allowFrom`");
    expect(plugin).toContain("`approvals.plugin.enabled`");
    // A plugin approval without a route never reaches the Gateway.
    expect(plugin).not.toContain("Web UI");
  });
});
