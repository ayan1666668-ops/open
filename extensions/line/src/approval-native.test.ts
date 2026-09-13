// Line tests cover the native approval capability routing contract.
import { isImplicitSameChatApprovalAuthorization } from "openclaw/plugin-sdk/approval-auth-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import {
  createLocalApprovalPromptTestFixture,
  createNativeApprovalTestFixture,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  lineApprovalCapability,
  shouldSuppressLocalLineExecApprovalPrompt,
  trackLineNativeApprovalStart,
} from "./approval-native.js";
import { linePlugin } from "./channel.js";

const APPROVER = "U0123456789abcdef0123456789abcdef";

const { buildConfig, buildExecRequest, buildPluginRequest, checks } =
  createNativeApprovalTestFixture({
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

  // LINE chats approved with typed `/approve` before cards existed. A `disabled` state
  // makes the Gateway expire a request no other client holds, so cards must never turn
  // that prompt off, whatever is configured. `checks.disabledByDefault` asserts the
  // opposite for channels that shipped cards from the start, so LINE does not run it.
  it("keeps same-chat /approve available whether or not cards are on", () => {
    const configs = [
      buildConfig(),
      buildConfig({ channel: { allowFrom: [APPROVER] } }),
      buildConfig({ approvals: { exec: { enabled: true } } }),
      configured,
    ];
    for (const cfg of configs) {
      for (const approvalKind of ["exec", "plugin", undefined] as const) {
        expect(
          lineApprovalCapability.getActionAvailabilityState?.({
            cfg,
            accountId: "default",
            action: "approve",
            ...(approvalKind ? { approvalKind } : {}),
          }),
        ).toEqual({ kind: "enabled" });
      }
    }
    // Without an exec-specific state, core reads exec availability from the state above.
    expect(lineApprovalCapability.getExecInitiatingSurfaceState).toBeUndefined();
  });

  // `allowFrom` is the DM allowlist first. Listing users there must not take `/approve`
  // away from command-authorized senders until cards are on for that approval kind.
  it("restricts decisions to listed approvers only for approval kinds whose cards are on", () => {
    const member = "U11111111111111111111111111111111";
    const authorize = (
      cfg: ReturnType<typeof buildConfig>,
      senderId: string,
      approvalKind: "exec" | "plugin",
    ) =>
      lineApprovalCapability.authorizeActorAction?.({
        cfg,
        accountId: "default",
        senderId,
        action: "approve",
        approvalKind,
      });
    const deferred = (authorization: ReturnType<typeof authorize>) =>
      authorization?.authorized === true && isImplicitSameChatApprovalAuthorization(authorization);

    // Cards on for exec: only the listed approver decides, explicitly.
    expect(authorize(configured, member, "exec")).toMatchObject({ authorized: false });
    const approverGrant = authorize(configured, APPROVER, "exec");
    expect(approverGrant).toEqual({ authorized: true });
    expect(isImplicitSameChatApprovalAuthorization(approverGrant)).toBe(false);

    // Cards off: plugin forwarding is off here, approvers alone turn nothing on,
    // forwarding without approvers draws no card, and a targets-only route sends text.
    expect(deferred(authorize(configured, member, "plugin"))).toBe(true);
    expect(
      deferred(authorize(buildConfig({ channel: { allowFrom: [APPROVER] } }), member, "exec")),
    ).toBe(true);
    expect(
      deferred(authorize(buildConfig({ approvals: { exec: { enabled: true } } }), member, "exec")),
    ).toBe(true);
    const targetsOnly = buildConfig({
      channel: { allowFrom: [APPROVER] },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "line", to: "line:group:C11111111111111111111111111111111" }],
        },
      },
    });
    expect(deferred(authorize(targetsOnly, member, "exec"))).toBe(true);
  });

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

  // Forwarding without approvers draws no card, so neither the forwarded prompt nor the
  // local one may be dropped.
  it("keeps the text prompts when forwarding is on without approvers", () => {
    const forwardingOnly = buildConfig({ approvals: { exec: { enabled: true } } });
    const request = buildExecRequest(`line:${APPROVER}`);

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
    const started = new AbortController();
    onTestFinished(() => started.abort());
    trackLineNativeApprovalStart({ cfg, accountId: "default", abortSignal: started.signal });
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

  // Cards start with the account, but forwarding hot-reloads. Until the account starts
  // with cards, and again once it stops, the forwarded prompt is the only thing that
  // chat receives, so it must not be dropped.
  it("keeps the forwarded prompt for an account that is not running cards", () => {
    const suppressed = () =>
      lineApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
        cfg: configured,
        approvalKind: "exec",
        target: { channel: "line", to: `line:${APPROVER}`, source: "session" },
        request: buildExecRequest(`line:${APPROVER}`),
      });

    expect(suppressed()).toBe(false);

    const started = new AbortController();
    trackLineNativeApprovalStart({
      cfg: configured,
      accountId: "default",
      abortSignal: started.signal,
    });
    expect(suppressed()).toBe(true);

    // A restart registers again before the previous run's abort arrives.
    const restarted = new AbortController();
    trackLineNativeApprovalStart({
      cfg: configured,
      accountId: "default",
      abortSignal: restarted.signal,
    });
    started.abort();
    expect(suppressed()).toBe(true);

    restarted.abort();
    expect(suppressed()).toBe(false);

    // A start whose account already stopped must not leave a record behind.
    const stopped = new AbortController();
    stopped.abort();
    trackLineNativeApprovalStart({
      cfg: configured,
      accountId: "default",
      abortSignal: stopped.signal,
    });
    expect(suppressed()).toBe(false);
  });

  // A target without an account falls back to the configured default, which can be the
  // raw config key; the start was recorded under the normalized id.
  it("matches a started default account whose config key is not normalized", () => {
    const cfg: OpenClawConfig = {
      channels: {
        line: {
          accounts: {
            Work: {
              channelAccessToken: "test-token-placeholder",
              channelSecret: "secret",
              allowFrom: [APPROVER],
            },
          },
        },
      },
      approvals: { exec: { enabled: true } },
    };
    const started = new AbortController();
    onTestFinished(() => started.abort());
    trackLineNativeApprovalStart({ cfg, accountId: "work", abortSignal: started.signal });

    expect(
      lineApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
        cfg,
        approvalKind: "exec",
        target: { channel: "line", to: `line:${APPROVER}`, source: "session" },
        // No account on the target or the turn, so the configured default decides.
        request: buildExecRequest(`line:${APPROVER}`, { turnSourceAccountId: undefined }),
      }),
    ).toBe(true);
  });

  // Starts are recorded under the resolved account id, which is lowercase; a forwarding
  // target can name the same account in another case.
  it("matches a started account named in another case", () => {
    const started = new AbortController();
    onTestFinished(() => started.abort());
    trackLineNativeApprovalStart({
      cfg: configured,
      accountId: "default",
      abortSignal: started.signal,
    });

    expect(
      lineApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
        cfg: configured,
        approvalKind: "exec",
        target: { channel: "line", to: `line:${APPROVER}`, accountId: "Default", source: "target" },
        request: buildExecRequest(`line:${APPROVER}`),
      }),
    ).toBe(true);
  });

  // The running handler decides with the config its account started with. A setting that
  // hot-reloads after that start, such as plugin forwarding or a wider agent filter, draws
  // no card until a restart, so its forwarded prompt stays.
  it("keeps the forwarded prompt for requests the started cards would not draw", () => {
    const started = new AbortController();
    onTestFinished(() => started.abort());
    trackLineNativeApprovalStart({
      cfg: buildConfig({
        channel: { allowFrom: [APPROVER] },
        approvals: { exec: { enabled: true, agentFilter: ["ops"] } },
      }),
      accountId: "default",
      abortSignal: started.signal,
    });
    const current = buildConfig({
      channel: { allowFrom: [APPROVER] },
      approvals: { exec: { enabled: true }, plugin: { enabled: true } },
    });
    const suppressed = (
      approvalKind: "exec" | "plugin",
      request: ReturnType<typeof buildExecRequest> | ReturnType<typeof buildPluginRequest>,
    ) =>
      lineApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
        cfg: current,
        approvalKind,
        target: { channel: "line", to: `line:${APPROVER}`, source: "session" },
        request,
      });

    expect(suppressed("plugin", buildPluginRequest(`line:${APPROVER}`))).toBe(false);
    expect(suppressed("exec", buildExecRequest(`line:${APPROVER}`))).toBe(false);
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
