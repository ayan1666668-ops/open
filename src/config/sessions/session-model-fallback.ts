import { captureSessionModelFallback } from "../../model-picker/execution-selection-codec.js";
export type AgentPatchedSessionModelFallback = {
  prevModel: string;
  prevProvider: string;
  prevModelOverride?: string;
  prevProviderOverride?: string;
  prevModelOverrideSource?: "auto" | "user" | "default";
  prevModelOverrideRouteResolution?: "resolved";
  prevModelOverrideFallbackOriginProvider?: string;
  prevModelOverrideFallbackOriginModel?: string;
  prevAuthProfileOverride?: string;
  prevAuthProfileOverrideSource?: "auto" | "user" | "user-link";
  prevAuthProfileOverrideCompactionCount?: number;
  prevContextWindow?: string;
  prevThinkingLevel?: string;
  lastValidatedPatchTs?: number;
  ts: number;
  source: "agent-patch";
};

export function createAgentPatchedSessionModelFallback(params: {
  model: string;
  provider: string;
  entry: {
    modelOverride?: string;
    providerOverride?: string;
    modelOverrideSource?: "auto" | "user" | "default";
    modelOverrideRouteResolution?: "resolved";
    modelOverrideFallbackOriginProvider?: string;
    modelOverrideFallbackOriginModel?: string;
    authProfileOverride?: string;
    authProfileOverrideSource?: "auto" | "user" | "user-link";
    authProfileOverrideCompactionCount?: number;
    contextWindow?: string;
    thinkingLevel?: string;
  };
  ts: number;
}): AgentPatchedSessionModelFallback {
  return captureSessionModelFallback(params);
}
