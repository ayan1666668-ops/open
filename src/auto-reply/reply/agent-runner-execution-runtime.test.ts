import { describe, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import {
  createAgentTurnExecutionDefaults,
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
  configureTestCliModel,
  createFollowupRun,
  configureTestNativeHarness,
  fallbackAttemptOptions,
  testModel,
  testAuthProfiles,
  initialFallbackAttemptOptions,
  requireRecord,
  requireMockCall,
  expectMockCallArgFields,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const explicitCliExecutionFixture = {
  catalog: [testModel("codex-cli", "gpt-5.4")],
  profiles: testAuthProfiles("codex-cli"),
  runtimeAuthModes: { "codex-cli": "token" },
} satisfies Parameters<typeof createFollowupRun>[0];

const state = await setupAgentRunnerExecutionTestState();

describe("executeAgentTurn: runtime selection", () => {
  it.each(["group", "channel"] as const)(
    "forwards authoritative %s type through CLI fallback for opaque session keys",
    async (chatType) => {
      state.isCliProviderMock.mockReturnValue(true);
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => ({
          outcome: "completed",
          result: await params.run("codex-cli", "gpt-5.4", initialFallbackAttemptOptions(params)),
          provider: "codex-cli",
          model: "gpt-5.4",
          attempts: [],
        }),
      );
      state.runCliAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "final" }],
        meta: {},
      });

      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const followupRun = createFollowupRun(explicitCliExecutionFixture);
      followupRun.run.agentId = "main";
      followupRun.run.executionSelection = configureTestCliModel(
        followupRun,
        "codex-cli",
        "gpt-5.4",
      );
      followupRun.run.sessionKey = "agent:main:opaque:binding";
      followupRun.run.chatType = chatType;

      await executeAgentTurn({
        ...createMinimalRunAgentTurnParams({
          followupRun,
          sessionCtx: {
            Provider: "discord",
            MessageSid: "msg",
          } as unknown as TemplateContext,
        }),
        sessionKey: "agent:main:opaque:binding",
      });

      expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
        sessionKey: "agent:main:opaque:binding",
        chatType,
      });
    },
  );

  it("prefers normalized current shared context over stale queued direct metadata", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run("codex-cli", "gpt-5.4", initialFallbackAttemptOptions(params)),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun(explicitCliExecutionFixture);
    followupRun.run.agentId = "main";
    followupRun.run.executionSelection = configureTestCliModel(followupRun, "codex-cli", "gpt-5.4");
    followupRun.run.sessionKey = "agent:main:opaque:binding";
    followupRun.run.chatType = "direct";

    await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: {
          Provider: "discord",
          ChatType: "Channel",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
      sessionKey: "agent:main:opaque:binding",
    });

    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      sessionKey: "agent:main:opaque:binding",
      chatType: "channel",
    });
  });

  it("resolves CLI messageProvider from the live session surface when no origin channel is set", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run("codex-cli", "gpt-5.4", initialFallbackAttemptOptions(params)),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun(explicitCliExecutionFixture);
    followupRun.run.executionSelection = configureTestCliModel(followupRun, "codex-cli", "gpt-5.4");
    followupRun.run.messageProvider = "stale-provider";

    await executeAgentTurn({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "discord",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      ...createAgentTurnExecutionDefaults(),
    });

    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      messageChannel: undefined,
      messageProvider: "discord",
    });
  });

  it("does not pass CLI runtime overrides as embedded harness ids for fallback providers", async () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: ({ backend, config }) =>
        backend === "claude-cli" && config
          ? {
              pluginId: "anthropic",
              backend: {
                id: "claude-cli",
                modelProvider: "anthropic",
                config: { command: "claude" },
                bundleMcp: false,
              },
            }
          : undefined,
    });
    state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "claude-cli");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run("openai", "gpt-5.4", fallbackAttemptOptions(params, "unknown")),
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "fallback" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun({
      catalog: [testModel("anthropic", "claude-opus-4-7"), testModel("openai", "gpt-5.4")],
      profiles: testAuthProfiles("anthropic", "openai"),
      fallbacks: ["openai/gpt-5.4"],
    });
    followupRun.run.executionSelection = {
      model: { provider: "anthropic", id: "claude-opus-4-7" },
      executor: { kind: "harness", id: "openclaw" },
    };
    followupRun.run.config = {
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
          model: { fallbacks: ["openai/gpt-5.4"] },
        },
      },
    };

    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      getActiveSessionEntry: () =>
        ({
          sessionId: "session",
          updatedAt: Date.now(),
          executionSelection: {
            state: "accepted",
            selection: followupRun.run.executionSelection,
            fallbackPermission: "configured",
          },
        }) as SessionEntry,
    });

    expect(result, JSON.stringify(result)).toMatchObject({ kind: "success" });
    expect(state.runCliAgentMock).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(
      requireRecord(
        requireMockCall(state.runEmbeddedAgentMock, 0, "embedded run params")[0],
        "embedded run params",
      ),
    ).not.toHaveProperty("agentHarnessId", "claude-cli");
  });

  it.each([undefined, "codex", "openclaw"])(
    "keeps a plugin-owned runtime request separate from observed harness %s",
    async (agentHarnessId) => {
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => ({
          outcome: "completed",
          result: await params.run("openai", "gpt-5.4", initialFallbackAttemptOptions(params)),
          provider: "openai",
          model: "gpt-5.4",
          attempts: [],
        }),
      );
      state.runEmbeddedAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "openai" }],
        meta: {},
      });

      const executeAgentTurn = await getExecuteAgentTurnForTest();
      await configureTestNativeHarness();
      const followupRun = createFollowupRun({
        catalog: [testModel("openai", "gpt-5.4")],
        profiles: testAuthProfiles("openai"),
      });
      followupRun.run.executionSelection = {
        model: { provider: "openai", id: "gpt-5.4" },
        executor: { kind: "harness", id: "codex" },
      };
      followupRun.run.modelSelectionLocked = true;

      const result = await executeAgentTurn({
        ...createMinimalRunAgentTurnParams({ followupRun }),
        getActiveSessionEntry: () =>
          ({
            sessionId: "session",
            updatedAt: Date.now(),
            executionSelection: {
              state: "accepted",
              selection: followupRun.run.executionSelection,
              fallbackPermission: "configured",
            },
            modelSelectionLocked: true,
            pluginOwnerId: "model-owner",
            agentHarnessId,
          }) as SessionEntry,
      });

      expect(result, JSON.stringify(result)).toMatchObject({ kind: "success" });
      expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded run params", {
        provider: "openai",
        model: "gpt-5.4",
        agentHarnessId: undefined,
        agentHarnessRuntimeOverride: "codex",
        modelSelectionLocked: true,
      });
    },
  );

  it("forwards the accepted executor as the worker preparation hint", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run("openai", "gpt-5.5", initialFallbackAttemptOptions(params)),
      provider: "openai",
      model: "gpt-5.5",
      attempts: [],
    }));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "worker" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await configureTestNativeHarness();
    const followupRun = createFollowupRun({
      catalog: [testModel("openai", "gpt-5.5")],
      profiles: testAuthProfiles("openai"),
      fallbacks: [],
    });
    followupRun.run.agentId = "worker";
    followupRun.run.sessionKey = "agent:worker:main";
    followupRun.run.executionSelection = {
      model: { provider: "openai", id: "gpt-5.5" },
      executor: { kind: "harness", id: "codex" },
    };
    followupRun.run.config = {
      agents: {
        ownership: "explicit",
        entries: {
          main: {},
          worker: {
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
            },
          },
        },
      },
    };

    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      sessionKey: "agent:worker:main",
    });

    expect(result, JSON.stringify(result)).toMatchObject({ kind: "success" });
    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded run params", {
      agentId: "worker",
      agentHarnessId: undefined,
      agentHarnessRuntimeOverride: "codex",
      agentHarnessRuntimePreparationHint: "codex",
    });
  });

  it("keeps the accepted executor during heartbeat despite another policy preference", async () => {
    const [{ readSessionRuntimeOwnership }, { commitSessionExecutionSelection }] =
      await Promise.all([
        import("../../agents/harness/session-runtime-ownership.js"),
        import("../../model-picker/apply-session-model-selection.js"),
      ]);
    const nativeHarness = await configureTestNativeHarness();
    state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "claude-cli");
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "heartbeat" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const followupRun = createFollowupRun({
      catalog: [testModel("anthropic", "claude-opus-4-6")],
      profiles: {},
    });
    followupRun.run.executionSelection = {
      model: "native-managed",
      executor: { kind: "harness", id: "codex" },
    };
    followupRun.run.config = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    };
    expect(
      await nativeHarness.bindNativeSession({
        agentId: followupRun.run.agentId,
        sessionId: followupRun.run.sessionId,
        sessionKey: followupRun.run.sessionKey,
        workspaceDir: followupRun.run.workspaceDir,
        threadId: "native-heartbeat-thread",
        provider: "anthropic",
        modelId: "claude-opus-4-6",
      }),
    ).toBe(true);
    const entry: SessionEntry = {
      sessionId: followupRun.run.sessionId,
      updatedAt: Date.now(),
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    };
    commitSessionExecutionSelection(entry, followupRun.run.executionSelection);

    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      isHeartbeat: true,
      getActiveSessionEntry: () => entry,
    });

    expect(result, JSON.stringify(result)).toMatchObject({ kind: "success" });
    expect(state.runCliAgentMock).not.toHaveBeenCalled();
    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded run params", {
      provider: undefined,
      model: undefined,
      trigger: "heartbeat",
      lane: "cron-nested",
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
    });
    expect(entry).toMatchObject({
      modelSelectionLocked: true,
      executionSelection: {
        state: "accepted",
        selection: {
          model: "native-managed",
          executor: { kind: "harness", id: "codex" },
        },
      },
    });
    expect(
      readSessionRuntimeOwnership({
        config: followupRun.run.config,
        agentId: followupRun.run.agentId,
        sessionKey: followupRun.run.sessionKey,
        sessionEntry: entry,
      }),
    ).toEqual({
      model: "native",
      auth: "native",
      modelRef: { provider: "anthropic", model: "claude-opus-4-6" },
    });
  });

  it("keeps a locked Codex harness embedded when cliBackends.codex is configured", async () => {
    state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "codex");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run("openai", "gpt-5.4", initialFallbackAttemptOptions(params)),
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "continued" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await configureTestNativeHarness();
    const followupRun = createFollowupRun({
      catalog: [testModel("openai", "gpt-5.4")],
      profiles: testAuthProfiles("openai"),
    });
    followupRun.run.executionSelection = {
      model: { provider: "openai", id: "gpt-5.4" },
      executor: { kind: "harness", id: "codex" },
    };
    followupRun.run.config = {};

    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      getActiveSessionEntry: () =>
        ({
          sessionId: "catalog-adopted-session",
          updatedAt: Date.now(),
          executionSelection: {
            state: "accepted",
            selection: followupRun.run.executionSelection,
            fallbackPermission: "configured",
          },
          agentHarnessId: "codex",
          modelSelectionLocked: true,
        }) as SessionEntry,
    });

    expect(result, JSON.stringify(result)).toMatchObject({ kind: "success" });
    expect(state.runCliAgentMock).not.toHaveBeenCalled();
    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded run params", {
      provider: "openai",
      model: "gpt-5.4",
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
    });
  });

  it("keeps plugin-owned CLI turns on the CLI path after observing that runtime", async () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
      ],
    });
    state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "claude-cli");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run(
        "anthropic",
        "claude-sonnet-4-6",
        initialFallbackAttemptOptions(params),
      ),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({ payloads: [{ text: "continued" }], meta: {} });
    const followupRun = createFollowupRun({
      catalog: [testModel("anthropic", "claude-sonnet-4-6")],
      profiles: testAuthProfiles("anthropic"),
      runtimeAuthModes: { "claude-cli": "token" },
    });
    followupRun.run.executionSelection = configureTestCliModel(
      followupRun,
      "anthropic",
      "claude-sonnet-4-6",
      "claude-cli",
      "anthropic",
    );
    followupRun.run.modelSelectionLocked = true;
    // Modality preparation looks up the canonical model, not the CLI backend alias.
    followupRun.run.thinkingCatalog = [
      { provider: "anthropic", id: "claude-sonnet-4-6", input: ["text", "image"] },
    ];
    const executeAgentTurn = await getExecuteAgentTurnForTest();

    await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      getActiveSessionEntry: () => ({
        sessionId: "session",
        updatedAt: 1,
        modelSelectionLocked: true,
        pluginOwnerId: "cli-owner",
        executionSelection: {
          state: "accepted",
          selection: followupRun.run.executionSelection,
          fallbackPermission: "configured",
        },
        agentHarnessId: "claude-cli",
      }),
    });

    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI run params", {
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      modelHasVision: true,
    });
  });

  it("honors the accepted executor before a configured CLI preference", async () => {
    state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "claude-cli");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run("openai", "gpt-5.4", initialFallbackAttemptOptions(params)),
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "agent" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await configureTestNativeHarness();
    const followupRun = createFollowupRun({
      catalog: [testModel("openai", "gpt-5.4")],
      profiles: testAuthProfiles("openai"),
    });
    followupRun.run.executionSelection = {
      model: { provider: "openai", id: "gpt-5.4" },
      executor: { kind: "harness", id: "codex" },
    };
    followupRun.run.config = {
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
        },
      },
    };

    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      getActiveSessionEntry: () =>
        ({
          sessionId: "session",
          updatedAt: Date.now(),
          executionSelection: {
            state: "accepted",
            selection: followupRun.run.executionSelection,
            fallbackPermission: "configured",
          },
        }) as SessionEntry,
    });

    expect(result, JSON.stringify(result)).toMatchObject({ kind: "success" });
    expect(state.runCliAgentMock).not.toHaveBeenCalled();
    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded run params", {
      provider: "openai",
      model: "gpt-5.4",
      agentHarnessId: undefined,
      agentHarnessRuntimeOverride: "codex",
    });
  });
});
