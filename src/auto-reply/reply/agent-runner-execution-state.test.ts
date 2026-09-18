import { describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import {
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunActive,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "../../agents/embedded-agent-runner/runs.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import type { SessionEntry } from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { commitSessionExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
import type { TemplateContext } from "../templating.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
  configureTestCliModel,
  createFollowupRun,
  configureTestNativeHarness,
  testModel,
  testAuthProfiles,
  createLiveSwitchSession,
  makeTestSessionStorePath,
  GENERIC_RUN_FAILURE_TEXT,
  createMockReplyOperation,
  expectMockCallArgFields,
  fallbackAttemptOptions,
  initialFallbackAttemptOptions,
  createMinimalRunAgentTurnParams,
  createRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();
const { emitAgentEvent } = await import("../../infra/agent-events.js");

describe("executeAgentTurn: session state", () => {
  it("keeps thinking paired with the winning runtime when a live model switch restarts the prompt", async () => {
    await configureTestNativeHarness();
    const followupRun = createFollowupRun({
      catalog: [testModel("anthropic", "claude"), testModel("openai", "gpt-5.6-luna")],
      profiles: testAuthProfiles("anthropic", "openai"),
      fallbacks: [],
    });
    const session = createLiveSwitchSession(followupRun);
    let fallbackInvocation = 0;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      const isInitialInvocation = fallbackInvocation++ === 0;
      const provider = isInitialInvocation ? "anthropic" : "openai";
      const model = isInitialInvocation ? "claude" : "gpt-5.6-luna";
      return {
        outcome: "completed",
        result: await params.run(provider, model, initialFallbackAttemptOptions(params)),
        provider,
        model,
        attempts: [],
      };
    });
    state.runEmbeddedAgentMock
      .mockImplementationOnce(async () => {
        throw session.publish(
          new LiveSessionModelSwitchError({
            selection: {
              model: { provider: "openai", id: "gpt-5.6-luna" },
              executor: { kind: "harness", id: "codex" },
            },
          }),
        );
      })
      .mockImplementationOnce(async () => {
        return {
          payloads: [{ text: "switched" }],
          meta: {
            agentMeta: {
              sessionId: "session",
              provider: "openai",
              model: "gpt-5.6-luna",
            },
          },
        };
      });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    followupRun.run.thinkLevel = "ultra";
    followupRun.run.thinkingCatalog?.push({
      provider: "openai",
      id: "gpt-5.6-luna",
      input: ["text"],
      reasoning: true,
      compat: { supportedReasoningEfforts: ["medium", "high", "max"] },
    });
    const result = await executeAgentTurn({
      ...createRunAgentTurnParams(followupRun),
      getActiveSessionEntry: session.getActiveSessionEntry,
    });

    expect(result.kind).toBe("success");
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(followupRun.run.executionSelection).toMatchObject({
      model: { provider: "openai", id: "gpt-5.6-luna" },
    });
    expect(state.runEmbeddedAgentMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        executionSelection: expect.objectContaining({ executor: { kind: "harness", id: "codex" } }),
        thinkLevel: "max",
      }),
    );
  });

  it("settles a failed latest selection read without replay or undoing the saved switch", async () => {
    const followupRun = createFollowupRun();
    const session = createLiveSwitchSession(followupRun);
    const queued = structuredClone(followupRun.run.executionSelection);
    const storePath = makeTestSessionStorePath();
    const sessionKey = "main";
    const readFailure = new Error("Session read interrupted");
    let saved: SessionEntry | undefined;
    let failedReads = 0;
    const originalRead = sessionAccessor.loadSessionEntryReadOnly;
    const read = vi
      .spyOn(sessionAccessor, "loadSessionEntryReadOnly")
      .mockImplementation((target) => {
        if (target.storePath !== storePath || target.sessionKey !== sessionKey) {
          return originalRead(target);
        }
        if (saved && target.readConsistency === "latest") {
          failedReads++;
          throw readFailure;
        }
        return structuredClone(session.getActiveSessionEntry());
      });
    const originalLoad = sessionAccessor.loadSessionEntry;
    const load = vi
      .spyOn(sessionAccessor, "loadSessionEntry")
      .mockImplementation((target) =>
        target.storePath === storePath && target.sessionKey === sessionKey
          ? structuredClone(session.getActiveSessionEntry())
          : originalLoad(target),
      );
    const { replyOperation, failMock, freezeAbortMock } = createMockReplyOperation();
    const handle: EmbeddedAgentQueueHandle = {
      runId: "selection-read-failure",
      queueMessage: async () => undefined,
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };
    state.runEmbeddedAgentMock.mockImplementationOnce(
      async (params: RunEmbeddedAgentInternalParams) => {
        setActiveEmbeddedRun(followupRun.run.sessionId, handle, sessionKey);
        params.onDeferredLifecycleOwner?.({
          beginRetryWait: () => undefined,
          complete: async () =>
            clearActiveEmbeddedRun(followupRun.run.sessionId, handle, sessionKey),
          discard: () => clearActiveEmbeddedRun(followupRun.run.sessionId, handle, sessionKey),
        });
        const notification = session.publish(
          new LiveSessionModelSwitchError({
            selection: {
              model: { provider: "fixture", id: "selected" },
              executor: { kind: "harness", id: "openclaw" },
            },
            authProfileId: "selected-account",
            authProfileIdSource: "user",
          }),
          "reset",
        );
        saved = structuredClone(session.getActiveSessionEntry());
        throw notification;
      },
    );
    try {
      const { executeAgentTurn } = await import("./agent-runner-execution.js");
      const result = await executeAgentTurn({
        ...createRunAgentTurnParams(followupRun),
        storePath,
        sessionKey,
        replyOperation,
        getActiveSessionEntry: session.getActiveSessionEntry,
      });
      expect(result.outcome).toMatchObject({
        kind: "rejected",
        payload: { text: GENERIC_RUN_FAILURE_TEXT },
      });
      expect(failedReads).toBe(1);
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(1);
      expect(failMock).toHaveBeenCalledExactlyOnceWith("run_failed", readFailure);
      expect(freezeAbortMock).toHaveBeenCalledOnce();
      expect(isEmbeddedAgentRunActive(followupRun.run.sessionId)).toBe(false);
      expect(session.getActiveSessionEntry()).toEqual(saved);
      expect(followupRun.run.executionSelection).toEqual(queued);
      const terminals = vi
        .mocked(emitAgentEvent)
        .mock.calls.map(([event]) => event)
        .filter(
          (event) =>
            event.runId === result.runId &&
            event.stream === "lifecycle" &&
            (event.data.phase === "end" || event.data.phase === "error"),
        );
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.data.phase).toBe("error");
    } finally {
      read.mockRestore();
      load.mockRestore();
      clearActiveEmbeddedRun(followupRun.run.sessionId, handle, sessionKey);
    }
  });

  it.each(["retained", "replaced"] as const)(
    "checks the live successor identity and its %s lifecycle before a switch retry",
    async (lifecycle) => {
      const followupRun = createFollowupRun({
        catalog: [testModel("anthropic", "claude"), testModel("fixture", "selected")],
        profiles: {
          ...testAuthProfiles("anthropic", "fixture"),
          "selected-account": {
            type: "api_key",
            provider: "fixture",
            key: "synthetic-selected-key",
          },
        },
        fallbacks: [],
      });
      const session = createLiveSwitchSession(followupRun);
      const queued = structuredClone(followupRun.run.executionSelection);
      const generation = session.getActiveSessionEntry().lifecycleRevision;
      const { replyOperation, failMock } = createMockReplyOperation();
      state.runEmbeddedAgentMock
        .mockImplementationOnce(async (params: RunEmbeddedAgentInternalParams) => {
          const successor = session.getActiveSessionEntry();
          successor.sessionId = "accepted-successor";
          if (lifecycle === "replaced") {
            successor.lifecycleRevision = "replacement-generation";
          }
          expect(params.replyOperation).toBe(replyOperation);
          params.replyOperation?.updateSessionId(successor.sessionId);
          expect(followupRun.run.sessionId).toBe("session");
          throw session.publish(
            new LiveSessionModelSwitchError({
              selection: {
                model: { provider: "fixture", id: "selected" },
                executor: { kind: "harness", id: "openclaw" },
              },
              authProfileId: "selected-account",
              authProfileIdSource: "user",
            }),
            "reset",
          );
        })
        .mockResolvedValueOnce({ payloads: [{ text: "switched" }], meta: {} });
      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const result = await executeAgentTurn({
        ...createRunAgentTurnParams(followupRun),
        replyOperation,
        getActiveSessionEntry: session.getActiveSessionEntry,
      });
      expect(replyOperation.sessionId).toBe("accepted-successor");
      expect(session.getActiveSessionEntry()).toMatchObject({
        lifecycleRevision: lifecycle === "retained" ? generation : "replacement-generation",
        executionSelection: { fallbackPermission: "configured" },
        authProfileOverride: "selected-account",
        authProfileOverrideSource: "user",
      });
      if (lifecycle === "retained") {
        expect(result.kind).toBe("success");
        expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
        expect(failMock).not.toHaveBeenCalled();
        expect(followupRun.run.sessionId).toBe("accepted-successor");
        expect(state.runEmbeddedAgentMock.mock.calls[1]?.[0]).toEqual(
          expect.objectContaining({
            sessionId: "accepted-successor",
            agentHarnessRuntimeOverride: "openclaw",
          }),
        );
        expect(followupRun.run.executionSelection).toMatchObject({
          model: { provider: "fixture", id: "selected" },
        });
        expect(followupRun.run.authProfileId).toBe("selected-account");
      } else {
        expect(result.kind).toBe("final");
        expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
        expect(followupRun.run.executionSelection).toEqual(queued);
        expect(failMock).toHaveBeenCalledWith(
          "run_failed",
          expect.objectContaining({
            message: "The session selection changed. Retry the turn.",
          }),
        );
      }
    },
  );

  it.each(["user", "reset"] as const)(
    "restarts the active prompt after a saved %s selection",
    async (cause) => {
      await configureTestNativeHarness();
      const followupRun = createFollowupRun({
        catalog: [testModel("anthropic", "claude"), testModel("openai", "gpt-5.4")],
        profiles: testAuthProfiles("anthropic", "openai"),
        fallbacks: [],
      });
      const session = createLiveSwitchSession(followupRun);
      let fallbackInvocation = 0;
      state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
        const isInitialInvocation = fallbackInvocation++ === 0;
        const provider = isInitialInvocation ? "anthropic" : "openai";
        const model = isInitialInvocation ? "claude" : "gpt-5.4";
        return {
          outcome: "completed",
          result: await params.run(provider, model, initialFallbackAttemptOptions(params)),
          provider,
          model,
          attempts: [],
        };
      });
      state.runEmbeddedAgentMock
        .mockImplementationOnce(async () => {
          throw session.publish(
            new LiveSessionModelSwitchError({
              selection: {
                model: { provider: "openai", id: "gpt-5.4" },
                executor: { kind: "harness", id: "codex" },
              },
            }),
            cause,
          );
        })
        .mockImplementationOnce(async () => {
          return {
            payloads: [{ text: "switched" }],
            meta: {
              agentMeta: {
                sessionId: "session",
                provider: "openai",
                model: "gpt-5.4",
              },
            },
          };
        });

      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const result = await executeAgentTurn({
        ...createRunAgentTurnParams(followupRun),
        getActiveSessionEntry: session.getActiveSessionEntry,
      });

      expect(result).toMatchObject({ kind: "success" });
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
      expect(session.getActiveSessionEntry().executionSelection?.fallbackPermission).toBe(
        cause === "reset" ? "configured" : "explicit",
      );
      expect(followupRun.run.executionSelection).toMatchObject({
        model: { provider: "openai", id: "gpt-5.4" },
      });
      expect(state.runEmbeddedAgentMock.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({ agentHarnessRuntimeOverride: "codex" }),
      );
    },
  );

  it("breaks out of the retry loop when LiveSessionModelSwitchError is thrown repeatedly (#58348)", async () => {
    const followupRun = createFollowupRun({
      catalog: [testModel("anthropic", "claude"), testModel("openai", "gpt-5.4")],
      profiles: testAuthProfiles("anthropic", "openai"),
      fallbacks: [],
    });
    const session = createLiveSwitchSession(followupRun);
    // Simulate a scenario where the persisted session selection keeps conflicting
    // with the fallback model, causing LiveSessionModelSwitchError on every attempt.
    // The outer loop must be bounded to prevent a session death loop.
    let switchCallCount = 0;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      switchCallCount++;
      return {
        outcome: "completed",
        result: await params.run(
          params.provider,
          params.model,
          switchCallCount === 1
            ? initialFallbackAttemptOptions(params)
            : fallbackAttemptOptions(params, "unknown"),
        ),
        provider: "anthropic",
        model: "claude",
        attempts: [],
      };
    });
    state.runEmbeddedAgentMock.mockImplementation(async () => {
      throw session.publish(
        new LiveSessionModelSwitchError({
          selection: {
            model: { provider: "openai", id: "gpt-5.4" },
            executor: { kind: "harness", id: "openclaw" },
          },
        }),
      );
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      ...createRunAgentTurnParams(followupRun),
      getActiveSessionEntry: session.getActiveSessionEntry,
    });

    // After two retries the loop must break instead of continuing
    // forever. The result should be a final error, not an infinite hang.
    expect(result.kind).toBe("final");
    // One initial attempt plus two retries.
    expect(switchCallCount).toBe(3);
  });

  it("propagates auth profile state on bounded live model switch retries (#58348)", async () => {
    const followupRun = createFollowupRun({
      catalog: [testModel("anthropic", "claude"), testModel("openai", "gpt-5.4")],
      profiles: {
        ...testAuthProfiles("anthropic"),
        "profile-b": { type: "api_key", provider: "openai", key: "synthetic-b" },
        "profile-c": { type: "api_key", provider: "openai", key: "synthetic-c" },
      },
      fallbacks: [],
    });
    const session = createLiveSwitchSession(followupRun);
    let invocation = 0;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      invocation++;
      if (invocation <= 2) {
        return {
          outcome: "completed",
          result: await params.run(
            params.provider,
            params.model,
            invocation === 1
              ? initialFallbackAttemptOptions(params)
              : fallbackAttemptOptions(params, "unknown"),
          ),
          provider: "anthropic",
          model: "claude",
          attempts: [],
        };
      }
      // Third invocation succeeds with the switched model
      return {
        outcome: "completed",
        result: await params.run("openai", "gpt-5.4", initialFallbackAttemptOptions(params)),
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      };
    });
    state.runEmbeddedAgentMock
      .mockImplementationOnce(async () => {
        throw session.publish(
          new LiveSessionModelSwitchError({
            selection: {
              model: { provider: "openai", id: "gpt-5.4" },
              executor: { kind: "harness", id: "openclaw" },
            },
            authProfileId: "profile-b",
            authProfileIdSource: "user",
          }),
        );
      })
      .mockImplementationOnce(async () => {
        throw session.publish(
          new LiveSessionModelSwitchError({
            selection: {
              model: { provider: "openai", id: "gpt-5.4" },
              executor: { kind: "harness", id: "openclaw" },
            },
            authProfileId: "profile-c",
            authProfileIdSource: "auto",
          }),
        );
      })
      .mockImplementationOnce(async () => {
        return {
          payloads: [{ text: "finally ok" }],
          meta: {
            agentMeta: {
              sessionId: "session",
              provider: "openai",
              model: "gpt-5.4",
            },
          },
        };
      });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      ...createRunAgentTurnParams(followupRun),
      getActiveSessionEntry: session.getActiveSessionEntry,
    });

    // Two switches (within the limit of 2) then success on third attempt
    expect(result).toMatchObject({ kind: "success" });
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(3);
    expect(followupRun.run.executionSelection).toMatchObject({
      model: { provider: "openai", id: "gpt-5.4" },
    });
    expect(followupRun.run.authProfileId).toBe("profile-c");
    expect(followupRun.run.authProfileIdSource).toBe("auto");
    expect(state.runEmbeddedAgentEntryMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        selection: expect.objectContaining({ userLockedAuthProfileId: "profile-b" }),
      }),
      expect.any(Function),
    );
    expect(state.runEmbeddedAgentEntryMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        selection: expect.objectContaining({ userLockedAuthProfileId: undefined }),
      }),
      expect.any(Function),
    );
  });

  it.each(["newer reset", "newer account"] as const)(
    "rejects a stale switch notification after a %s before another attempt starts",
    async (change) => {
      const followupRun = createFollowupRun({
        catalog: [
          testModel("fixture", "initial"),
          testModel("fixture", "notified"),
          testModel("fixture", "newer"),
        ],
        profiles: {
          "account-before": { type: "api_key", provider: "fixture", key: "synthetic-before" },
          "account-after": { type: "api_key", provider: "fixture", key: "synthetic-after" },
        },
      });
      followupRun.run.executionSelection = {
        model: { provider: "fixture", id: "initial" },
        executor: { kind: "harness", id: "openclaw" },
      };
      followupRun.run.authProfileId = "account-before";
      followupRun.run.authProfileIdSource = "user";
      const queued = structuredClone(followupRun.run.executionSelection);
      const session = createLiveSwitchSession(followupRun);
      const notification = new LiveSessionModelSwitchError({
        selection:
          change === "newer account"
            ? queued
            : {
                model: { provider: "fixture", id: "notified" },
                executor: { kind: "harness", id: "openclaw" },
              },
        authProfileId: "account-before",
        authProfileIdSource: "user",
      });
      const { replyOperation, failMock, freezeAbortMock } = createMockReplyOperation();
      state.runEmbeddedAgentMock
        .mockImplementationOnce(async () => {
          session.publish(
            new LiveSessionModelSwitchError({
              selection:
                change === "newer account"
                  ? queued
                  : {
                      model: { provider: "fixture", id: "newer" },
                      executor: { kind: "harness", id: "openclaw" },
                    },
              authProfileId: change === "newer account" ? "account-after" : "account-before",
              authProfileIdSource: "user",
            }),
            change === "newer reset" ? "reset" : "user",
          );
          throw notification;
        })
        .mockResolvedValue({ payloads: [{ text: "stale attempt" }], meta: {} });
      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const result = await executeAgentTurn({
        ...createRunAgentTurnParams(followupRun),
        replyOperation,
        getActiveSessionEntry: session.getActiveSessionEntry,
      });
      expect(result.kind).toBe("final");
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(1);
      expect(followupRun.run.executionSelection).toEqual(queued);
      expect(followupRun.run.authProfileId).toBe("account-before");
      expect(session.getActiveSessionEntry()).toMatchObject({
        executionSelection: {
          selection: { model: { id: change === "newer account" ? "initial" : "newer" } },
          fallbackPermission: change === "newer reset" ? "configured" : "explicit",
        },
        authProfileOverride: change === "newer account" ? "account-after" : "account-before",
      });
      expect(failMock).toHaveBeenCalledWith(
        "run_failed",
        expect.objectContaining({
          message: "The session selection changed. Retry the turn.",
        }),
      );
      expect(freezeAbortMock).toHaveBeenCalledOnce();
    },
  );

  it("does not roll back a concurrent accepted selection after a failed fallback candidate", async () => {
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      await expect(
        params.run("openai", "gpt-5.4", fallbackAttemptOptions(params, "unknown")),
      ).rejects.toThrow("fallback failed");
      throw new Error("fallback failed");
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      executionSelection: {
        state: "accepted",
        selection: {
          model: { provider: "anthropic", id: "claude" },
          executor: { kind: "harness", id: "openclaw" },
        },
        fallbackPermission: "configured",
      },
      authProfileOverride: "anthropic:default",
      authProfileOverrideSource: "user",
    };
    const sessionStore = { main: sessionEntry };
    state.runEmbeddedAgentMock.mockImplementationOnce(async () => {
      commitSessionExecutionSelection(
        sessionEntry,
        {
          model: { provider: "zai", id: "glm-5" },
          executor: { kind: "harness", id: "openclaw" },
        },
        { cause: { kind: "user" } },
      );
      sessionEntry.authProfileOverride = "zai:work";
      sessionEntry.authProfileOverrideSource = "user";
      throw new Error("fallback failed");
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      commandBody: "hello",
      followupRun: createFollowupRun({
        catalog: [testModel("anthropic", "claude"), testModel("openai", "gpt-5.4")],
        profiles: {
          "anthropic:default": { type: "api_key", provider: "anthropic", key: "synthetic-primary" },
          ...testAuthProfiles("openai"),
        },
        fallbacks: ["openai/gpt-5.4"],
      }),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => sessionEntry,
      activeSessionStore: sessionStore,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    expect(sessionEntry.executionSelection).toEqual({
      state: "accepted",
      selection: {
        model: { provider: "zai", id: "glm-5" },
        executor: { kind: "harness", id: "openclaw" },
      },
      fallbackPermission: "explicit",
    });
    expect(sessionEntry.authProfileOverride).toBe("zai:work");
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
    expect(sessionStore.main.executionSelection).toEqual(sessionEntry.executionSelection);
  });

  it("keeps cross-provider fallback selection turn-local", async () => {
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run("openai", "gpt-5.4", fallbackAttemptOptions(params, "unknown")),
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const followupRun = createFollowupRun({
      catalog: [testModel("anthropic", "claude-opus"), testModel("openai", "gpt-5.4")],
      profiles: {
        "anthropic:openclaw": { type: "api_key", provider: "anthropic", key: "synthetic-primary" },
        ...testAuthProfiles("openai"),
      },
      fallbacks: ["openai/gpt-5.4"],
    });
    followupRun.run.executionSelection = {
      model: { provider: "anthropic", id: "claude-opus" },
      executor: { kind: "harness", id: "openclaw" },
    };
    followupRun.run.authProfileId = "anthropic:openclaw";
    followupRun.run.authProfileIdSource = "user";

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      executionSelection: {
        state: "accepted",
        selection: followupRun.run.executionSelection,
        fallbackPermission: "configured",
      },
      totalTokens: 1,
      compactionCount: 0,
    };
    const acceptedSelection = structuredClone(sessionEntry.executionSelection);
    const sessionStore = { main: sessionEntry };

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      commandBody: "hello",
      followupRun,
      sessionCtx: {
        Provider: "telegram",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => sessionEntry,
      activeSessionStore: sessionStore,
      resolvedVerboseLevel: "off",
    });

    expect(result).toMatchObject({ kind: "success" });
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded run params", {
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(sessionEntry.executionSelection).toEqual(acceptedSelection);
    expect(sessionEntry.authProfileOverride).toBeUndefined();
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(sessionStore.main.authProfileOverride).toBeUndefined();
  });

  it("refuses an unapproved fallback for an explicitly selected model", async () => {
    const followupRun = createFollowupRun();
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      executionSelection: {
        state: "accepted",
        selection: followupRun.run.executionSelection,
        fallbackPermission: "explicit",
      },
    };
    const acceptedSelection = structuredClone(sessionEntry.executionSelection);
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run("openai", "gpt-5.4", fallbackAttemptOptions(params, "unknown")),
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    }));
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams({ followupRun }),
      sessionKey: "main",
      getActiveSessionEntry: () => sessionEntry,
      activeSessionStore: { main: sessionEntry },
    });
    expect(result.kind).toBe("final");
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(sessionEntry.executionSelection).toEqual(acceptedSelection);
  });

  it("shares one deferred assistant error owner across main reply fallback candidates", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params
        .run("anthropic", "claude-opus-4-7", initialFallbackAttemptOptions(params))
        .catch(() => undefined);
      await params
        .run("anthropic", "claude-opus-4-6", fallbackAttemptOptions(params, "unknown"))
        .catch(() => undefined);
      return {
        outcome: "completed",
        result: await params.run("openai", "gpt-5.4", fallbackAttemptOptions(params, "unknown")),
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      };
    });
    state.runEmbeddedAgentMock.mockRejectedValueOnce(new Error("upstream 500"));
    state.runEmbeddedAgentMock.mockRejectedValueOnce(new Error("upstream 500"));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun: createFollowupRun({
          catalog: [
            testModel("anthropic", "claude-opus-4-7"),
            testModel("anthropic", "claude-opus-4-6"),
            testModel("openai", "gpt-5.4"),
          ],
          profiles: testAuthProfiles("anthropic", "openai"),
          fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-5.4"],
          selection: {
            model: { provider: "anthropic", id: "claude-opus-4-7" },
            executor: { kind: "harness", id: "openclaw" },
          },
        }),
      }),
    );

    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(3);
    const owner = state.runEmbeddedAgentMock.mock.calls[0]?.[0].assistantErrorTranscript;
    expect(owner).toMatchObject({ record: expect.any(Function), settle: expect.any(Function) });
    for (const [args] of state.runEmbeddedAgentMock.mock.calls) {
      expect(args.assistantErrorTranscript).toBe(owner);
    }
  });

  it("defers the first embedded assistant error after a CLI fallback failure", async () => {
    state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "anthropic");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params
        .run("anthropic", "claude-opus-4-7", initialFallbackAttemptOptions(params))
        .catch(() => undefined);
      return {
        outcome: "completed",
        result: await params.run("openai", "gpt-5.4", fallbackAttemptOptions(params, "unknown")),
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      };
    });
    state.runCliAgentMock.mockRejectedValueOnce(new Error("cli failed"));
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const followupRun = createFollowupRun({
      catalog: [testModel("anthropic", "claude-opus-4-7"), testModel("openai", "gpt-5.4")],
      profiles: testAuthProfiles("anthropic", "openai"),
      fallbacks: ["openai/gpt-5.4"],
      runtimeAuthModes: { "claude-cli": "token" },
    });
    followupRun.run.config = {
      agents: { defaults: { models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } } } },
    };
    followupRun.run.executionSelection = configureTestCliModel(
      followupRun,
      "anthropic",
      "claude-opus-4-7",
      "claude-cli",
      "anthropic",
    );
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));
    expect(result, JSON.stringify(result)).toMatchObject({ kind: "success" });

    expect(state.runCliAgentMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "embedded fallback candidate", {
      assistantErrorTranscript: expect.objectContaining({
        record: expect.any(Function),
        settle: expect.any(Function),
      }),
    });
  });

  it("latches queued user message persistence across main reply fallback candidates", async () => {
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params
        .run("anthropic", "claude-opus-4-7", initialFallbackAttemptOptions(params))
        .catch(() => undefined);
      return {
        outcome: "completed",
        result: await params.run("openai", "gpt-5.4", fallbackAttemptOptions(params, "unknown")),
        provider: "openai",
        model: "gpt-5.4",
        attempts: [],
      };
    });
    state.runEmbeddedAgentMock.mockImplementationOnce(
      async (args: {
        onUserMessagePersisted?: (m: {
          role: "user";
          content: Array<{ type: "text"; text: string }>;
        }) => void;
      }) => {
        args.onUserMessagePersisted?.({
          role: "user",
          content: [{ type: "text", text: "queued" }],
        });
        throw new Error("upstream 500");
      },
    );
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun: createFollowupRun({
          catalog: [testModel("anthropic", "claude-opus-4-7"), testModel("openai", "gpt-5.4")],
          profiles: testAuthProfiles("anthropic", "openai"),
          fallbacks: ["openai/gpt-5.4"],
          selection: {
            model: { provider: "anthropic", id: "claude-opus-4-7" },
            executor: { kind: "harness", id: "openclaw" },
          },
        }),
      }),
    );

    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expectMockCallArgFields(state.runEmbeddedAgentMock, 0, "primary candidate", {
      suppressNextUserMessagePersistence: false,
    });
    expectMockCallArgFields(state.runEmbeddedAgentMock, 1, "fallback candidate", {
      suppressNextUserMessagePersistence: true,
    });
  });
});
