/**
 * Subagent spawn planning helpers.
 *
 * Resolves model, thinking, and timeout choices before the sessions_spawn executor launches work.
 */
import { formatThinkingLevels } from "../../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ExecutionSelectionRequest } from "../../../model-picker/apply-session-model-selection.js";
import type { FastMode } from "../../../shared/fast-mode.js";
import { splitTrailingAuthProfile } from "../../model-ref-profile.js";
import { type ModelRef, resolveDefaultModelForAgent, resolveSubagentSpawnModelSelection } from "../../model-selection.js";
import { resolveSubagentThinkingOverride } from "./subagent-spawn-thinking.js";

/** Splits a provider/model ref while preserving model-only refs. */
export function splitModelRef(ref?: string) {
  if (!ref) {
    return { provider: undefined, model: undefined };
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return { provider: undefined, model: undefined };
  }
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    const provider = trimmed.slice(0, slash);
    const model = trimmed.slice(slash + 1);
    return { provider, model };
  }
  const provider = undefined;
  const model = trimmed;
  if (model) {
    return { provider, model };
  }
  return { provider: undefined, model: trimmed };
}

/** Resolves the effective subagent run timeout from per-call override or config default. */
export function resolveConfiguredSubagentRunTimeoutSeconds(params: {
  cfg: OpenClawConfig;
  runTimeoutSeconds?: number;
}) {
  const cfgSubagentTimeout =
    typeof params.cfg?.agents?.defaults?.subagents?.runTimeoutSeconds === "number" &&
    Number.isFinite(params.cfg.agents.defaults.subagents.runTimeoutSeconds)
      ? Math.max(0, Math.floor(params.cfg.agents.defaults.subagents.runTimeoutSeconds))
      : 0;
  return typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
    ? Math.max(0, Math.floor(params.runTimeoutSeconds))
    : cfgSubagentTimeout;
}

/** Resolves the subagent model plus thinking patch to apply to the spawned session. */
export function resolveSubagentModelAndThinkingPlan(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  requesterAgentConfig?: unknown;
  targetAgentConfig?: unknown;
  modelOverride?: string;
  thinkingOverrideRaw?: string;
  callerThinkingRaw?: string;
  inheritedModel?: ModelRef;
  fastMode?: FastMode;
}) {
  const { model: rawResolvedModel, resolvedModel: inheritedModel } =
    resolveSubagentSpawnModelSelection({
      cfg: params.cfg,
      agentId: params.targetAgentId,
      modelOverride: params.modelOverride,
      inheritedModel: params.inheritedModel,
    });
  const { model: resolvedModel, profile: authProfileId } =
    splitTrailingAuthProfile(rawResolvedModel);

  const thinkingPlan = resolveSubagentThinkingOverride({
    cfg: params.cfg,
    requesterAgentConfig: params.requesterAgentConfig,
    targetAgentConfig: params.targetAgentConfig,
    thinkingOverrideRaw: params.thinkingOverrideRaw,
    callerThinkingRaw: params.callerThinkingRaw,
  });
  if (thinkingPlan.status === "error") {
    const { provider, model } = splitModelRef(resolvedModel);
    // The hint is provider/model-specific because valid thinking levels vary by backend.
    const hint = formatThinkingLevels(provider, model);
    return {
      status: "error" as const,
      resolvedModel,
      error: `Invalid thinking level "${thinkingPlan.thinkingCandidateRaw}". Use one of: ${hint}.`,
    };
  }

  const ref = splitModelRef(resolvedModel);
  const selectedModel = ref.model
    ? {
        provider:
          ref.provider ??
          resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.targetAgentId }).provider,
        id: ref.model,
      }
    : undefined;
  const executionRequest: ExecutionSelectionRequest =
    params.modelOverride?.trim() && selectedModel
      ? { kind: "model", model: selectedModel }
      : { kind: "initialize", ...(selectedModel ? { model: selectedModel } : {}) };
  return {
    status: "ok" as const,
    resolvedModel,
    ...(inheritedModel ? { inheritedModel } : {}),
    executionRequest,
    modelApplied: Boolean(resolvedModel),
    thinkingOverride: thinkingPlan.thinkingOverride,
    initialSessionPatch: {
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(authProfileId
        ? {
            authProfileOverride: authProfileId,
            authProfileOverrideSource: "user" as const,
          }
        : {}),
      ...thinkingPlan.initialSessionPatch,
      ...(params.fastMode !== undefined ? { fastMode: params.fastMode } : {}),
    },
  };
}
