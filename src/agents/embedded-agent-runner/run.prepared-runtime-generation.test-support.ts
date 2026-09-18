import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  withPreparedModelRuntimePluginGenerationScope,
} from "../prepared-model-runtime-generation-scope.js";
import type {
  PreparedModelRuntimeLeaseOptions,
  PreparedModelRuntimePluginGeneration,
} from "../prepared-model-runtime.types.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  type TestRunEmbeddedAgent,
  mockedAcquireAgentRunPreparedModelRuntime,
  mockedBuildEmbeddedRunPayloads,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import type { RunEmbeddedAgentInternalParams } from "./run/internal-params.js";

export function registerPreparedRuntimeGenerationTests(
  loadSourceDeliveryHarness: () => Promise<{
    runEmbeddedAgent: TestRunEmbeddedAgent;
    state: OpenClawTestState;
  }>,
) {
  it("completes an admitted turn on A after plugin-runtime generation B publishes", async () => {
    const { runEmbeddedAgent, state } = await loadSourceDeliveryHarness();
    const config = {};
    const workspaceDir = state.workspaceDir;
    const pluginRegistry = createEmptyPluginRegistry();
    const baseLease = await mockedAcquireAgentRunPreparedModelRuntime({
      agentId: "main",
      agentDir: state.agentDir(),
      workspaceDir,
    });
    const admittedMetadataSnapshot = {
      ...baseLease.snapshot.metadataSnapshot,
      policyHash: "admitted",
      workspaceDir,
    };
    const admittedGeneration: PreparedModelRuntimePluginGeneration = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: admittedMetadataSnapshot,
      pluginRegistry,
    };
    const replacementMetadataSnapshot = {
      ...baseLease.snapshot.metadataSnapshot,
      policyHash: "replacement",
      workspaceDir,
    };
    const admittedSnapshot = {
      ...baseLease.snapshot,
      config,
      workspaceDir,
      pluginRegistry,
      metadataSnapshot: admittedMetadataSnapshot,
    } as NonNullable<ReturnType<typeof getPreparedModelRuntimeBorrowedSnapshot>>;
    let publishedMetadataSnapshot = admittedMetadataSnapshot;
    const release = vi.fn(async () => {});
    let servedMetadataSnapshot: unknown;
    let publishedMetadataAtAcquire: unknown;
    mockedAcquireAgentRunPreparedModelRuntime.mockClear();
    mockedAcquireAgentRunPreparedModelRuntime.mockImplementationOnce(
      async (
        _input,
        options?: {
          pluginGeneration?: PreparedModelRuntimePluginGeneration;
        },
      ) => {
        const generation = options?.pluginGeneration;
        const borrowed = generation
          ? getPreparedModelRuntimeBorrowedSnapshot(generation)
          : undefined;
        if (!borrowed) {
          throw new Error("prepared model runtime plugin generation was superseded");
        }
        publishedMetadataAtAcquire = publishedMetadataSnapshot;
        servedMetadataSnapshot = borrowed.metadataSnapshot;
        return {
          ...baseLease,
          snapshot: borrowed as typeof baseLease.snapshot,
          [Symbol.asyncDispose]: release,
        };
      },
    );
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "ok" }]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["ok"] }));
    useOpenAIPlatformAuthFixture();
    publishedMetadataSnapshot = replacementMetadataSnapshot;

    const result = await withPreparedModelRuntimePluginGenerationScope(
      admittedGeneration,
      async () =>
        await runEmbeddedAgent({
          ...createOverflowRunParams(state),
          config,
          provider: "openai",
          model: "gpt-5.4",
          runId: "admitted-generation-replacement",
          sessionKey: undefined,
        }),
      () => admittedSnapshot,
    );

    expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ config, workspaceDir }),
      expect.objectContaining({ pluginGeneration: admittedGeneration }),
    );
    expect(publishedMetadataAtAcquire).toBe(replacementMetadataSnapshot);
    expect(servedMetadataSnapshot).toBe(admittedGeneration.pluginMetadataSnapshot);
    expect(result.payloads).toEqual([{ text: "ok" }]);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(["complete", "parent abort", "queue timeout"] as const)(
    "starts an isolated probe outside its caller's admitted generation (%s)",
    async (outcome) => {
      const { runEmbeddedAgent, state } = await loadSourceDeliveryHarness();
      const config = {};
      const workspaceDir = state.workspaceDir;
      const baseLease = await mockedAcquireAgentRunPreparedModelRuntime({
        agentId: "openclaw",
        agentDir: state.agentDir("openclaw"),
        workspaceDir,
      });
      const admittedGeneration: PreparedModelRuntimePluginGeneration = {
        configuredCatalogEntries: [],
        inlineProviderModels: [],
        pluginMetadataSnapshot: {
          ...baseLease.snapshot.metadataSnapshot,
          policyHash: "admitted",
          workspaceDir,
        },
        pluginRegistry: createEmptyPluginRegistry(),
      };
      const isolatedMetadataSnapshot = {
        ...baseLease.snapshot.metadataSnapshot,
        policyHash: "isolated",
        workspaceDir,
      };
      const release = vi.fn(async () => {});
      const acquisitionStarted = createDeferred();
      const resumeAcquisition = createDeferred();
      const queueTimeout = createDeferred<never>();
      const queuedTasks: Promise<unknown>[] = [];
      let acquisitionSignal: AbortSignal | undefined;
      mockedAcquireAgentRunPreparedModelRuntime.mockClear();
      mockedAcquireAgentRunPreparedModelRuntime.mockImplementationOnce(
        async (_input, options?: PreparedModelRuntimeLeaseOptions) => {
          const signal = options?.abortSignal;
          acquisitionSignal = signal;
          acquisitionStarted.resolve();
          await resumeAcquisition.promise;
          signal?.throwIfAborted();
          return {
            ...baseLease,
            snapshot: {
              ...baseLease.snapshot,
              config,
              workspaceDir,
              metadataSnapshot: isolatedMetadataSnapshot,
            },
            [Symbol.asyncDispose]: release,
          };
        },
      );
      mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "ok" }]);
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["ok"] }));
      useOpenAIPlatformAuthFixture();
      const parentAbort = new AbortController();

      const isolatedProbeParams: RunEmbeddedAgentInternalParams = {
        ...createOverflowRunParams(state),
        agentId: "openclaw",
        agentDir: state.agentDir("openclaw"),
        config,
        provider: "openai",
        model: "gpt-5.4",
        preparedModelRuntimeMode: "isolated-read-only",
        runId: "isolated-probe-generation",
        sessionKey: undefined,
        abortSignal: parentAbort.signal,
        workspaceDir,
        enqueue:
          outcome === "queue timeout"
            ? async (task, options) => {
                const pending = task();
                queuedTasks.push(pending);
                // Reject the global queue while its acquisition callback still owns work.
                return options?.taskTimeoutAbortSignal
                  ? await Promise.race([pending, queueTimeout.promise])
                  : await pending;
              }
            : undefined,
      };
      const run = withPreparedModelRuntimePluginGenerationScope(
        admittedGeneration,
        async () => await runEmbeddedAgent(isolatedProbeParams),
      );
      const observed = run.catch(() => undefined);
      try {
        await Promise.race([acquisitionStarted.promise, run]);
        expect(acquisitionSignal?.aborted).toBe(false);
        expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
        expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ config, loadRuntimePlugins: true, workspaceDir }),
          { abortSignal: acquisitionSignal, catalogMode: "static" },
        );

        if (outcome === "complete") {
          resumeAcquisition.resolve();
          expect((await run).payloads).toEqual([{ text: "ok" }]);
          expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
          expect(release).toHaveBeenCalledOnce();
        } else {
          const reason = new Error(`isolated probe: ${outcome}`);
          if (outcome === "parent abort") {
            parentAbort.abort(reason);
          } else {
            reason.name = "CommandLaneTaskTimeoutError";
            queueTimeout.reject(reason);
            await observed;
          }
          expect(acquisitionSignal?.aborted).toBe(true);
          expect(acquisitionSignal?.reason).toBe(reason);
          expect(parentAbort.signal.aborted).toBe(outcome === "parent abort");
          resumeAcquisition.resolve();
          await expect(run).rejects.toBe(reason);
          await Promise.allSettled(queuedTasks);
          expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
          expect(release).not.toHaveBeenCalled();
        }
      } finally {
        resumeAcquisition.resolve();
        await observed;
        // Queue rejection can precede callback cleanup; join it before fixture disposal.
        await Promise.allSettled(queuedTasks);
      }
    },
  );
}
