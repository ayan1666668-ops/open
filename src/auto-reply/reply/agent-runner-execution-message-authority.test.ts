import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as externalAuthTesting } from "../../agents/auth-profiles/external-auth.test-support.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { resolveMessageActionTurnCapability } from "../../gateway/message-action-turn-capability.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createFollowupRun,
  testModel,
  testAuthProfiles,
  configureTestExecution,
  configureTestHarness,
  configureTestCliModel,
  createMinimalRunAgentTurnParams,
  fallbackAttemptOptions,
  getExecuteAgentTurnForTest,
  initialFallbackAttemptOptions,
  setupAgentRunnerExecutionTestState,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();
const { mintReplyMessageActionTurnCapability } =
  await vi.importActual<typeof import("./agent-runner-utils.js")>("./agent-runner-utils.js");
const sessionKey = "agent:main:discord:channel:100000000000000003";
const policySessionKey = "agent:main:discord:policy:100000000000000003";
const runId = "channel-message-authority";
const currentChannelId = "100000000000000003";

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        plugin: createChannelTestPluginBase({
          id: "discord",
          capabilities: { chatTypes: ["channel"] },
        }),
        source: "test",
      },
    ]),
  );
  state.mintReplyMessageActionTurnCapabilityMock.mockImplementation(
    mintReplyMessageActionTurnCapability,
  );
  externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        modelProvider: "anthropic",
        pluginId: "anthropic",
        config: { command: "claude" },
      },
    ],
    resolvePluginSetupCliBackend: () => undefined,
  });
});

afterEach(() => externalAuthTesting.resetResolveExternalAuthProfilesForTest());

function channelTurn() {
  const followupRun = createFollowupRun({
    catalog: [testModel("claude-cli", "claude-sonnet-4-6")],
    profiles: testAuthProfiles("claude-cli"),
    fallbacks: [],
    runtimeAuthModes: { "claude-cli": "token" },
  });
  Object.assign(followupRun.run, {
    sessionKey,
    executionSelection: configureTestCliModel(followupRun, "claude-cli", "claude-sonnet-4-6"),
    messageProvider: "discord",
    agentAccountId: "default",
    senderId: "100000000000000009",
  });
  followupRun.originatingChannel = "discord";
  followupRun.originatingTo = currentChannelId;
  return {
    ...createMinimalRunAgentTurnParams({
      followupRun,
      opts: { runId },
      sessionCtx: {
        Provider: "discord",
        ChatType: "channel",
        To: currentChannelId,
        AccountId: "default",
        SenderId: "100000000000000009",
        MessageSid: "100000000000000020",
      },
    }),
    sessionKey,
  };
}

function resolveCapability(token: string | undefined, key = sessionKey) {
  return resolveMessageActionTurnCapability({
    token,
    agentId: "main",
    runId,
    sessionKey: key,
    sessionId: "session",
  });
}

describe("channel reply message authority", () => {
  it.each(["success", "failure", "policy-session"] as const)(
    "retains the CLI source authority until %s settlement",
    async (outcome) => {
      const turn = channelTurn();
      const authorityKey = outcome === "policy-session" ? policySessionKey : sessionKey;
      let token: string | undefined;
      state.isCliProviderMock.mockImplementation((provider) => provider === "claude-cli");
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => ({
          outcome: "completed",
          result: await params.run(
            "claude-cli",
            "claude-sonnet-4-6",
            initialFallbackAttemptOptions(params),
          ),
          provider: "claude-cli",
          model: "claude-sonnet-4-6",
          attempts: [],
        }),
      );
      state.runCliAgentMock.mockImplementationOnce(async (run: RunCliAgentParams) => {
        token = run.messageActionTurnCapability;
        expect(resolveCapability(token, authorityKey)).toMatchObject({
          sourceReplySessionKey: sessionKey,
          requesterAccountId: "default",
          requesterSenderId: "100000000000000009",
          toolContext: {
            currentChannelProvider: "discord",
            currentChannelId,
            currentMessageId: "100000000000000020",
          },
        });
        if (outcome === "failure") {
          throw new Error("CLI execution failed");
        }
        return { payloads: [{ text: "done" }], meta: {} };
      });

      const execute = await getExecuteAgentTurnForTest();
      const result = await execute({
        ...turn,
        ...(outcome === "policy-session" ? { runtimePolicySessionKey: policySessionKey } : {}),
      });

      expect(result.kind).toBe(outcome === "failure" ? "final" : "success");
      expect(token).toBeDefined();
      expect(resolveCapability(token, authorityKey)).toBeUndefined();
    },
  );

  it("fences the previous candidate while preserving the admitted run for CLI fallback", async () => {
    let embeddedToken: string | undefined;
    let cliToken: string | undefined;
    let admission: RunCliAgentParams["preparedRunAdmission"];
    state.isCliProviderMock.mockImplementation((provider) => provider === "claude-cli");
    state.runEmbeddedAgentMock.mockImplementationOnce(
      async (run: RunEmbeddedAgentInternalParams) => {
        embeddedToken = run.messageActionTurnCapability;
        admission = run.preparedRunAdmission;
        expect(resolveCapability(embeddedToken)).toBeDefined();
        return { payloads: [], meta: {} };
      },
    );
    state.runCliAgentMock.mockImplementationOnce(async (run: RunCliAgentParams) => {
      cliToken = run.messageActionTurnCapability;
      expect(resolveCapability(cliToken)).toBeDefined();
      expect(cliToken).not.toBe(embeddedToken);
      expect(resolveCapability(embeddedToken)).toBeUndefined();
      expect(run.preparedRunAdmission).toBe(admission);
      return { payloads: [{ text: "done" }], meta: {} };
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params.run("anthropic", "claude", initialFallbackAttemptOptions(params));
      return {
        outcome: "completed",
        result: await params.run(
          "claude-cli",
          "claude-sonnet-4-6",
          fallbackAttemptOptions(params, "unknown"),
        ),
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
        attempts: [],
      };
    });

    const execute = await getExecuteAgentTurnForTest();
    const turn = channelTurn();
    configureTestExecution(turn.followupRun, {
      catalog: [testModel("anthropic", "claude"), testModel("claude-cli", "claude-sonnet-4-6")],
      profiles: testAuthProfiles("anthropic", "claude-cli"),
      fallbacks: ["claude-cli/claude-sonnet-4-6"],
      selection: {
        model: { provider: "anthropic", id: "claude" },
        executor: { kind: "harness", id: "openclaw" },
      },
      runtimeAuthModes: { "claude-cli": "token" },
    });
    configureTestHarness(
      turn.followupRun,
      "test-primary-app",
      [{ provider: "anthropic", id: "claude" }],
      [{ provider: "claude-cli", id: "claude-sonnet-4-6" }],
    );
    expect((await execute(turn)).kind).toBe("success");
    expect(embeddedToken).toBeDefined();
    expect(cliToken).toBeDefined();
    expect(resolveCapability(embeddedToken)).toBeUndefined();
    expect(resolveCapability(cliToken)).toBeUndefined();
  });

  it.each(["heartbeat", "untrusted-ingress"] as const)(
    "does not mint channel authority for %s routing metadata",
    async (mode) => {
      const turn = channelTurn();
      state.isCliProviderMock.mockImplementation((provider) => provider === "claude-cli");
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => ({
          outcome: "completed",
          result: await params.run(
            "claude-cli",
            "claude-sonnet-4-6",
            initialFallbackAttemptOptions(params),
          ),
          provider: "claude-cli",
          model: "claude-sonnet-4-6",
          attempts: [],
        }),
      );
      state.runCliAgentMock.mockImplementationOnce(async (run: RunCliAgentParams) => {
        expect(run.messageActionTurnCapability).toBeUndefined();
        return { payloads: [{ text: "done" }], meta: {} };
      });
      const execute = await getExecuteAgentTurnForTest();
      await execute({
        ...turn,
        isHeartbeat: mode === "heartbeat",
        sessionCtx: {
          ...turn.sessionCtx,
          Provider: mode === "untrusted-ingress" ? "webchat" : "discord",
        },
      });
      expect(state.runCliAgentMock).toHaveBeenCalledOnce();
    },
  );
});
