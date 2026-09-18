import { describe, expect, it } from "vitest";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./embedded-agent-runner/result-fallback-classifier.js";
import type { EmbeddedRunAttemptResult } from "./embedded-agent-runner/run/types.js";
import { FailoverError } from "./failover-error.js";
import { markFallbackCandidateSkipped } from "./fallback-skip-cache.js";
import type { ModelFallbackStepFields } from "./model-fallback-observation.js";
// Exercises model fallback through the embedded runner integration surface.
import {
  captureRoutingDecisionWork,
  computeBackoffMock,
  observedModelRoutingProvenance,
  runEmbeddedAgent,
  runEmbeddedAttemptMock,
  runEmbeddedEntryFallback,
  runEmbeddedFallback,
  sleepWithAbortMock,
  suspendSessionMock,
} from "./model-fallback.run-embedded.e2e.harness.js";
import {
  makeModelFallbackConfig,
  readFallbackUsageStats,
  withModelFallbackWorkspace,
  writeFallbackAuthStore,
  writeFallbackMultiProfileAuthStore,
} from "./model-fallback.run-embedded.e2e.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

const OVERLOADED_ERROR_PAYLOAD =
  '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
const RATE_LIMIT_ERROR_MESSAGE = "rate limit exceeded";
const LONG_RATE_LIMIT_ERROR_MESSAGE = "429 Too Many Requests: subscription usage limit reached";
const NO_ENDPOINTS_FOUND_ERROR_MESSAGE = "404 No endpoints found for deepseek/deepseek-r1:free.";
// Captured verbatim from a real local HTTP 429 round-tripped through the real
// OpenRouter transport (streamOpenAICompletions) carrying the exact body reported
// in #147546 — not hand-typed. See test/plugins/openrouter-per-day-rate-limit.integration.test.ts
// and src/agents/embedded-agent-runner/run/attempt-recovery.test.ts, which independently
// verify a real HTTP round-trip produces this exact string.
const REAL_TRANSPORT_PER_DAY_CAP_ERROR_MESSAGE =
  "429 Rate limit exceeded: free-models-per-day-high-balance.";
const NO_ERROR_DETAILS_MESSAGE = "Unknown error (no error details in response)";

type EmbeddedAttemptParams = {
  provider: string;
  modelId?: string;
  authProfileId?: string;
};

function mockPrimaryOverloadedThenFallbackSuccess() {
  mockPrimaryErrorThenFallbackSuccess(OVERLOADED_ERROR_PAYLOAD);
}

function makeFallbackSuccessAttempt(): EmbeddedRunAttemptResult {
  return makeEmbeddedRunnerAttempt({
    assistantTexts: ["fallback ok"],
    lastAssistant: buildEmbeddedRunnerAssistant({
      provider: "groq",
      model: "mock-2",
      stopReason: "stop",
      content: [{ type: "text", text: "fallback ok" }],
    }),
  });
}

function mockPrimaryFailureThenFallbackSuccess(
  makePrimaryAttempt: (
    attemptParams: EmbeddedAttemptParams,
  ) => EmbeddedRunAttemptResult | Promise<EmbeddedRunAttemptResult>,
  options?: { primaryProvider?: string },
) {
  const primaryProvider = options?.primaryProvider ?? "openai";
  runEmbeddedAttemptMock.mockImplementation(async (params: unknown) => {
    const attemptParams = params as EmbeddedAttemptParams;
    if (attemptParams.provider === primaryProvider) {
      // Keep route/receipt scenarios bounded with a provider-reported retry cap.
      return { ...(await makePrimaryAttempt(attemptParams)), providerRetryMaxRetries: 3 };
    }
    if (attemptParams.provider === "groq") {
      return makeFallbackSuccessAttempt();
    }
    throw new Error(`Unexpected provider ${attemptParams.provider}`);
  });
}

function mockPrimaryPromptErrorThenFallbackSuccess(errorMessage: string) {
  mockPrimaryFailureThenFallbackSuccess(() =>
    makeEmbeddedRunnerAttempt({
      terminal: { kind: "failed", source: "prompt", error: new Error(errorMessage) },
    }),
  );
}

function mockPrimarySuspendingPromptErrorThenFallbackSuccess(sessionId: string) {
  mockPrimaryFailureThenFallbackSuccess(() =>
    makeEmbeddedRunnerAttempt({
      sessionIdUsed: sessionId,
      terminal: {
        kind: "failed",
        source: "prompt",
        error: new FailoverError(RATE_LIMIT_ERROR_MESSAGE, {
          reason: "rate_limit",
          provider: "openai",
          model: "mock-1",
          suspend: true,
        }),
      },
    }),
  );
}

function mockPrimaryErrorThenFallbackSuccess(
  errorMessage: string,
  options?: { primaryProvider?: string },
) {
  mockPrimaryFailureThenFallbackSuccess(
    (attemptParams) =>
      makeEmbeddedRunnerAttempt({
        assistantTexts: [],
        lastAssistant: buildEmbeddedRunnerAssistant({
          provider: attemptParams.provider,
          model: attemptParams.modelId ?? "mock-1",
          stopReason: "error",
          errorMessage,
        }),
      }),
    options,
  );
}

function mockPrimaryStaleRateLimitTextSuccess(errorMessage: string) {
  mockPrimaryFailureThenFallbackSuccess(() =>
    makeEmbeddedRunnerAttempt({
      assistantTexts: ["primary ok"],
      lastAssistant: buildEmbeddedRunnerAssistant({
        provider: "openai",
        model: "mock-1",
        stopReason: "stop",
        content: [{ type: "text", text: "primary ok" }],
        errorMessage,
      }),
    }),
  );
}

function expectAttemptOrder(expected: Array<{ provider: string; authProfileId: string }>) {
  expect(
    runEmbeddedAttemptMock.mock.calls.map(([params]) => {
      const attempt = params as EmbeddedAttemptParams;
      return { provider: attempt.provider, authProfileId: attempt.authProfileId };
    }),
  ).toEqual(expected);
}

function expectOpenAiThenGroqAttemptOrder(params?: { primaryAttempts?: number }) {
  expectAttemptOrder([
    ...Array.from({ length: params?.primaryAttempts ?? 1 }, () => ({
      provider: "openai",
      authProfileId: "openai:p1",
    })),
    { provider: "groq", authProfileId: "groq:p1" },
  ]);
}

function mockAllProvidersOverloaded() {
  runEmbeddedAttemptMock.mockImplementation(async (params: unknown) => {
    const attemptParams = params as { provider: string; modelId: string; authProfileId?: string };
    if (attemptParams.provider === "openai" || attemptParams.provider === "groq") {
      return makeEmbeddedRunnerAttempt({
        providerRetryMaxRetries: 3,
        assistantTexts: [],
        lastAssistant: buildEmbeddedRunnerAssistant({
          provider: attemptParams.provider,
          model: attemptParams.provider === "openai" ? "mock-1" : "mock-2",
          stopReason: "error",
          errorMessage: OVERLOADED_ERROR_PAYLOAD,
        }),
      });
    }
    throw new Error(`Unexpected provider ${attemptParams.provider}`);
  });
}

function countProviderAttempts(provider: string) {
  return runEmbeddedAttemptMock.mock.calls.filter(
    (call) => (call[0] as { provider?: string })?.provider === provider,
  ).length;
}

function expectProviderAttemptCounts(expected: { openai: number; groq: number }) {
  expect(countProviderAttempts("openai")).toBe(expected.openai);
  expect(countProviderAttempts("groq")).toBe(expected.groq);
}

describe("runWithModelFallback + runEmbeddedAgent failover behavior", () => {
  it("keeps a pinned model on its rate-limit surface instead of escalating to fallback", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackMultiProfileAuthStore(agentDir);
      // Same rate-limit rotation-cap scenario as #58572, but the session pins
      // the model (empty effective ladder + disabled availability). Pre-fix the
      // run derived fallbackConfigured from config defaults, so the rotation
      // cap escalated to fallback_model over the empty ladder and threw the
      // escalation error ("temporarily rate-limited") before spending the
      // same-model retry budget.
      mockPrimaryErrorThenFallbackSuccess(RATE_LIMIT_ERROR_MESSAGE);

      const fallbackSteps: ModelFallbackStepFields[] = [];
      const run = runEmbeddedEntryFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:user-model-override-rate-limit",
        runId: "run:user-model-override-rate-limit",
        fallbacksOverride: [],
        // The persisted pair has explicit fallback permission.
        modelFallbackAvailability: { kind: "disabled_by_model_override" },
        onFallbackStep: (step) => fallbackSteps.push(step),
      });

      await expect(run).rejects.toMatchObject({
        name: "FailoverError",
        message: expect.stringContaining("API rate limit reached"),
        reason: "rate_limit",
        provider: "openai",
        model: "mock-1",
        suspend: true,
      });
      // Pre-fix the bogus escalation fired after two primary attempts; the
      // truthful no-fallback path spends every rotation and same-model retry.
      expect(runEmbeddedAttemptMock.mock.calls.length).toBeGreaterThan(2);
      expect(
        runEmbeddedAttemptMock.mock.calls.every(
          ([params]) => (params as EmbeddedAttemptParams).provider === "openai",
        ),
      ).toBe(true);
      // The exhausted-chain observation records no switch to another model.
      expect(fallbackSteps.map((step) => step.fallbackStepFinalOutcome)).toEqual([
        "chain_exhausted",
      ]);
      expect(fallbackSteps[0]?.fallbackStepToModel).toBeUndefined();
    });
  });

  it.each([
    {
      permission: "explicit",
      availability: { kind: "disabled_by_model_override" } as const,
      locked: false,
      reason: "not-allowed",
    },
    {
      permission: "locked",
      availability: { kind: "disabled_by_model_selection_lock" } as const,
      locked: true,
      reason: "locked",
    },
  ])(
    "does not let a configured fallback ladder bypass $permission selection",
    async ({ permission, availability, locked, reason }) => {
      await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
        await writeFallbackAuthStore(agentDir);
        mockPrimaryOverloadedThenFallbackSuccess();
        const prepared: Array<{ model: string; status: string; reason: string }> = [];
        const run = runEmbeddedEntryFallback({
          agentDir,
          workspaceDir,
          sessionKey: `agent:test:configured-fallback-${permission}`,
          runId: `run:configured-fallback-${permission}`,
          modelFallbackAvailability: availability,
          modelSelectionLocked: locked,
          onPreparation: (model, result) =>
            prepared.push({ model, status: result.status, reason: result.reason }),
        });
        await expect(run).rejects.toThrow();
        expect(prepared).toEqual(
          expect.arrayContaining([
            { model: "mock-1", status: "ready", reason: "model" },
            { model: "mock-2", status: "rejected", reason },
          ]),
        );
        expect(countProviderAttempts("openai")).toBeGreaterThan(0);
        expect(countProviderAttempts("groq")).toBe(0);
      });
    },
  );

  it("keeps fallback enabled for an auto-selected model route", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir);
      mockPrimaryOverloadedThenFallbackSuccess();

      const result = await runEmbeddedEntryFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:auto-model-route-retry-limit",
        runId: "run:auto-model-route-retry-limit",
        // Use the populated configuration ladder through real candidate-chain preparation.
        modelFallbackAvailability: { kind: "active", models: ["groq/mock-2"], source: "inherited" },
      });

      expect(result.result.payloads?.[0]?.text).toContain("fallback ok");
      expect(result.result.meta.error).toBeUndefined();
      expect(
        runEmbeddedAttemptMock.mock.calls.map(
          ([params]) => (params as EmbeddedAttemptParams).provider,
        ),
      ).toContain("groq");
    });
  });

  it("carries failed outer candidates into the winning execution trace", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir);
      mockPrimaryOverloadedThenFallbackSuccess();
      const { decisionWork, result } = await captureRoutingDecisionWork(() =>
        runEmbeddedEntryFallback({
          agentDir,
          workspaceDir,
          sessionKey: "agent:test:execution-trace-fallback",
          runId: "run:execution-trace-fallback",
        }),
      );

      expect(result.result.meta.executionTrace).toMatchObject({
        winnerProvider: "groq",
        winnerModel: "mock-2",
        fallbackUsed: true,
        runner: "embedded",
      });
      expect(result.result.meta.executionTrace?.attempts).toEqual([
        expect.objectContaining({
          provider: "openai",
          model: "mock-1",
          result: "candidate_failed",
          reason: "overloaded",
        }),
        expect.objectContaining({
          provider: "groq",
          model: "mock-2",
          result: "success",
        }),
      ]);
      expect(result.result.meta.agentMeta?.terminalReceipt).toMatchObject({
        requested: { provider: "openai", model: "mock-1" },
        effective: { provider: "groq", model: "mock-2" },
        rerouted: true,
      });
      expect(result.terminal.metadata.terminalReceipt).toMatchObject({
        requested: { provider: "openai", model: "mock-1" },
        effective: { provider: "groq", model: "mock-2" },
        rerouted: true,
      });
      expect(decisionWork).toHaveLength(5);
      expect(decisionWork.map((work) => work.receipt)).toMatchObject([
        ...Array.from({ length: 4 }, (_, attempt) => ({
          action: { summary: "Requested openai/mock-1; selected openai/mock-1." },
          decision: {
            reasonCode:
              attempt === 0 ? "model_route_selected" : "model_route_selected_after_fallback",
          },
        })),
        {
          action: { summary: "Requested openai/mock-1; selected groq/mock-2." },
          decision: { reasonCode: "overloaded" },
        },
      ]);
      expect(observedModelRoutingProvenance).toMatchObject([
        { stage: "initial" },
        { stage: "fallback", fallbackReason: "overloaded" },
      ]);
    });
  });

  it("does not record a receipt for a skipped fallback candidate", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      const runId = "run:execution-trace-skipped-fallback";
      await writeFallbackAuthStore(agentDir);
      mockAllProvidersOverloaded();
      markFallbackCandidateSkipped({
        sessionId: `session:${runId}`,
        provider: "groq",
        model: "mock-2",
        authScope: "groq:p1",
        reason: "auth",
        ttlMs: 60_000,
      });

      const { decisionWork } = await captureRoutingDecisionWork(async () => {
        await expect(
          runEmbeddedEntryFallback({
            agentDir,
            workspaceDir,
            sessionKey: "agent:test:execution-trace-skipped-fallback",
            runId,
          }),
        ).rejects.toThrow("All models failed");
        expectAttemptOrder(
          Array.from({ length: 4 }, () => ({ provider: "openai", authProfileId: "openai:p1" })),
        );
      });
      expect(
        decisionWork.map((work) => ({
          target: work.refs?.target?.value,
          reason: work.receipt.decision.reasonCode,
        })),
      ).toEqual(
        Array.from({ length: 4 }, (_, attempt) => ({
          target: JSON.stringify(["openai", "mock-1"]),
          reason: attempt === 0 ? "model_route_selected" : "model_route_selected_after_fallback",
        })),
      );
    });
  });

  it("keeps tool summary on incomplete side-effect terminal results", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir);
      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeEmbeddedRunnerAttempt({
          toolMetas: [{ toolName: "write", meta: "path=out.txt" }],
          lastAssistant: buildEmbeddedRunnerAssistant({
            provider: "openai",
            model: "mock-1",
            stopReason: "stop",
            content: [],
          }),
        }),
      );

      const result = await runEmbeddedAgent({
        sessionId: "session:tool-side-effect-terminal",
        sessionKey: "agent:test:tool-side-effect-terminal",
        workspaceDir,
        agentDir,
        config: makeModelFallbackConfig(),
        prompt: "write the file",
        provider: "openai",
        model: "mock-1",
        authProfileIdSource: "auto",
        timeoutMs: 5_000,
        runId: "run:tool-side-effect-terminal",
        enqueue: async (task) => await task(),
      });

      expect(result.meta.toolSummary?.calls).toBe(1);
      expect(result.meta.toolSummary?.tools).toEqual(["write"]);
      expect(
        classifyEmbeddedAgentRunResultForModelFallback({
          provider: "openai",
          model: "gpt-5.4",
          result,
        }),
      ).toBeNull();
    });
  });

  it.each([
    {
      name: "falls back on OpenRouter-style no-endpoints assistant errors",
      message: NO_ENDPOINTS_FOUND_ERROR_MESSAGE,
      reason: "model_not_found",
      primaryAttempts: 1,
      runName: "model-not-found-no-endpoints",
    },
    {
      name: "falls back on timeout errors using defaults-only model fallbacks",
      message: "LLM request timed out.",
      reason: "timeout",
      primaryAttempts: 4,
      runName: "timeout-defaults-fallback",
    },
    {
      name: "falls back across providers after a bare leading 402 quota-refresh assistant error",
      message:
        "402 You have reached your subscription quota limit. Please wait for automatic quota refresh in the rolling time window, upgrade to a higher plan, or use a Pay-As-You-Go API Key for unlimited access.",
      reason: "rate_limit",
      primaryAttempts: 1,
      runName: "bare-402-cross-provider",
    },
  ])("$name", async ({ message, reason, primaryAttempts, runName }) => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir);
      mockPrimaryErrorThenFallbackSuccess(message);

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: `agent:test:${runName}`,
        runId: `run:${runName}`,
      });

      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");
      expect(result.attempts[0]?.reason).toBe(reason);
      expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");

      expectOpenAiThenGroqAttemptOrder({ primaryAttempts });
    });
  });

  it("falls back after Azure Foundry omits error details without cooling down the profile", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir, undefined, { primaryProvider: "azure-foundry" });
      mockPrimaryErrorThenFallbackSuccess(NO_ERROR_DETAILS_MESSAGE, {
        primaryProvider: "azure-foundry",
      });

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:no-error-details-no-cooldown",
        runId: "run:no-error-details-no-cooldown",
        config: makeModelFallbackConfig("azure-foundry"),
        provider: "azure-foundry",
      });

      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");
      expect(result.attempts[0]?.reason).toBe("no_error_details");
      expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");

      const usageStats = await readFallbackUsageStats(agentDir);
      expect(usageStats["azure-foundry:p1"]?.cooldownUntil).toBeUndefined();
      expect(usageStats["azure-foundry:p1"]?.failureCounts?.no_error_details).toBeUndefined();
      expect(typeof usageStats["groq:p1"]?.lastUsed).toBe("number");

      expect(countProviderAttempts("azure-foundry")).toBeGreaterThan(0);
      expect(countProviderAttempts("openai")).toBe(0);
      expect(countProviderAttempts("groq")).toBe(1);
      expect(computeBackoffMock).not.toHaveBeenCalled();
      expect(sleepWithAbortMock).not.toHaveBeenCalled();
    });
  });

  it("falls back after overloaded primary failure without poisoning profile health", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir);
      mockPrimaryOverloadedThenFallbackSuccess();

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:overloaded-cross-provider",
        runId: "run:overloaded-cross-provider",
      });

      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");
      expect(result.attempts[0]?.reason).toBe("overloaded");
      expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");

      const usageStats = await readFallbackUsageStats(agentDir);
      expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
      expect(usageStats["openai:p1"]?.failureCounts?.overloaded).toBeUndefined();
      expect(typeof usageStats["groq:p1"]?.lastUsed).toBe("number");

      expectOpenAiThenGroqAttemptOrder({ primaryAttempts: 4 });
      expect(computeBackoffMock).not.toHaveBeenCalled();
      expect(sleepWithAbortMock).toHaveBeenCalledTimes(3);
    });
  });

  it("falls back after a real-transport per-day cap on the very first attempt, unlike overloaded's bounded retries (#147546)", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir);
      mockPrimaryErrorThenFallbackSuccess(REAL_TRANSPORT_PER_DAY_CAP_ERROR_MESSAGE);

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:per-day-cap-cross-provider",
        runId: "run:per-day-cap-cross-provider",
      });

      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");
      expect(result.attempts[0]?.reason).toBe("rate_limit");
      expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");

      const usageStats = await readFallbackUsageStats(agentDir);
      expect(typeof usageStats["groq:p1"]?.lastUsed).toBe("number");

      // The whole point of the fix: unlike overloaded above (4 bounded
      // same-model retries before escalating), an exhausted daily/weekly/monthly
      // cap gets exactly one primary attempt and no backoff sleep at all — the
      // production orchestrator recognizes retrying cannot possibly succeed and
      // routes straight to the real second model, which actually completes.
      expectOpenAiThenGroqAttemptOrder({ primaryAttempts: 1 });
      expect(computeBackoffMock).not.toHaveBeenCalled();
      expect(sleepWithAbortMock).not.toHaveBeenCalled();
    });
  });

  it("falls back after embedded provider transport failures and records timeout health", async () => {
    const cases = [
      {
        name: "undici-terminated",
        message: "terminated",
      },
      {
        name: "stream-read-error",
        message: "stream_read_error",
      },
      {
        name: "codex-empty-transport-response",
        message: "Request failed",
      },
    ] as const;

    for (const { name, message } of cases) {
      await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
        await writeFallbackAuthStore(agentDir);
        runEmbeddedAttemptMock.mockClear();
        computeBackoffMock.mockClear();
        sleepWithAbortMock.mockClear();
        mockPrimaryErrorThenFallbackSuccess(message);

        const result = await runEmbeddedFallback({
          agentDir,
          workspaceDir,
          sessionKey: `agent:test:transport-fallback:${name}`,
          runId: `run:transport-fallback:${name}`,
        });

        expect(result.provider).toBe("groq");
        expect(result.model).toBe("mock-2");
        expect(result.attempts[0]?.reason).toBe("timeout");
        expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");

        const usageStats = await readFallbackUsageStats(agentDir);
        expect(usageStats["openai:p1"]?.cooldownUntil).toEqual(expect.any(Number));
        expect(usageStats["openai:p1"]?.failureCounts).toEqual({ timeout: 1 });
        expect(typeof usageStats["groq:p1"]?.lastUsed).toBe("number");

        expectOpenAiThenGroqAttemptOrder({ primaryAttempts: 4 });
        expect(computeBackoffMock).not.toHaveBeenCalled();
        expect(sleepWithAbortMock).toHaveBeenCalledTimes(3);
      });
    }
  });

  it("keeps direct embedded-run session suspension outside the outer fallback loop", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir);
      const sessionId = "session:direct-embedded-suspension";
      mockPrimarySuspendingPromptErrorThenFallbackSuccess(sessionId);

      await expect(
        runEmbeddedAgent({
          sessionId,
          sessionKey: "agent:test:direct-embedded-suspension",
          workspaceDir,
          agentDir,
          config: {
            ...makeModelFallbackConfig(),
          },
          prompt: "hello",
          provider: "openai",
          model: "mock-1",
          lane: "direct-lane",
          authProfileIdSource: "auto",
          timeoutMs: 5_000,
          runId: "run:direct-embedded-suspension",
          enqueue: async (task) => await task(),
        }),
      ).rejects.toThrow();

      expect(suspendSessionMock).toHaveBeenCalledOnce();
      expect(suspendSessionMock.mock.calls[0]?.[0]).not.toHaveProperty("laneId");
    });
  });

  it("does not suspend the session while an outer fallback candidate remains", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir);
      const sessionId = "session:outer-fallback-suspension";
      mockPrimarySuspendingPromptErrorThenFallbackSuccess(sessionId);

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionId,
        sessionKey: "agent:test:outer-fallback-suspension",
        lane: "outer-fallback-lane",
        runId: "run:outer-fallback-suspension",
        config: {
          ...makeModelFallbackConfig(),
        },
      });

      expect(result.provider).toBe("groq");
      expect(suspendSessionMock).not.toHaveBeenCalled();
    });
  });

  it("surfaces a bounded overloaded summary when every fallback candidate is overloaded", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir);
      mockAllProvidersOverloaded();

      let thrown: unknown;
      try {
        await runEmbeddedFallback({
          agentDir,
          workspaceDir,
          sessionKey: "agent:test:all-overloaded",
          runId: "run:all-overloaded",
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/^All models failed \(2\): /);
      expect((thrown as Error).message).toMatch(
        /openai\/mock-1: .* \(overloaded\) \| groq\/mock-2: .* \(overloaded\)/,
      );

      expectAttemptOrder([
        ...Array.from({ length: 4 }, () => ({ provider: "openai", authProfileId: "openai:p1" })),
        ...Array.from({ length: 4 }, () => ({ provider: "groq", authProfileId: "groq:p1" })),
      ]);
      expect(computeBackoffMock).not.toHaveBeenCalled();
      expect(sleepWithAbortMock).toHaveBeenCalledTimes(6);
    });
  });

  it("probes a provider already in overloaded cooldown before falling back", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      const now = Date.now();
      await writeFallbackAuthStore(agentDir, {
        "openai:p1": {
          lastUsed: 1,
          cooldownUntil: now + 60_000,
          failureCounts: { overloaded: 2 },
        },
        "groq:p1": { lastUsed: 2 },
      });
      mockPrimaryOverloadedThenFallbackSuccess();

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:overloaded-probe-fallback",
        runId: "run:overloaded-probe-fallback",
      });

      expect(result.provider).toBe("groq");
      expectOpenAiThenGroqAttemptOrder({ primaryAttempts: 4 });
    });
  });

  it("keeps overloaded failures provider-scoped across turns while continuing fallback", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir);
      mockPrimaryOverloadedThenFallbackSuccess();

      const firstResult = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:overloaded-two-turns:first",
        runId: "run:overloaded-two-turns:first",
      });

      expect(firstResult.provider).toBe("groq");

      runEmbeddedAttemptMock.mockClear();
      computeBackoffMock.mockClear();
      sleepWithAbortMock.mockClear();

      mockPrimaryOverloadedThenFallbackSuccess();

      const secondResult = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:overloaded-two-turns:second",
        runId: "run:overloaded-two-turns:second",
      });

      expect(secondResult.provider).toBe("groq");
      expectOpenAiThenGroqAttemptOrder({ primaryAttempts: 4 });

      const usageStats = await readFallbackUsageStats(agentDir);
      expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
      expect(usageStats["openai:p1"]?.failureCounts?.overloaded).toBeUndefined();
      expect(computeBackoffMock).not.toHaveBeenCalled();
      expect(sleepWithAbortMock).toHaveBeenCalledTimes(3);
    });
  });

  it("classifies bare service-unavailable failures as overloaded without cooling the profile", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir);
      mockPrimaryErrorThenFallbackSuccess("LLM error: service unavailable");

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:timeout-cross-provider",
        runId: "run:timeout-cross-provider",
      });

      expect(result.provider).toBe("groq");
      expect(result.attempts[0]?.reason).toBe("overloaded");

      const usageStats = await readFallbackUsageStats(agentDir);
      expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
      expect(usageStats["openai:p1"]?.failureCounts).toBeUndefined();
      expectOpenAiThenGroqAttemptOrder({ primaryAttempts: 4 });
      expect(computeBackoffMock).not.toHaveBeenCalled();
      expect(sleepWithAbortMock).toHaveBeenCalledTimes(3);
    });
  });

  it("caps overloaded profile rotations and escalates to cross-provider fallback (#58348)", async () => {
    // When a provider has multiple auth profiles and all return overloaded_error,
    // the runner should not exhaust all profiles before falling back. It should
    // cap profile rotations at overloadedProfileRotations=1 and escalate
    // to cross-provider fallback after its bounded same-profile retries.
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackMultiProfileAuthStore(agentDir);
      mockPrimaryOverloadedThenFallbackSuccess();

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:overloaded-multi-profile-cap",
        runId: "run:overloaded-multi-profile-cap",
      });

      // Should fall back to groq instead of exhausting all 3 openai profiles
      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");
      expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");

      // With overloadedProfileRotations=1, we expect:
      // - 1 initial openai attempt and 3 budgeted retries (p1)
      // - 1 rotation to p2 (capped)
      // - escalation to groq (1 attempt)
      // The transient budget stays shared across the capped profile rotation.
      expectAttemptOrder([
        ...Array.from({ length: 4 }, () => ({ provider: "openai", authProfileId: "openai:p1" })),
        { provider: "openai", authProfileId: "openai:p2" },
        { provider: "groq", authProfileId: "groq:p1" },
      ]);
      expect(sleepWithAbortMock).toHaveBeenCalledTimes(3);
    });
  });

  it("caps long-window rate-limit profile rotations and escalates to fallback (#58572)", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackMultiProfileAuthStore(agentDir);

      mockPrimaryErrorThenFallbackSuccess(LONG_RATE_LIMIT_ERROR_MESSAGE);

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:rate-limit-multi-profile-cap",
        runId: "run:rate-limit-multi-profile-cap",
      });

      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");
      expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");

      expectProviderAttemptCounts({ openai: 2, groq: 1 });
    });
  });

  it("ignores stale classified rate-limit text when stopReason is not error", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackMultiProfileAuthStore(agentDir);

      mockPrimaryStaleRateLimitTextSuccess(RATE_LIMIT_ERROR_MESSAGE);

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:rate-limit-retry-limit-fallback",
        runId: "run:rate-limit-retry-limit-fallback",
        config: {
          ...makeModelFallbackConfig(),
        },
      });

      expect(result.provider).toBe("openai");
      expect(result.model).toBe("mock-1");
      expect(result.attempts).toEqual([]);

      expectProviderAttemptCounts({ openai: 1, groq: 0 });
    });
  });

  it("caps prompt-side long-window rate-limit rotations before cross-provider fallback", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackMultiProfileAuthStore(agentDir);

      mockPrimaryPromptErrorThenFallbackSuccess(LONG_RATE_LIMIT_ERROR_MESSAGE);

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:prompt-rate-limit-multi-profile-cap",
        runId: "run:prompt-rate-limit-multi-profile-cap",
      });

      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");

      expectProviderAttemptCounts({ openai: 2, groq: 1 });
    });
  });

  it("rotates Codex profiles on structured prompt rate limits before model fallback", async () => {
    await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackMultiProfileAuthStore(agentDir, { openAiProfileCount: 2 });
      mockPrimaryFailureThenFallbackSuccess(() => {
        return makeEmbeddedRunnerAttempt({
          terminal: {
            kind: "failed",
            source: "prompt",
            error: Object.assign(new Error("You've reached your Codex subscription usage limit."), {
              status: 429 as const,
            }),
          },
        });
      });

      const result = await runEmbeddedFallback({
        agentDir,
        workspaceDir,
        sessionKey: "agent:test:codex-structured-prompt-rate-limit",
        runId: "run:codex-structured-prompt-rate-limit",
      });

      expect(result.provider).toBe("groq");
      expect(result.model).toBe("mock-2");
      expect(result.attempts[0]?.reason).toBe("rate_limit");
      expectProviderAttemptCounts({ openai: 2, groq: 1 });
      const primaryCalls = runEmbeddedAttemptMock.mock.calls
        .map(([params]) => params as EmbeddedAttemptParams)
        .filter((params) => params.provider === "openai");
      expect(primaryCalls.map((params) => params.authProfileId)).toStrictEqual([
        "openai:p1",
        "openai:p2",
      ]);
      expect(primaryCalls.map((params) => params.modelId)).toStrictEqual(["mock-1", "mock-1"]);
    });
  });
});
