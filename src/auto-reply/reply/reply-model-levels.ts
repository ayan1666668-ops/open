/** Resolves thinking and reasoning together when a command or model turn consumes them. */
import { createLazyPromise } from "../../shared/lazy-promise.js";
import type { ReasoningLevel, ThinkLevel } from "../thinking.js";
import type { ModelSelectionState } from "./model-selection.js";

type ReplyModelLevelSelection = {
  provider: string;
  model: string;
  agentRuntime?: string | null;
  thinkLevel?: ThinkLevel;
  thinkingExplicit: boolean;
  reasoningLevel: ReasoningLevel;
  reasoningExplicit: boolean;
};

type ReplyModelLevels = {
  resolvedThinkLevel: ThinkLevel | undefined;
  resolvedReasoningLevel: ReasoningLevel;
};

export type ReplyModelLevelResolver = (
  preparedModelState?: ModelSelectionState,
) => Promise<ReplyModelLevels>;

export function createReplyModelLevelResolver(params: {
  selection: ReplyModelLevelSelection;
  modelState: Pick<
    ModelSelectionState,
    "resolveDefaultThinkingLevel" | "resolveDefaultReasoningLevel" | "hasConfiguredThinkingDefault"
  >;
}): ReplyModelLevelResolver {
  const resolve = async (
    modelState: typeof params.modelState,
    selection: ReplyModelLevelSelection,
  ): Promise<ReplyModelLevels> => {
    const { provider, model, agentRuntime } = selection;
    const resolvedThinkLevel =
      selection.thinkLevel ??
      (await modelState.resolveDefaultThinkingLevel({ provider, model, agentRuntime }));
    const resolvedReasoningLevel =
      !selection.reasoningExplicit &&
      selection.reasoningLevel === "off" &&
      resolvedThinkLevel === "off" &&
      !selection.thinkingExplicit &&
      !modelState.hasConfiguredThinkingDefault
        ? await modelState.resolveDefaultReasoningLevel({ provider, model })
        : selection.reasoningLevel;
    return { resolvedThinkLevel, resolvedReasoningLevel };
  };
  const resolveMetadata = createLazyPromise(() => resolve(params.modelState, params.selection), {
    cacheRejections: true,
  });
  return (preparedModelState) => {
    if (!preparedModelState) {
      return resolveMetadata();
    }
    const executor = preparedModelState.executionSelection?.executor;
    return resolve(preparedModelState, {
      ...params.selection,
      provider: preparedModelState.provider,
      model: preparedModelState.model,
      agentRuntime: executor?.kind === "acp" ? undefined : executor?.id,
    });
  };
}
