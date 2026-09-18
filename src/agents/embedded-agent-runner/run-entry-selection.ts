import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngineHostSupport } from "../../context-engine/host-compat.js";
import type { ModelExecutionSelection } from "../../model-picker/execution-selection.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";
import type { AssistantErrorTranscript } from "../assistant-error-transcript.js";
import type { ContextEngineLogicalTurnLease } from "../harness/context-engine-logical-turn.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import { selectAgentHarness } from "../harness/selection.js";
import { modelKey } from "../model-ref-shared.js";

type PreparedRunEntrySelection = {
  selection: ModelExecutionSelection;
  validateCommit: () => string | undefined;
};

export type RunEntryHarnessSelectionPreparation = {
  workspaceDir: string;
  sessionKey?: string;
  preparation:
    | { kind: "direct" }
    | { kind: "measured"; run: (prepare: () => Promise<void>) => Promise<void> };
  prepareExecutionSelection: (
    provider: string,
    model: string,
  ) => Promise<PreparedRunEntrySelection>;
  resolveContextEngineHost?: (
    selection: ModelExecutionSelection,
  ) => ContextEngineHostSupport | undefined;
};

export function createRunEntrySelectionPreparation(params: {
  config: OpenClawConfig;
  agentId: string;
  harness: RunEntryHarnessSelectionPreparation;
  lease: ContextEngineLogicalTurnLease;
  assistantErrorTranscript: AssistantErrorTranscript;
}) {
  const { harness, lease, assistantErrorTranscript } = params;
  const preparedSelections = new Map<string, PreparedRunEntrySelection | Error>();
  const preparedHarnessRuntimes = new Set<string>();
  const readPreparedSelection = (provider: string, model: string): PreparedRunEntrySelection => {
    const prepared = preparedSelections.get(modelKey(provider, model));
    if (!prepared) {
      throw new Error("Execution selection was not prepared before dispatch.");
    }
    if (prepared instanceof Error) {
      throw prepared;
    }
    return prepared;
  };
  const validatePreparedSelection = (provider: string, model: string): ModelExecutionSelection => {
    const prepared = readPreparedSelection(provider, model);
    const error = prepared.validateCommit();
    if (error) {
      throw new Error(error);
    }
    return prepared.selection;
  };
  const prepareHarnessRuntime = async (candidate: { provider: string; model: string }) => {
    assistantErrorTranscript.clear();
    const { executor } = validatePreparedSelection(candidate.provider, candidate.model);
    if (executor.kind !== "harness") {
      return;
    }
    const key = [candidate.provider, candidate.model, executor.id].join("\0");
    if (preparedHarnessRuntimes.has(key)) {
      return;
    }
    const prepare = () =>
      ensureSelectedAgentHarnessPlugin({
        config: params.config,
        provider: candidate.provider,
        modelId: candidate.model,
        agentId: params.agentId,
        sessionKey: harness.sessionKey,
        agentHarnessId: executor.id,
        agentHarnessRuntimeOverride: executor.id,
        workspaceDir: harness.workspaceDir,
        pluginRegistry: requireActivePluginRegistry(),
      });
    if (harness.preparation.kind === "measured") {
      await harness.preparation.run(prepare);
    } else {
      await prepare();
    }
    preparedHarnessRuntimes.add(key);
  };
  const prepareCandidateChain = async (
    candidates: readonly { provider: string; model: string }[],
  ) => {
    for (const candidate of candidates) {
      try {
        const prepared = await harness.prepareExecutionSelection(
          candidate.provider,
          candidate.model,
        );
        preparedSelections.set(modelKey(candidate.provider, candidate.model), prepared);
      } catch (error) {
        preparedSelections.set(
          modelKey(candidate.provider, candidate.model),
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    for (const candidate of candidates) {
      try {
        const preparedSelection = readPreparedSelection(
          candidate.provider,
          candidate.model,
        ).selection;
        const agentHarnessRuntimeOverride = preparedSelection.executor.id;
        await prepareHarnessRuntime({
          provider: candidate.provider,
          model: candidate.model,
        });
        const resolvedHost = harness.resolveContextEngineHost?.(preparedSelection);
        const host =
          resolvedHost ??
          (() => {
            const selectedHarness = selectAgentHarness({
              provider: candidate.provider,
              modelId: candidate.model,
              config: params.config,
              agentId: params.agentId,
              sessionKey: harness.sessionKey,
              agentHarnessRuntimeOverride,
            });
            return {
              id: `agent-harness:${selectedHarness.id}`,
              label: `agent harness "${selectedHarness.id}"`,
              capabilities: selectedHarness.contextEngineHostCapabilities ?? [],
            };
          })();
        lease.selectForHost({ host, operation: "agent-run", requiresDurableCommit: false });
      } catch {
        lease.degradeBeforeStart(
          "a model fallback candidate harness could not be validated before dispatch",
        );
        return;
      }
    }
  };
  return {
    readPreparedSelection,
    validatePreparedSelection,
    prepareHarnessRuntime,
    prepareCandidateChain,
  };
}
