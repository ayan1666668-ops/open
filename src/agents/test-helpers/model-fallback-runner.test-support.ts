import type { FailoverReason } from "../failover/signal.js";
import type { ModelFallbackRunOptions } from "../model-fallback-attempt.js";
import { resolveModelCandidateChain } from "../model-fallback-candidates.js";
import type { runWithModelFallback } from "../model-fallback-runner.js";

export type TestModelFallbackRunnerParams<T = unknown> = {
  provider: string;
  model: string;
  run: (provider: string, model: string, options: ModelFallbackRunOptions) => Promise<T>;
};

export function initialModelFallbackAttemptOptions(
  params: Pick<TestModelFallbackRunnerParams, "provider" | "model">,
): ModelFallbackRunOptions {
  return {
    modelRoutingProvenance: {
      requestedProvider: params.provider,
      requestedModel: params.model,
      stage: "initial",
    },
  };
}

export function fallbackModelAttemptOptions(
  params: Pick<TestModelFallbackRunnerParams, "provider" | "model">,
  fallbackReason: FailoverReason,
): ModelFallbackRunOptions {
  return {
    modelRoutingProvenance: {
      requestedProvider: params.provider,
      requestedModel: params.model,
      stage: "fallback",
      fallbackReason,
    },
  };
}

export function runInitialModelFallbackAttempt<T>(
  params: TestModelFallbackRunnerParams<T>,
  provider = params.provider,
  model = params.model,
): Promise<T> {
  return params.run(provider, model, initialModelFallbackAttemptOptions(params));
}

export function runFallbackModelAttempt<T>(
  params: TestModelFallbackRunnerParams<T>,
  provider: string,
  model: string,
  fallbackReason: FailoverReason,
): Promise<T> {
  return params.run(provider, model, fallbackModelAttemptOptions(params, fallbackReason));
}

/** Preserve run-entry preparation while a test scripts the fallback loop's result. */
export async function withModelFallbackPreparation<T, Result>(
  params: Parameters<typeof runWithModelFallback<T>>[0],
  run: (prepared: Parameters<typeof runWithModelFallback<T>>[0]) => Promise<Result>,
): Promise<Result> {
  await params.prepareCandidateChain?.(resolveModelCandidateChain(params));
  return run({
    ...params,
    run: async (provider, model, options) => {
      await params.prepareCandidate?.(provider, model);
      await params.prepareAgentHarnessRuntime?.({
        provider,
        model,
        agentHarnessRuntimeOverride: params.resolveAgentHarnessRuntimeOverride?.(provider, model),
      });
      return params.run(provider, model, options);
    },
  });
}
export function makeCompletedFallbackRunner(
  overrides: {
    provider?: string;
    model?: string;
    attempts?: Awaited<ReturnType<typeof runWithModelFallback<unknown>>>["attempts"];
  } = {},
) {
  const provider = overrides.provider ?? "openai";
  const model = overrides.model ?? "gpt-5.5";
  const attempts = overrides.attempts ?? [
    {
      provider: "lmstudio",
      model: "gemma-4-e4b-it",
      error: "Connection error.",
      reason: "timeout",
    },
  ];
  return async <T>(params: Parameters<typeof runWithModelFallback<T>>[0]) => ({
    outcome: "completed" as const,
    result: await runFallbackModelAttempt(
      params,
      provider,
      model,
      attempts.at(-1)?.reason ?? "unknown",
    ),
    provider,
    model,
    attempts,
  });
}
