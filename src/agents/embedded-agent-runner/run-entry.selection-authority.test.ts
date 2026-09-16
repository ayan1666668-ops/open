import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  admitSessionExecutionFallback,
  encodeSessionExecutionSelection,
} from "../../model-picker/execution-selection-codec.js";
import type { ModelExecutionSelection } from "../../model-picker/execution-selection.js";
import { runEmbeddedAgentEntry } from "./run-entry.js";
import {
  fallbackAttemptOptions,
  initialAttemptOptions,
  makeResult,
  type FallbackRunnerParams,
} from "./run-entry.test-support.js";

const boundary = vi.hoisted(() => ({ runner: vi.fn(), prepareHarness: vi.fn() }));
vi.mock("../model-fallback-runner.js", () => ({
  runWithModelFallback: (params: FallbackRunnerParams) => boundary.runner(params),
}));
vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: (params: unknown) => boundary.prepareHarness(params),
}));
vi.mock("../harness/selection.js", () => ({
  selectAgentHarness: () => ({ id: "openclaw", contextEngineHostCapabilities: [] }),
}));

const primary: ModelExecutionSelection = {
  model: { provider: "qa-provider", id: "qa-primary" },
  executor: { kind: "harness", id: "openclaw" },
};
const fallback: ModelExecutionSelection = {
  ...primary,
  model: { provider: "qa-provider", id: "qa-fallback" },
};

beforeEach(() => {
  boundary.runner.mockReset();
  boundary.prepareHarness.mockReset().mockResolvedValue(undefined);
});

describe("prepared fallback authority", () => {
  it.each(["harness preparation", "candidate precheck"] as const)(
    "blocks dispatch after a same-pair user selection during %s",
    async (window) => {
      const entry: SessionEntry = { sessionId: "qa-session", updatedAt: 1 };
      encodeSessionExecutionSelection(entry, primary, { kind: "initialize" });
      const reached = createDeferred<void>();
      const release = createDeferred<void>();
      const dispatched: ModelExecutionSelection[] = [];
      if (window === "harness preparation") {
        boundary.prepareHarness.mockImplementation(async (params: { modelId: string }) => {
          if (params.modelId === fallback.model.id) {
            reached.resolve();
            await release.promise;
          }
        });
      }
      boundary.runner.mockImplementation(async (params: FallbackRunnerParams) => {
        await params.prepareCandidateChain?.([
          {
            provider: primary.model.provider,
            model: primary.model.id,
            routeOrigin: "requested",
            routeResolution: "resolved",
          },
          {
            provider: fallback.model.provider,
            model: fallback.model.id,
            routeOrigin: "configured-fallback",
            routeResolution: "resolved",
          },
        ]);
        await params.prepareCandidate?.(primary.model.provider, primary.model.id);
        await params.run(primary.model.provider, primary.model.id, initialAttemptOptions(params));
        await params.prepareCandidate?.(fallback.model.provider, fallback.model.id);
        if (window === "candidate precheck") {
          reached.resolve();
          await release.promise;
        }
        return {
          outcome: "completed",
          result: await params.run(
            fallback.model.provider,
            fallback.model.id,
            fallbackAttemptOptions(params, "unknown"),
          ),
          provider: fallback.model.provider,
          model: fallback.model.id,
          attempts: [],
        };
      });
      const run = runEmbeddedAgentEntry({
        selection: {
          cfg: {},
          provider: primary.model.provider,
          model: primary.model.id,
          fallbacksOverride: [`${fallback.model.provider}/${fallback.model.id}`],
        },
        identity: { runId: "qa-run", agentId: "qa-agent", sessionId: entry.sessionId },
        harness: {
          workspaceDir: "/tmp/qa-workspace",
          preparation: { kind: "direct" },
          prepareExecutionSelection: async (provider, model) => {
            const selection: ModelExecutionSelection = {
              model: { provider, id: model },
              executor: primary.executor,
            };
            return {
              selection,
              validateCommit: () =>
                admitSessionExecutionFallback({
                  entry,
                  candidate: selection,
                  metadata: {
                    classifyExecutor: (id) => (id === "openclaw" ? "harness" : undefined),
                  },
                }).status === "admitted"
                  ? undefined
                  : "Current session does not permit that fallback.",
            };
          },
        },
        behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
        runCandidate: async (selection) => {
          dispatched.push(selection);
          return makeResult({ provider: selection.model.provider, model: selection.model.id });
        },
      });
      await Promise.race([
        reached.promise,
        run.then(() => {
          throw new Error("Run completed before the held boundary.");
        }),
      ]);
      entry.modelOverrideSource = "user";
      release.resolve();
      await expect(run).rejects.toThrow("does not permit that fallback");
      expect(dispatched).not.toContainEqual(fallback);
      expect(entry.modelOverride).toBe(primary.model.id);
      expect(entry.agentRuntimeOverride).toBe(primary.executor.id);
    },
  );
});
