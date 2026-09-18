import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, beforeEach, expect, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { isModelExecutionSelection } from "../model-picker/execution-selection.js";
import type { PreparedSessionExecutionSelection } from "../model-picker/execution-selection.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  getActivePluginRegistryVersion,
  requireActivePluginRegistry,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import type { ModelFallbackAvailability } from "./agent-scope.js";
import type { RunEmbeddedAgentInternalParams } from "./embedded-agent-runner/run/internal-params.js";
import type { EmbeddedRunAttemptResult } from "./embedded-agent-runner/run/types.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { resetFallbackSkipCacheForTest } from "./fallback-skip-cache.test-support.js";
import type { ModelFallbackStepFields } from "./model-fallback-observation.js";
import { makeModelFallbackConfig } from "./model-fallback.run-embedded.e2e.test-support.js";
import type { evaluatePublishedModelRuntimeChoice } from "./model-runtime-choice.js";
import { createResolvedEmbeddedRunnerModel } from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBackoffE2eMocks,
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

const evaluateRuntimeChoiceMock = vi.fn<typeof evaluatePublishedModelRuntimeChoice>();
export const runEmbeddedAttemptMock =
  vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();
export const observedModelRoutingProvenance: Array<{
  stage: "initial" | "fallback";
  fallbackReason?: string;
}> = [];
const suspendSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const { computeBackoffMock, sleepWithAbortMock } = vi.hoisted(() => ({
  computeBackoffMock: vi.fn(
    (
      _policy: { initialMs: number; maxMs: number; factor: number; jitter: number },
      _attempt: number,
    ) => 321,
  ),
  sleepWithAbortMock: vi.fn(async (_ms: number, _abortSignal?: AbortSignal) => undefined),
}));

export { computeBackoffMock, sleepWithAbortMock, suspendSessionMock };

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
}));

const installRunEmbeddedMocks = () => {
  // Install the runner mocks before importing runEmbeddedAgent so the e2e path
  // exercises fallback orchestration without live model/provider calls.
  vi.doMock("./model-runtime-choice.js", () => ({
    evaluatePublishedModelRuntimeChoice: evaluateRuntimeChoiceMock,
  }));
  vi.doMock("./harness/runtime-plugin.js", () => ({
    ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
  }));
  installEmbeddedRunnerBaseE2eMocks({
    get pluginRegistry() {
      return requireActivePluginRegistry();
    },
  });
  installEmbeddedRunnerFastRunE2eMocks({
    runEmbeddedAttempt: (params) => runEmbeddedAttemptMock(params),
  });
  installEmbeddedRunnerBackoffE2eMocks({
    computeBackoff: (policy, attempt) => computeBackoffMock(policy, attempt),
    sleepWithAbort: (ms, abortSignal) => sleepWithAbortMock(ms, abortSignal),
  });
  vi.doMock("./embedded-agent-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) =>
      createResolvedEmbeddedRunnerModel(provider, modelId),
  }));
  vi.doMock("./session-suspension.js", async () => {
    const actual =
      await vi.importActual<typeof import("./session-suspension.js")>("./session-suspension.js");
    return { ...actual, suspendSession: suspendSessionMock };
  });
};

type ProductionRunEmbeddedAgent = typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
type TestRunEmbeddedAgent = (
  params: Omit<RunEmbeddedAgentInternalParams, "admittedRunContext">,
) => Promise<EmbeddedAgentRunResult>;
export let runEmbeddedAgent: TestRunEmbeddedAgent;
let runEmbeddedAgentWithPreparedAdmission: ProductionRunEmbeddedAgent;
let runWithModelFallback: typeof import("./model-fallback-runner.js").runWithModelFallback;
let runEmbeddedAgentEntry: typeof import("./embedded-agent-runner/run-entry.js").runEmbeddedAgentEntry;
let commitSessionExecutionSelection: typeof import("../model-picker/apply-session-model-selection.js").commitSessionExecutionSelection;
let prepareSessionExecutionSelection: typeof import("../model-picker/apply-session-model-selection.js").prepareSessionExecutionSelection;
export let captureRoutingDecisionWork: typeof import("./test-helpers/model-routing-decision-e2e-fixtures.js").captureRoutingDecisionWork;
let createModelRoutingTestAdmission: typeof import("./test-helpers/model-routing-decision-e2e-fixtures.js").createModelRoutingTestAdmission;

beforeAll(async () => {
  installRunEmbeddedMocks();
  runEmbeddedAgentWithPreparedAdmission = (await import("./embedded-agent-runner/run.js"))
    .runEmbeddedAgent;
  runEmbeddedAgent = wrapRunWithTestPreparedAdmission(runEmbeddedAgentWithPreparedAdmission);
  ({ runWithModelFallback } = await import("./model-fallback-runner.js"));
  ({ runEmbeddedAgentEntry } = await import("./embedded-agent-runner/run-entry.js"));
  ({ prepareSessionExecutionSelection, commitSessionExecutionSelection } =
    await import("../model-picker/apply-session-model-selection.js"));
  ({ captureRoutingDecisionWork, createModelRoutingTestAdmission } =
    await import("./test-helpers/model-routing-decision-e2e-fixtures.js"));
});

beforeEach(() => {
  const registry = captureActivePluginRegistrySnapshot();
  setActivePluginRegistry(createEmptyPluginRegistry());
  let current = true;
  onTestFinished(() => {
    current = false;
    restoreActivePluginRegistrySnapshot(registry);
  });
  evaluateRuntimeChoiceMock
    .mockReset()
    .mockImplementation(async ({ cfg, provider, model, runtimeId }) => {
      const configured = cfg.models?.providers?.[provider]?.models.find(
        (entry) => entry.id === model,
      );
      if (!configured) {
        return { kind: "unknown", message: "The fixture has no published model." };
      }
      if (runtimeId !== "openclaw") {
        return { kind: "unsupported", message: "The fixture uses the host executor." };
      }
      const generation = getActivePluginRegistryVersion();
      return {
        kind: "ready",
        entry: { provider, id: model, name: configured.name },
        validate: () =>
          current && generation === getActivePluginRegistryVersion()
            ? undefined
            : "The fixture catalog retired.",
      };
    });
  resetFallbackSkipCacheForTest();
  observedModelRoutingProvenance.length = 0;
  runEmbeddedAttemptMock.mockReset();
  suspendSessionMock.mockClear();
  computeBackoffMock.mockClear();
  sleepWithAbortMock.mockClear();
});

export async function runEmbeddedFallback(params: {
  agentDir: string;
  workspaceDir: string;
  sessionKey: string;
  runId: string;
  provider?: string;
  sessionId?: string;
  lane?: string;
  abortSignal?: AbortSignal;
  config?: OpenClawConfig;
}) {
  // Runs the same embedded-agent entrypoint that production fallback uses while
  // keeping provider/model attempts deterministic through mocks.
  const cfg = params.config ?? makeModelFallbackConfig();
  const sessionId = params.sessionId ?? `session:${params.runId}`;
  return await runWithModelFallback({
    cfg,
    provider: params.provider ?? "openai",
    model: "mock-1",
    runId: params.runId,
    sessionId: params.sessionId,
    lane: params.lane,
    agentDir: params.agentDir,
    abortSignal: params.abortSignal,
    run: (provider, model, options) =>
      runEmbeddedAgent({
        sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        config: cfg,
        prompt: "hello",
        provider,
        model,
        lane: params.lane,
        authProfileIdSource: "auto",
        allowTransientCooldownProbe: options?.allowTransientCooldownProbe,
        isFinalFallbackAttempt: options?.isFinalFallbackAttempt,
        timeoutMs: 5_000,
        runId: params.runId,
        abortSignal: params.abortSignal,
        enqueue: async (task) => await task(),
      }),
  });
}

export async function runEmbeddedEntryFallback(params: {
  agentDir: string;
  workspaceDir: string;
  sessionKey: string;
  runId: string;
  config?: OpenClawConfig;
  fallbacksOverride?: string[];
  modelFallbackAvailability?: ModelFallbackAvailability;
  modelSelectionLocked?: boolean;
  onPreparation?: (model: string, result: PreparedSessionExecutionSelection) => void;
  onFallbackStep?: (step: ModelFallbackStepFields) => void;
}) {
  const cfg = params.config ?? makeModelFallbackConfig();
  const sessionId = `session:${params.runId}`;
  const storePath = path.join(params.agentDir, "sessions.json");
  const scope = { agentId: "test", sessionKey: params.sessionKey, storePath };
  const fixtureEntry: SessionEntry = {
    sessionId,
    updatedAt: Date.now(),
    ...(params.modelSelectionLocked ? { modelSelectionLocked: true } : {}),
  };
  commitSessionExecutionSelection(
    fixtureEntry,
    {
      executor: { kind: "harness", id: "openclaw" },
      model: { provider: "openai", id: "mock-1" },
    },
    {
      cause: {
        kind:
          params.modelFallbackAvailability?.kind === "disabled_by_model_override"
            ? "user"
            : "reset",
      },
    },
  );
  await replaceSessionEntry(scope, fixtureEntry);
  const sessionEntry = loadSessionEntry(scope);
  if (!sessionEntry) {
    throw new Error("Missing persisted fallback session.");
  }
  const preparedRunAdmission = createModelRoutingTestAdmission({
    cfg: { ...cfg, logging: { audit: { executionIdentity: true } } },
    runId: params.runId,
    boundary: "model-fallback-e2e",
  });
  try {
    return await runEmbeddedAgentEntry({
      selection: {
        cfg,
        provider: "openai",
        model: "mock-1",
        agentDir: params.agentDir,
        manifestPlugins: [],
        fallbacksOverride: params.fallbacksOverride,
      },
      identity: {
        runId: params.runId,
        agentId: "test",
        sessionId,
        sessionKey: params.sessionKey,
      },
      harness: {
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
        preparation: { kind: "direct" },
        prepareExecutionSelection: async (provider, model) => {
          const prepared = await prepareSessionExecutionSelection({
            cfg,
            ...scope,
            sessionEntry,
            request: {
              kind: "fallback",
              selection: {
                model: { provider, id: model },
                executor: { kind: "harness", id: "openclaw" },
              },
            },
          });
          params.onPreparation?.(model, prepared);
          if (prepared.status !== "ready") {
            throw new Error(prepared.message);
          }
          if (!isModelExecutionSelection(prepared.selection)) {
            throw new Error("The fallback fixture requires a concrete model.");
          }
          return { selection: prepared.selection, validateCommit: prepared.validateCommit };
        },
        resolveContextEngineHost: (selection) => ({
          id: `embedded-e2e:${selection.model.provider}/${selection.model.id}`,
          label: "embedded runner e2e",
          capabilities: [],
        }),
      },
      behavior: { kind: "maintenance" },
      onFallbackStep: params.onFallbackStep,
      runCandidate: (selection, options) => {
        const { provider, id: model } = selection.model;
        observedModelRoutingProvenance.push(
          expectDefined(options.modelRoutingProvenance, "model attempt routing provenance"),
        );
        return runEmbeddedAgentWithPreparedAdmission({
          preparedRunAdmission,
          sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          config: cfg,
          ...(params.modelFallbackAvailability
            ? { modelFallbackAvailability: params.modelFallbackAvailability }
            : {}),
          prompt: "hello",
          provider,
          model,
          modelRoutingProvenance: options.modelRoutingProvenance,
          agentHarnessRuntimeOverride: selection.executor.id,
          authProfileIdSource: "auto",
          isFinalFallbackAttempt: options.isFinalFallbackAttempt,
          timeoutMs: 5_000,
          runId: params.runId,
          enqueue: async (task) => await task(),
          contextEngineLogicalTurnLease: options.contextEngineLogicalTurnLease,
          onContextEngineTurnCandidate: options.onContextEngineTurnCandidate,
        });
      },
    });
  } finally {
    preparedRunAdmission.close();
    expect(loadSessionEntry(scope)?.executionSelection).toEqual(sessionEntry.executionSelection);
    expect(loadSessionEntry(scope)?.modelSelectionLocked).toBe(sessionEntry.modelSelectionLocked);
  }
}
