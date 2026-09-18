import { describe, expect, it, vi } from "vitest";
import { createCliTimeoutError } from "../../agents/cli-runner/no-output-timeout-policy.js";
import { HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT } from "../../agents/failover/user-copy.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  setupAgentRunnerExecutionTestState,
  GENERIC_RUN_FAILURE_TEXT,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  configureTestExecution,
  testModel,
  testAuthProfiles,
  configureTestCliModel,
  initialFallbackAttemptOptions,
  fallbackAttemptOptions,
  createMockReplyOperation,
  createMinimalRunAgentTurnParams,
  type FallbackRunnerParams,
  type EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

const state = await setupAgentRunnerExecutionTestState();

describe("executeAgentTurn: fallback terminal ownership", () => {
  it("retains the accepted selection after an exhausted preserved result", async () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "google",
      fallbackModel: "gemini-3-pro",
      fallbackAuthProfileId: "google:fallback",
      fallbackAuthProfileIdSource: "auto" as const,
    };
    const followupRun = createFollowupRun({
      catalog: [testModel(probe.provider, probe.model)],
      profiles: {
        ...testAuthProfiles(probe.provider),
        [probe.fallbackAuthProfileId]: {
          type: "api_key",
          provider: probe.fallbackProvider,
          key: "synthetic-fallback",
        },
      },
    });
    followupRun.run.executionSelection = {
      model: { provider: probe.provider, id: probe.model },
      executor: { kind: "harness", id: "openclaw" },
    };
    const sessionKey = "exhausted-primary-probe";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      executionSelection: {
        state: "accepted",
        selection: followupRun.run.executionSelection,
        fallbackPermission: "configured",
      },
      authProfileOverride: probe.fallbackAuthProfileId,
      authProfileOverrideSource: "auto",
    };
    const acceptedSelection = structuredClone(sessionEntry.executionSelection);
    const activeSessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    const exhaustedResult = {
      payloads: [{ text: "Terminal tool summary", isError: true }],
      meta: {
        error: {
          kind: "incomplete_turn",
          message: "All fallback candidates ended incomplete",
          fallbackSafe: true,
          terminalPresentation: true,
        },
      },
    };
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: {
          phase: "finishing",
          error: "All fallback candidates ended incomplete",
          livenessState: "blocked",
          providerStarted: true,
          replayInvalid: true,
          timeoutPhase: "provider",
        },
      });
      return exhaustedResult;
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "exhausted",
      result: await params.run(probe.provider, probe.model, initialFallbackAttemptOptions(params)),
      provider: probe.provider,
      model: probe.model,
      attempts: [
        { provider: probe.provider, model: probe.model, error: "incomplete" },
        {
          provider: probe.fallbackProvider,
          model: probe.fallbackModel,
          error: "incomplete",
        },
      ],
    }));
    const { replyOperation, failMock, retainFailureUntilCompleteMock } = createMockReplyOperation();
    const emitAgentEvent = vi.mocked((await import("../../infra/agent-events.js")).emitAgentEvent);

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun, replyOperation }),
      sessionKey,
      activeSessionStore,
      getActiveSessionEntry: () => activeSessionStore[sessionKey],
    });

    expect(result).toMatchObject({
      kind: "success",
      fallbackExhausted: true,
      fallbackProvider: probe.provider,
      fallbackModel: probe.model,
      runResult: exhaustedResult,
    });
    expect(activeSessionStore[sessionKey]?.executionSelection).toEqual(acceptedSelection);
    expect(retainFailureUntilCompleteMock).toHaveBeenCalledTimes(1);
    expect(failMock).toHaveBeenCalledWith("run_failed", expect.any(Error));
    expect(
      emitAgentEvent.mock.calls
        .map((call) => call[0])
        .find(
          (event) =>
            event.stream === "lifecycle" &&
            event.data.phase === "error" &&
            event.data.executionSettled === true &&
            event.data.livenessState === "blocked" &&
            event.data.providerStarted === true &&
            event.data.replayInvalid === true &&
            event.data.timeoutPhase === "provider",
        ),
    ).toBeDefined();
  });

  it("reports a completed non-fallbackable error result as a failure terminal", async () => {
    const terminalErrorResult = {
      payloads: [{ text: "Command may have changed state", isError: true }],
      meta: {
        replayInvalid: true,
        error: {
          kind: "incomplete_turn",
          message: "raw provider detail should stay private",
          fallbackSafe: false,
        },
      },
    };
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: {
          phase: "finishing",
          error: "Command may have changed state",
          replayInvalid: true,
        },
      });
      return terminalErrorResult;
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run("anthropic", "claude", initialFallbackAttemptOptions(params)),
      provider: "anthropic",
      model: "claude",
      attempts: [],
    }));
    const { replyOperation, failMock, retainFailureUntilCompleteMock } = createMockReplyOperation();
    const emitAgentEvent = vi.mocked((await import("../../infra/agent-events.js")).emitAgentEvent);

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        replyOperation,
        opts: { runId: "run-non-fallbackable-error" },
      }),
    );

    expect(result).toMatchObject({ kind: "success", runResult: terminalErrorResult });
    expect(retainFailureUntilCompleteMock).toHaveBeenCalledTimes(1);
    expect(failMock).toHaveBeenCalledWith("run_failed", expect.any(Error));
    const lifecycleEvents = emitAgentEvent.mock.calls
      .map((call) => call[0])
      .filter(
        (event) => event.runId === "run-non-fallbackable-error" && event.stream === "lifecycle",
      );
    expect(lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "error",
            error: "Command may have changed state",
            executionSettled: true,
            replayInvalid: true,
          }),
        }),
      ]),
    );
    expect(
      lifecycleEvents.some(
        (event) => event.data.phase === "end" || event.data.fallbackExhaustedFailure === true,
      ),
    ).toBe(false);
    expect(JSON.stringify(lifecycleEvents)).not.toContain("raw provider detail");
  });

  it.each([
    {
      label: "exhausted",
      outcome: "exhausted" as const,
      attempts: [{ provider: "anthropic", model: "claude", error: "missing tool result" }],
      isHeartbeat: false,
      expectedText: GENERIC_RUN_FAILURE_TEXT,
    },
    {
      label: "completed",
      outcome: "completed" as const,
      attempts: [],
      isHeartbeat: false,
      expectedText: GENERIC_RUN_FAILURE_TEXT,
    },
    {
      label: "heartbeat",
      outcome: "completed" as const,
      attempts: [],
      isHeartbeat: true,
      expectedText: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
    },
  ])("surfaces an empty $label terminal result through the normal reply path", async (testCase) => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {
        error: {
          kind: "tool_result_mismatch",
          message: "Agent run reached a terminal error before reply delivery.",
        },
      },
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: testCase.outcome,
      result: await params.run("anthropic", "claude", initialFallbackAttemptOptions(params)),
      provider: "anthropic",
      model: "claude",
      attempts: testCase.attempts,
    }));
    const { replyOperation, failMock } = createMockReplyOperation();

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ replyOperation }),
      isHeartbeat: testCase.isHeartbeat,
    });

    expect(result).toMatchObject({
      kind: "success",
      terminalFailurePayload: {
        text: testCase.expectedText,
        isError: true,
      },
      runResult: {
        payloads: [],
      },
    });
    expect(failMock).toHaveBeenCalledWith("run_failed", expect.any(Error));
  });

  it.each([
    { label: "last candidate", attemptedModel: "gpt-5.4" },
    { label: "preserved earlier candidate", attemptedModel: "gpt-5.5" },
  ])("reports exhausted CLI $label without a success terminal", async ({ attemptedModel }) => {
    state.isCliProviderMock.mockReturnValue(true);
    const lastFailure = new Error("The later CLI candidate could not start");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const preservedResult = await params.run(
        "codex-cli",
        "gpt-5.4",
        initialFallbackAttemptOptions(params),
      );
      if (attemptedModel !== "gpt-5.4") {
        await expect(
          params.run("codex-cli", attemptedModel, fallbackAttemptOptions(params, "unknown")),
        ).rejects.toBe(lastFailure);
      }
      return {
        outcome: "exhausted",
        result: preservedResult,
        provider: "codex-cli",
        model: "gpt-5.4",
        attempts: [
          { provider: "codex-cli", model: "gpt-5.4", error: "incomplete" },
          ...(attemptedModel === "gpt-5.4"
            ? []
            : [
                {
                  provider: "codex-cli",
                  model: attemptedModel,
                  error: lastFailure.message,
                },
              ]),
        ],
      };
    });
    state.runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Terminal tool summary", isError: true }],
      meta: {
        error: {
          kind: "incomplete_turn",
          message: "CLI turn ended incomplete",
        },
      },
    });
    if (attemptedModel !== "gpt-5.4") {
      state.runCliAgentMock.mockRejectedValueOnce(lastFailure);
    }
    const followupRun = createFollowupRun({
      catalog: [testModel("codex-cli", "gpt-5.4")],
      profiles: testAuthProfiles("codex-cli"),
      runtimeAuthModes: { "codex-cli": "token" },
    });
    followupRun.run.executionSelection = configureTestCliModel(followupRun, "codex-cli", "gpt-5.4");
    configureTestCliModel(followupRun, "codex-cli", attemptedModel);
    configureTestExecution(followupRun, {
      catalog: [testModel("codex-cli", "gpt-5.4"), testModel("codex-cli", attemptedModel)],
      profiles: testAuthProfiles("codex-cli"),
      runtimeAuthModes: { "codex-cli": "token" },
      fallbacks: attemptedModel === "gpt-5.4" ? [] : ["codex-cli/" + attemptedModel],
    });
    const { replyOperation, failMock, retainFailureUntilCompleteMock } = createMockReplyOperation();
    replyOperation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(followupRun));
    const emitAgentEvent = vi.mocked((await import("../../infra/agent-events.js")).emitAgentEvent);

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
        replyOperation,
        opts: { runId: "run-cli-exhausted" },
      }),
    );

    expect(state.runCliAgentMock).toHaveBeenCalledTimes(attemptedModel === "gpt-5.4" ? 1 : 2);
    expect(result).toMatchObject({
      kind: "success",
      fallbackExhausted: true,
      fallbackProvider: "codex-cli",
      fallbackModel: "gpt-5.4",
    });
    expect(retainFailureUntilCompleteMock).toHaveBeenCalledTimes(1);
    expect(failMock).toHaveBeenCalledWith("run_failed", expect.any(Error));
    const lifecycleEvents = emitAgentEvent.mock.calls
      .map((call) => call[0])
      .filter((event) => event.runId === "run-cli-exhausted" && event.stream === "lifecycle");
    expect(lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "error",
            executionSettled: true,
          }),
        }),
      ]),
    );
    expect(lifecycleEvents.some((event) => event.data.phase === "end")).toBe(false);
  });

  it("preserves a CLI watchdog timeout through the lifecycle backstop", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      try {
        return {
          outcome: "completed",
          result: await params.run("codex-cli", "gpt-5.4", initialFallbackAttemptOptions(params)),
          provider: "codex-cli",
          model: "gpt-5.4",
          attempts: [],
        };
      } catch (cause) {
        throw new Error("All model fallback candidates failed", { cause });
      }
    });
    state.runCliAgentMock.mockRejectedValueOnce(
      createCliTimeoutError(
        { provider: "codex-cli", model: "gpt-5.4" },
        {
          mode: "no-output",
          timeoutSeconds: 1,
          observedActivity: false,
          activeToolCount: 0,
          backgroundTaskCount: 0,
        },
      ),
    );
    const followupRun = createFollowupRun({
      catalog: [testModel("codex-cli", "gpt-5.4")],
      profiles: testAuthProfiles("codex-cli"),
      runtimeAuthModes: { "codex-cli": "token" },
    });
    followupRun.run.executionSelection = configureTestCliModel(followupRun, "codex-cli", "gpt-5.4");
    const emitAgentEvent = vi.mocked((await import("../../infra/agent-events.js")).emitAgentEvent);

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
        opts: { runId: "run-cli-timeout" },
      }),
    );

    expect(
      emitAgentEvent.mock.calls
        .map((call) => call[0])
        .find(
          (event) =>
            event.runId === "run-cli-timeout" &&
            event.stream === "lifecycle" &&
            event.data.phase === "error",
        )?.data,
    ).toMatchObject({
      stopReason: "timeout",
      timeoutPhase: "provider",
      executionSettled: true,
    });
  });
});
