// Tests agent runner utility decisions for fallbacks, channels, and reasoning tags.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
import type { FollowupRun } from "./queue.js";

const hoisted = vi.hoisted(() => {
  const getChannelPluginMock = vi.fn();
  const isReasoningTagProviderMock = vi.fn();
  return {
    getChannelPluginMock,
    isReasoningTagProviderMock,
  };
});

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => hoisted.getChannelPluginMock(...args),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: (...args: unknown[]) => hoisted.isReasoningTagProviderMock(...args),
}));

const {
  buildThreadingToolContext,
  buildEmbeddedRunExecutionParams,
  mintReplyMessageActionTurnCapability,
  resolveModelFallbackOptions,
} = await import("./agent-runner-utils.js");
const {
  resolveMessageActionTurnAuthorization,
  resolveMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} = await import("../../gateway/message-action-turn-capability.js");
const { buildEmbeddedRunBaseParams: buildEmbeddedRunBaseParamsCore } =
  await import("./agent-runner-run-params.js");
const { setChannelSourceTurnId } = await import("./source-turn-id.js");

function buildEmbeddedRunBaseParams(
  params: Omit<Parameters<typeof buildEmbeddedRunBaseParamsCore>[0], "isReasoningTagProvider">,
) {
  return buildEmbeddedRunBaseParamsCore({
    ...params,
    isReasoningTagProvider: hoisted.isReasoningTagProviderMock,
  });
}

function makeRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun["run"] {
  return {
    sessionId: "session-1",
    agentId: "agent-1",
    config: {
      agents: {
        defaults: { model: { primary: "openai/gpt-4.1", fallbacks: ["openai/fallback-model"] } },
      },
      models: { providers: {} },
    },
    executionSelection: {
      model: { provider: "openai", id: "gpt-4.1" },
      executor: { kind: "harness", id: "openclaw" },
    },
    agentDir: "/tmp/agent",
    sessionKey: "agent:agent-1:session",
    sessionFile: "/tmp/session.json",
    workspaceDir: "/tmp/workspace",
    skillsSnapshot: { prompt: "", skills: [] },
    ownerNumbers: ["+15550001"],
    enforceFinalTag: false,
    thinkingCatalog: [
      { provider: "openai", id: "gpt-4.1", input: ["text"] },
      { provider: "openai", id: "gpt-4.1-mini", input: ["text"] },
      { provider: "minimax", id: "MiniMax-M2.7", input: ["text"] },
      { provider: "anthropic", id: "claude-sonnet-4-6", input: ["text"] },
    ],
    thinkLevel: "medium",
    verboseLevel: "off",
    reasoningLevel: "off",
    execOverrides: {},
    bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
    timeoutMs: 60_000,
    blockReplyBreak: "message_end",
    ...overrides,
  };
}

describe("agent-runner-utils", () => {
  beforeEach(() => {
    hoisted.getChannelPluginMock.mockReset();
    hoisted.isReasoningTagProviderMock.mockReset();
    hoisted.isReasoningTagProviderMock.mockReturnValue(false);
  });

  describe("message action turn capabilities", () => {
    const source = {
      agentId: "agent-1",
      runId: "dashboard-run",
      sessionKey: "agent:agent-1:dashboard:reads",
      sessionId: "session-1",
    };
    function makeTurn(): Parameters<typeof mintReplyMessageActionTurnCapability>[0] {
      return {
        followupRun: {
          prompt: "read channel",
          enqueuedAt: 0,
          run: makeRun({ sessionKey: source.sessionKey }),
        },
        sessionCtx: { Provider: "webchat" },
        opts: {
          runId: source.runId,
          dashboardReadAdmission: { ...source, assertCurrent: vi.fn() },
        },
        isHeartbeat: false,
      };
    }

    it("mints host-only dashboard authority for the original admitted identity", () => {
      const turn = makeTurn();
      const now = Date.now();
      const token = mintReplyMessageActionTurnCapability(turn, source.runId);
      const lookup = { ...source, token };
      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(now + turn.followupRun.run.timeoutMs + 60_001);
      try {
        const authority = resolveMessageActionTurnAuthorization(lookup);
        expect(authority?.assertDashboardReadCurrent).toBeTypeOf("function");
        authority?.assertDashboardReadCurrent?.();
        expect(turn.opts?.dashboardReadAdmission?.assertCurrent).toHaveBeenCalled();
        expect(resolveMessageActionTurnCapability(lookup)).not.toHaveProperty(
          "assertDashboardReadCurrent",
        );
      } finally {
        clock.mockRestore();
        revokeMessageActionTurnCapability(token);
      }
    });

    it("rejects inherited dashboard options outside their admitted source", () => {
      const turn = makeTurn();
      const queued = { ...turn, opts: { ...turn.opts, runId: "followup-run" } };
      const mismatches = [
        { agentId: "another-agent" },
        { sessionKey: "agent:agent-1:dashboard:another" },
        { sessionId: "another-session" },
      ].map((change) => {
        const mismatch = makeTurn();
        Object.assign(mismatch.followupRun.run, change);
        return mismatch;
      });
      for (const candidate of [
        queued,
        ...mismatches,
        { ...turn, isHeartbeat: true },
        { ...turn, opts: { runId: source.runId } },
      ]) {
        const token = mintReplyMessageActionTurnCapability(
          candidate,
          candidate.opts?.runId ?? source.runId,
        );
        revokeMessageActionTurnCapability(token);
        expect(token).toBeUndefined();
      }
      expect(turn.opts?.dashboardReadAdmission?.assertCurrent).not.toHaveBeenCalled();
    });

    it("keeps native Discord context when dashboard options are present", () => {
      const turn = makeTurn();
      turn.sessionCtx = { Provider: "discord", To: "channel:123", AccountId: "work" };
      const token = mintReplyMessageActionTurnCapability(turn, source.runId);
      try {
        const authority = resolveMessageActionTurnAuthorization({ ...source, token });
        expect(authority).toMatchObject({
          requesterAccountId: "work",
          toolContext: { currentChannelProvider: "discord", currentChannelId: "channel:123" },
        });
        expect(authority?.assertDashboardReadCurrent).toBeUndefined();
        expect(turn.opts?.dashboardReadAdmission?.assertCurrent).not.toHaveBeenCalled();
      } finally {
        revokeMessageActionTurnCapability(token);
      }
    });
  });

  it.each(["configured", "explicit"] as const)(
    "resolves fallback permission from accepted intent: %s",
    (fallbackPermission) => {
      const run = makeRun();
      const resolved = resolveModelFallbackOptions(run, run.config, {
        executionSelection: {
          state: "accepted",
          selection: run.executionSelection,
          fallbackPermission,
        },
      });
      expect(resolved.provider).toBe("openai");
      expect(resolved.model).toBe("gpt-4.1");
      expect(resolved.requestedRouteResolution).toBe("resolved");
      expect(resolved.agentId).toBe(run.agentId);
      expect(resolved.sessionKey).toBe(run.sessionKey);
      expect(resolved.fallbacksOverride).toEqual(
        fallbackPermission === "configured" ? ["openai/fallback-model"] : [],
      );
      expect(resolved.modelFallbackAvailability.kind).toBe(
        fallbackPermission === "configured" ? "active" : "disabled_by_model_override",
      );
    },
  );

  it("uses accepted intent after a temporary fallback observation", () => {
    const run = makeRun();
    const resolved = resolveModelFallbackOptions(run, run.config, {
      modelProvider: "another-provider",
      model: "another-model",
      executionSelection: {
        state: "accepted",
        selection: run.executionSelection,
        fallbackPermission: "configured",
      },
    });
    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("gpt-4.1");
    expect(resolved.fallbacksOverride).toEqual(["openai/fallback-model"]);
  });

  it.each(["run", "entry"] as const)(
    "disables fallback options for the %s's model lock",
    (owner) => {
      const run = makeRun({ modelSelectionLocked: owner === "run" });
      const resolved = resolveModelFallbackOptions(run, run.config, {
        modelSelectionLocked: owner === "entry",
      });
      expect(resolved.fallbacksOverride).toEqual([]);
      expect(resolved.modelFallbackAvailability.kind).toBe("disabled_by_model_selection_lock");
    },
  );

  it("threads prompt cache affinity through embedded execution params", async () => {
    const run = makeRun();

    const resolved = await buildEmbeddedRunExecutionParams({
      run: {
        ...run,
        ...resolveRunAuthProfile(run, "openai"),
        executionSelection: {
          model: { provider: "openai", id: "gpt-4.1-mini" },
          executor: { kind: "harness", id: "openclaw" },
        },
      },
      sessionCtx: { Provider: "webchat" },
      hasRepliedRef: undefined,
      runId: "run-1",
      promptCacheKey: "stable-session-cache-key",
    });

    expect(resolved.runBaseParams.runId).toBe("run-1");
    expect(resolved.runBaseParams.promptCacheKey).toBe("stable-session-cache-key");
    expect(resolved.runBaseParams.requestedRouteResolution).toBe("resolved");
  });

  it("uses the queued conversation policy snapshot", async () => {
    const run = makeRun({ conversationToolPolicy: { deny: ["exec"] } });

    const resolved = await buildEmbeddedRunExecutionParams({
      run: {
        ...run,
        ...resolveRunAuthProfile(run, "openai"),
        executionSelection: {
          model: { provider: "openai", id: "gpt-4.1-mini" },
          executor: { kind: "harness", id: "openclaw" },
        },
      },
      sessionCtx: {
        Provider: "telegram",
        ConversationToolPolicy: { deny: ["write"] },
      },
      hasRepliedRef: undefined,
      runId: "run-1",
    });

    expect(resolved.runBaseParams.conversationToolPolicy).toEqual({ deny: ["exec"] });
  });

  it("uses session chat type over stale queued metadata for embedded execution params", async () => {
    const run = makeRun({ chatType: "direct" });

    const resolved = await buildEmbeddedRunExecutionParams({
      run: {
        ...run,
        ...resolveRunAuthProfile(run, "openai"),
        executionSelection: {
          model: { provider: "openai", id: "gpt-4.1-mini" },
          executor: { kind: "harness", id: "openclaw" },
        },
      },
      sessionCtx: { Provider: "discord", ChatType: "Channel" },
      hasRepliedRef: undefined,
      runId: "run-1",
    });

    expect(resolved.embeddedContext.chatType).toBe("channel");
    expect("chatType" in resolved.runBaseParams).toBe(false);
  });

  it("disables embedded model fallbacks for a model-locked run", async () => {
    const run = makeRun({ modelSelectionLocked: true });
    const resolved = await buildEmbeddedRunBaseParams({
      run: {
        ...run,
        executionSelection: {
          model: { provider: "openai", id: "gpt-4.1-mini" },
          executor: { kind: "harness", id: "openclaw" },
        },
      },
      runId: "run-1",
    });

    expect(resolved.modelFallbacksOverride).toEqual([]);
    expect(resolved.modelSelectionLocked).toBe(true);
  });

  it("does not force final-tag enforcement for minimax providers", async () => {
    const run = makeRun({ enforceFinalTag: false });
    const resolved = await buildEmbeddedRunBaseParams({
      run: {
        ...run,
        executionSelection: {
          model: { provider: "minimax", id: "MiniMax-M2.7" },
          executor: { kind: "harness", id: "openclaw" },
        },
      },
      runId: "run-1",
    });

    expect(resolved.enforceFinalTag).toBe(false);
    expect(hoisted.isReasoningTagProviderMock).toHaveBeenCalledWith("minimax", {
      config: run.config,
      workspaceDir: run.workspaceDir,
      modelId: "MiniMax-M2.7",
    });
  });

  it("builds embedded contexts and scopes auth profile by provider", async () => {
    const run = makeRun({
      authProfileId: "profile-openai",
      authProfileIdSource: "auto",
      chatType: "direct",
    });

    const resolved = await buildEmbeddedRunExecutionParams({
      run: {
        ...run,
        ...resolveRunAuthProfile(run, "anthropic"),
        executionSelection: {
          model: { provider: "anthropic", id: "claude-sonnet-4-6" },
          executor: { kind: "harness", id: "openclaw" },
        },
      },
      sessionCtx: {
        Provider: "OpenAI",
        To: "channel-1",
        ChatType: "Channel",
        NativeChannelId: "native-chat-1",
        SenderId: "sender-1",
        ChannelContext: {
          sender: { id: "sender-1", providerUserId: "provider-user-1" },
          chat: { id: "native-chat-1", topicId: "topic-1" },
        },
        MemberRoleIds: ["admin", " ", "operator"],
      },
      hasRepliedRef: undefined,
      runId: "run-1",
    });

    expect(resolved.runBaseParams.authProfileId).toBeUndefined();
    expect(resolved.runBaseParams.authProfileIdSource).toBeUndefined();
    expect(resolved.embeddedContext.sessionId).toBe(run.sessionId);
    expect(resolved.embeddedContext.sessionKey).toBe(run.sessionKey);
    expect(resolved.embeddedContext.agentId).toBe(run.agentId);
    expect(resolved.embeddedContext.messageProvider).toBe("openai");
    expect(resolved.embeddedContext.chatType).toBe("channel");
    expect(resolved.embeddedContext.messageTo).toBe("channel-1");
    expect(resolved.embeddedContext.chatId).toBe("native-chat-1");
    expect(resolved.embeddedContext.memberRoleIds).toEqual(["admin", "operator"]);
    expect(resolved.embeddedContext.currentInboundAudio).toBe(false);
    expect(resolved.senderContext).toEqual({
      senderId: "sender-1",
      channelContext: {
        sender: { id: "sender-1", providerUserId: "provider-user-1" },
        chat: { id: "native-chat-1", topicId: "topic-1" },
      },
      senderName: undefined,
      senderUsername: undefined,
      senderE164: undefined,
    });
  });

  it("prefers OriginatingChannel over Provider for messageProvider", async () => {
    const run = makeRun({
      agentAccountId: "work",
      chatType: "group",
      conversationRoutePeerId: "queued-peer",
    });

    const resolved = await buildEmbeddedRunExecutionParams({
      run: {
        ...run,
        ...resolveRunAuthProfile(run, "openai"),
        executionSelection: {
          model: { provider: "openai", id: "gpt-4.1-mini" },
          executor: { kind: "harness", id: "openclaw" },
        },
      },
      sessionCtx: {
        Provider: "heartbeat",
        OriginatingChannel: "Telegram",
        OriginatingTo: "268300329",
        ConversationRoutePeerId: "later-peer",
      },
      hasRepliedRef: undefined,
      runId: "run-1",
    });

    expect(resolved.embeddedContext.messageProvider).toBe("telegram");
    expect(resolved.embeddedContext.agentAccountId).toBe("work");
    expect(resolved.embeddedContext.chatType).toBe("group");
    expect(resolved.embeddedContext.conversationRoutePeerId).toBe("queued-peer");
    expect(resolved.embeddedContext.messageTo).toBe("268300329");
  });

  it("hydrates the queued route before resolving channel threading policy", async () => {
    hoisted.getChannelPluginMock.mockReturnValue({
      threading: {
        buildToolContext: ({
          accountId,
          context,
        }: {
          accountId?: string | null;
          context: {
            ChatType?: string;
            MessageThreadId?: string | number;
            NativeChannelId?: string;
            To?: string;
          };
        }) => ({
          currentChannelId: context.NativeChannelId ?? context.To,
          currentMessagingTarget: context.To,
          currentThreadTs:
            context.MessageThreadId != null ? String(context.MessageThreadId) : undefined,
          replyToMode: accountId === "work" && context.ChatType === "direct" ? "off" : "all",
        }),
      },
    });
    const run = makeRun({ agentAccountId: "work", chatType: "direct" });

    const resolved = await buildEmbeddedRunExecutionParams({
      run: {
        ...run,
        ...resolveRunAuthProfile(run, "openai"),
        executionSelection: {
          model: { provider: "openai", id: "gpt-4.1-mini" },
          executor: { kind: "harness", id: "openclaw" },
        },
      },
      sessionCtx: {
        Provider: "cron-event",
        NativeChannelId: "D1",
        SessionKey: "agent:main:main:thread:1234:42",
        MessageThreadId: "stale-topic",
      },
      replyRoute: {
        originatingChannel: "slack",
        originatingTo: "user:U1",
        originatingAccountId: "work",
        originatingChatType: "direct",
        originatingThreadId: 42,
      },
      hasRepliedRef: undefined,
      runId: "run-1",
    });

    expect(resolved.embeddedContext.messageProvider).toBe("slack");
    expect(resolved.embeddedContext.messageTo).toBe("user:U1");
    expect(resolved.embeddedContext.currentChannelId).toBe("D1");
    expect(resolved.embeddedContext.currentMessagingTarget).toBe("user:U1");
    expect(resolved.embeddedContext.messageThreadId).toBe(42);
    expect(resolved.embeddedContext.currentThreadTs).toBe("42");
    expect(resolved.embeddedContext.agentAccountId).toBe("work");
    expect(resolved.embeddedContext.chatType).toBe("direct");
    expect(resolved.embeddedContext.replyToMode).toBe("off");
  });

  it("carries a prepared direct-message reply mode into generic message tools", async () => {
    const run = makeRun();
    const replyRoute = {
      originatingChannel: "reef",
      originatingTo: "reef:remote-agent",
      originatingReplyToMode: "all",
    } satisfies Pick<
      FollowupRun,
      "originatingChannel" | "originatingTo" | "originatingReplyToMode"
    >;

    const resolved = await buildEmbeddedRunExecutionParams({
      run: {
        ...run,
        ...resolveRunAuthProfile(run, "openai"),
        executionSelection: {
          model: { provider: "openai", id: "gpt-4.1-mini" },
          executor: { kind: "harness", id: "openclaw" },
        },
      },
      replyRoute,
      sessionCtx: {
        Provider: "reef",
        To: "reef:local-agent",
        MessageSid: "message-1",
      },
      hasRepliedRef: undefined,
      runId: "run-1",
    });

    expect(resolved.embeddedContext).toMatchObject({
      currentChannelId: "reef:remote-agent",
      currentChannelProvider: "reef",
      currentMessageId: "message-1",
      replyToMode: "all",
    });
  });

  it("carries inbound audio context into embedded message tools", async () => {
    const run = makeRun();

    const resolved = await buildEmbeddedRunExecutionParams({
      run: {
        ...run,
        ...resolveRunAuthProfile(run, "openai"),
        executionSelection: {
          model: { provider: "openai", id: "gpt-4.1-mini" },
          executor: { kind: "harness", id: "openclaw" },
        },
      },
      sessionCtx: {
        Provider: "telegram",
        To: "268300329",
        media: [{ contentType: "audio/ogg; codecs=opus", kind: "audio" }],
        BodyForCommands: "",
      },
      hasRepliedRef: undefined,
      runId: "run-1",
    });

    expect(resolved.embeddedContext.currentInboundAudio).toBe(true);
  });

  it("uses telegram plugin threading context for native commands", () => {
    hoisted.getChannelPluginMock.mockReturnValue({
      threading: {
        buildToolContext: ({
          context,
          hasRepliedRef,
        }: {
          context: { To?: string; MessageThreadId?: string | number };
          hasRepliedRef?: { value: boolean };
        }) => ({
          currentChannelId: context.To?.trim() || undefined,
          currentThreadTs:
            context.MessageThreadId != null ? String(context.MessageThreadId) : undefined,
          hasRepliedRef,
        }),
      },
    });

    const context = buildThreadingToolContext({
      sessionCtx: {
        Provider: "telegram",
        To: "slash:8460800771",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:-1003841603622",
        MessageThreadId: 928,
        MessageSid: "2284",
      },
      config: { channels: { telegram: { allowFrom: ["*"] } } },
      hasRepliedRef: undefined,
    });

    expect(context.currentChannelId).toBe("telegram:-1003841603622");
    expect(context.currentThreadTs).toBe("928");
    expect(context.currentMessageId).toBe("2284");
  });

  it("uses OriginatingTo for threading tool context on discord native commands", () => {
    const sessionCtx = {
      Provider: "discord",
      To: "slash:1177378744822943744",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:123456789012345678",
      MessageSid: "msg-9",
    };
    setChannelSourceTurnId(sessionCtx, "channel-user:v1:source-9");
    const context = buildThreadingToolContext({
      sessionCtx,
      config: {},
      hasRepliedRef: undefined,
    });

    expect(context.currentChannelId).toBe("channel:123456789012345678");
    expect(context.currentMessageId).toBe("msg-9");
    expect(context.currentSourceTurnId).toBe("channel-user:v1:source-9");
  });

  it("does not expose restart-sentinel synthetic ids as message-tool reply targets", () => {
    hoisted.getChannelPluginMock.mockReturnValue({
      threading: {
        buildToolContext: ({
          context,
        }: {
          context: { To?: string; MessageThreadId?: string | number };
        }) => ({
          currentChannelId: context.To,
          currentThreadTs:
            context.MessageThreadId != null ? String(context.MessageThreadId) : undefined,
        }),
      },
    });

    const context = buildThreadingToolContext({
      sessionCtx: {
        Provider: "webchat",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:-1003841603622:topic:928",
        MessageThreadId: 928,
        MessageSid: "restart-sentinel:agent:main:telegram:agentTurn:123",
        InputProvenance: {
          kind: "internal_system",
          sourceChannel: "telegram",
          sourceTool: "restart-sentinel",
        },
      },
      config: {},
      hasRepliedRef: undefined,
    });

    expect(context.currentChannelId).toBe("telegram:-1003841603622:topic:928");
    expect(context.currentThreadTs).toBe("928");
    expect(context.currentMessageId).toBeUndefined();
  });

  it("uses restart-sentinel reply target when one exists", () => {
    const context = buildThreadingToolContext({
      sessionCtx: {
        Provider: "webchat",
        OriginatingChannel: "whatsapp",
        OriginatingTo: "whatsapp:+15550002",
        ReplyToId: "provider-reply-id",
        MessageSid: "restart-sentinel:agent:main:whatsapp:agentTurn:123",
        InputProvenance: {
          kind: "internal_system",
          sourceChannel: "whatsapp",
          sourceTool: "restart-sentinel",
        },
      },
      config: {},
      hasRepliedRef: undefined,
    });

    expect(context.currentChannelId).toBe("whatsapp:+15550002");
    expect(context.currentMessageId).toBe("provider-reply-id");
  });
});
