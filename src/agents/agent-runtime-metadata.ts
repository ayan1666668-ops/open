/** Resolves agent runtime metadata from model/provider policy and ACP session overlays. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getSessionExecutionSelection } from "../model-picker/execution-selection.js";
import { applyAcpRuntimeOverlay, type AgentRuntimeMetadata } from "./acp-runtime-overlay.js";
import { isDefaultAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveAvailableAgentHarnessPolicy } from "./harness/availability.js";
import type { AgentRuntimePolicyScope } from "./model-runtime-policy.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import { resolveAcceptedSessionRuntimeId } from "./session-runtime-compat.js";

type ModelAgentRuntimeMetadataParams = {
  cfg: OpenClawConfig;
  provider?: string;
  model?: string;
  sessionKey?: string;
  sessionEntry?: Parameters<typeof resolveAcceptedSessionRuntimeId>[0];
  /** True only when persisted ACP metadata owns the session. */
  acpRuntime?: boolean;
  /** Persisted ACP backend id, falling back to acpx when absent. */
  acpBackend?: string;
  agentHarnessRuntimeOverride?: string;
} & (
  | { agentId: string; agentScope?: never }
  | Extract<AgentRuntimePolicyScope, { agentScope: unknown }>
);

/** Resolves the runtime id/source that should be reported for a model-backed agent session. */
export function resolveModelAgentRuntimeMetadata(
  params: ModelAgentRuntimeMetadataParams,
): AgentRuntimeMetadata {
  const persistedRuntimeId = resolveAcceptedSessionRuntimeId(params.sessionEntry);
  if (persistedRuntimeId && !isDefaultAgentRuntimeId(persistedRuntimeId)) {
    return applyAcpRuntimeOverlay(
      { id: persistedRuntimeId, source: "session" },
      params.sessionKey,
      params.acpRuntime,
      params.acpBackend,
    );
  }
  const agentId = params.agentScope ? params.agentScope.agentId : params.agentId;
  const resolved =
    params.provider && params.model
      ? { provider: params.provider, model: params.model }
      : resolveDefaultModelForAgent({ cfg: params.cfg, agentId });
  const policy = resolveAvailableAgentHarnessPolicy({
    ...params,
    mode: "projection",
    provider: resolved.provider,
    modelId: resolved.model,
    config: params.cfg,
    sessionKey: params.sessionKey,
    agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
  });
  const meta: AgentRuntimeMetadata = {
    id: policy.runtime,
    source: policy.runtimeSource ?? "implicit",
  };
  return applyAcpRuntimeOverlay(meta, params.sessionKey, params.acpRuntime, params.acpBackend);
}

/** Resolves the runtime selected for the next turn, excluding historical producer metadata. */
export function resolveCurrentSessionAgentRuntimeMetadata(
  params: ModelAgentRuntimeMetadataParams,
): AgentRuntimeMetadata {
  const { sessionEntry, ...configuredParams } = params;
  const selection = getSessionExecutionSelection(sessionEntry);
  if (selection) {
    return applyAcpRuntimeOverlay(
      {
        id: selection.executor.kind === "acp" ? selection.executor.backend : selection.executor.id,
        source: "session",
      },
      params.sessionKey,
      selection.executor.kind === "acp",
      selection.executor.kind === "acp" ? selection.executor.backend : undefined,
    );
  }
  return resolveModelAgentRuntimeMetadata(configuredParams);
}
