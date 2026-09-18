// Fast mode tests cover isolated cron run behavior in fast execution mode.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  preparedRunPluginRegistryMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  callGatewayMock,
  dispatchCronDeliveryMock,
  retireSessionMcpRuntimeMock,
  resolveCronDeliveryPlanMock,
  resolveFastModeStateMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
  runCliAgentMock,
  resolveEffectiveAgentRuntimeMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

const EXPECTED_OPENAI_MODEL = "gpt-5.4";
const FAST_MODEL_REF = `openai/${EXPECTED_OPENAI_MODEL}`;

async function runFastModeCase(params: {
  configFastMode: boolean | "auto";
  configFastAutoOnSeconds?: number;
  expectedFastMode: boolean | "auto";
  expectedFastModeAutoOnSeconds?: number;
  expectedCleanupBundleMcpOnRunEnd?: boolean;
  expectedRetiredSessionId?: string;
  message: string;
  previousSessionId?: string;
  sessionId?: string;
  sessionFastMode?: boolean | "auto";
  sessionTarget?: string;
  cli?: boolean;
}) {
  const baseSession = makeCronSession();
  resolveCronSessionMock.mockReturnValue(
    makeCronSession({
      ...baseSession,
      ...(params.previousSessionId ? { previousSessionId: params.previousSessionId } : {}),
      sessionEntry: {
        ...baseSession.sessionEntry,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.sessionFastMode === undefined ? {} : { fastMode: params.sessionFastMode }),
      },
    }),
  );
  const registrySnapshot = captureActivePluginRegistrySnapshot();
  if (params.cli) {
    const registry = createEmptyPluginRegistry();
    registry.cliBackends.push({
      pluginId: "fast-mode-cli",
      source: "test",
      backend: { id: "test-cli", modelProvider: "openai", config: { command: "fixture-cli" } },
    });
    preparedRunPluginRegistryMock.mockReturnValue(registry);
    setActivePluginRegistry(registry);
    resolveEffectiveAgentRuntimeMock.mockReturnValue("test-cli");
    runCliAgentMock.mockResolvedValue({ payloads: [{ text: "ok" }], meta: { agentMeta: {} } });
  }
  resolveFastModeStateMock.mockImplementation(({ cfg, sessionEntry }) => {
    const sessionFastMode = sessionEntry?.fastMode;
    if (typeof sessionFastMode === "boolean" || sessionFastMode === "auto") {
      return {
        mode: sessionFastMode,
        enabled: sessionFastMode === "auto" ? true : sessionFastMode,
        source: "session",
        fastAutoOnSeconds: params.configFastAutoOnSeconds ?? 60,
      };
    }
    const mode = cfg.agents?.defaults?.models?.[FAST_MODEL_REF]?.params?.fastMode;
    return {
      mode,
      enabled: mode === "auto" ? true : Boolean(mode),
      source: "config",
      fastAutoOnSeconds: params.configFastAutoOnSeconds ?? 60,
    };
  });

  try {
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {
          agents: {
            defaults: {
              model: { primary: FAST_MODEL_REF, fallbacks: [] },
              models: {
                [FAST_MODEL_REF]: {
                  params: {
                    fastMode: params.configFastMode,
                    ...(params.configFastAutoOnSeconds === undefined
                      ? {}
                      : { fastAutoOnSeconds: params.configFastAutoOnSeconds }),
                  },
                },
              },
            },
          },
        },
        job: makeIsolatedAgentJobFixture({
          sessionTarget: params.sessionTarget ?? "isolated",
          payload: {
            kind: "agentTurn",
            message: params.message,
            model: FAST_MODEL_REF,
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    const selectedRunner = params.cli ? runCliAgentMock : runEmbeddedAgentMock;
    expect(selectedRunner).toHaveBeenCalledOnce();
    const [embeddedRunParams] = expectDefined(selectedRunner.mock.calls[0], "embedded run call");
    expect(embeddedRunParams.provider).toBe(params.cli ? "test-cli" : "openai");
    expect(embeddedRunParams.model).toBe(EXPECTED_OPENAI_MODEL);
    expect(embeddedRunParams.fastMode).toBe(params.expectedFastMode);
    expect(embeddedRunParams.fastModeAutoOnSeconds).toBe(
      params.expectedFastModeAutoOnSeconds ?? 60,
    );
    if (!params.cli) {
      expect(embeddedRunParams.cleanupBundleMcpOnRunEnd).toBe(
        params.expectedCleanupBundleMcpOnRunEnd ?? true,
      );
      expect(embeddedRunParams.allowGatewaySubagentBinding).toBe(true);
    }
    const isIsolated = (params.sessionTarget ?? "isolated") === "isolated";
    if (params.expectedRetiredSessionId) {
      expect(retireSessionMcpRuntimeMock).toHaveBeenCalledOnce();
      const [retireParams] = expectDefined(
        retireSessionMcpRuntimeMock.mock.calls[0],
        "MCP retirement call",
      );
      expect(retireParams.sessionId).toBe(params.expectedRetiredSessionId);
      expect(retireParams.reason).toBe("cron-session-rollover");
      return;
    }
    if (isIsolated) {
      // disposeCronRunContext now retires MCP for isolated sessions
      expect(retireSessionMcpRuntimeMock).toHaveBeenCalledOnce();
      const [disposeRetireParams] = expectDefined(
        retireSessionMcpRuntimeMock.mock.calls[0],
        "MCP disposal call",
      );
      expect(disposeRetireParams.reason).toBe("isolated-cron-dispose");
    } else {
      expect(retireSessionMcpRuntimeMock).not.toHaveBeenCalled();
    }
  } finally {
    if (params.cli) {
      restoreActivePluginRegistrySnapshot(registrySnapshot);
    }
  }
}

describe("runCronIsolatedAgentTurn — fast mode", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("deletes the run-scoped cron session after delivery-none deleteAfterRun jobs", async () => {
    dispatchCronDeliveryMock.mockImplementationOnce(
      (await vi.importActual<typeof import("./delivery-dispatch.js")>("./delivery-dispatch.js"))
        .dispatchCronDelivery,
    );
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          deleteAfterRun: true,
          delivery: { mode: "none" },
          payload: { kind: "agentTurn", message: "cleanup me", model: FAST_MODEL_REF },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:default:cron:test",
        deleteTranscript: true,
        emitLifecycleHooks: false,
        expectedSessionId: "test-session-id",
        expectedLifecycleRevision: "test-lifecycle-revision",
        expectedSessionUpdatedAt: 0,
      },
      timeoutMs: 10_000,
    });
  });

  it.each([false, true])(
    "leaves transcript cleanup with dispatch when it rejects=%s",
    async (rejects) => {
      resolveCronDeliveryPlanMock.mockReturnValue({
        requested: true,
        mode: "announce",
        channel: "messagechat",
        to: "test-target",
      });
      dispatchCronDeliveryMock.mockImplementationOnce(
        ({ deliveryPayloads, summary, outputText, synthesizedText }) => {
          if (rejects) {
            throw new Error("delivery receipt store unavailable");
          }
          return {
            delivered: true,
            deliveryAttempted: true,
            summary,
            outputText,
            synthesizedText,
            deliveryPayloads,
          };
        },
      );

      const result = await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          job: makeIsolatedAgentJobFixture({
            deleteAfterRun: true,
            delivery: { mode: "announce", channel: "messagechat", to: "test-target" },
            payload: { kind: "agentTurn", message: "cleanup once", model: FAST_MODEL_REF },
          }),
        }),
      );

      expect(result.status).toBe(rejects ? "error" : "ok");
      if (rejects) {
        expect(result.error).toBe("delivery receipt store unavailable");
      }
      expect(dispatchCronDeliveryMock).toHaveBeenCalledOnce();
      expect(callGatewayMock).not.toHaveBeenCalled();
      expect(retireSessionMcpRuntimeMock).toHaveBeenCalledWith({
        sessionId: "test-session-id",
        reason: "isolated-cron-dispose",
        onError: expect.any(Function),
      });
    },
  );

  it("passes config-driven fast mode into embedded cron runs", async () => {
    await runFastModeCase({
      configFastMode: true,
      expectedFastMode: true,
      message: "test fast mode",
    });
  });

  it.each([true, false, "auto"] as const)(
    "forwards fast mode %s through CLI cron runs",
    async (mode) => {
      await runFastModeCase({
        configFastMode: mode,
        expectedFastMode: mode,
        configFastAutoOnSeconds: 15,
        expectedFastModeAutoOnSeconds: 15,
        message: "CLI fast mode",
        cli: true,
      });
    },
  );

  it("passes config-driven fast auto cutoff into embedded cron runs", async () => {
    await runFastModeCase({
      configFastMode: "auto",
      configFastAutoOnSeconds: 30,
      expectedFastMode: "auto",
      expectedFastModeAutoOnSeconds: 30,
      message: "test fast auto mode",
    });
  });

  it("honors session fastMode=false over config fastMode=true", async () => {
    await runFastModeCase({
      configFastMode: true,
      expectedFastMode: false,
      message: "test fast mode override",
      sessionFastMode: false,
    });
  });

  it("honors session fastMode=true over config fastMode=false", async () => {
    await runFastModeCase({
      configFastMode: false,
      expectedFastMode: true,
      message: "test fast mode session override",
      sessionFastMode: true,
    });
  });

  it("preserves bundled MCP runtime state for persistent cron session targets", async () => {
    await runFastModeCase({
      configFastMode: true,
      expectedFastMode: true,
      expectedCleanupBundleMcpOnRunEnd: false,
      message: "test persistent cron session",
      sessionTarget: "session:agent:main:main:thread:9999",
    });
  });

  it("retires the previous bundled MCP runtime when a persistent cron session rolls over", async () => {
    await runFastModeCase({
      configFastMode: true,
      expectedFastMode: true,
      expectedCleanupBundleMcpOnRunEnd: false,
      expectedRetiredSessionId: "stale-session-id",
      message: "test persistent cron session rollover",
      previousSessionId: "stale-session-id",
      sessionId: "rotated-session-id",
      sessionTarget: "session:agent:main:main:thread:9999",
    });
  });
});
