import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecutionSelectionCodecMetadata } from "./execution-selection-codec.js";
import { executionSelectionCodecMetadata } from "./execution-selection-state.js";
import type { ModelExecutionSelection } from "./execution-selection.js";

/** Configured policy and loaded metadata choose identity; readiness is evaluated separately. */
export function resolveConfiguredExecutionSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  model: ModelExecutionSelection["model"];
  modelCatalog?: readonly ModelCatalogEntry[];
  metadata?: ExecutionSelectionCodecMetadata;
}): ModelExecutionSelection | undefined {
  const entry = params.modelCatalog?.find(
    (entry) => entry.provider === params.model.provider && entry.id === params.model.id,
  );
  const id = resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    provider: params.model.provider,
    modelId: params.model.id,
    modelApi: entry?.api,
    modelBaseUrl: entry?.baseUrl,
  });
  const kind = (params.metadata ?? executionSelectionCodecMetadata(params.cfg)).classifyExecutor(
    id,
  );
  return kind ? { model: params.model, executor: { kind, id } } : undefined;
}
