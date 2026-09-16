import type { SessionExecutionSelection } from "../../model-picker/execution-selection.js";
import type { SessionEntry } from "./types.js";

/** A rollback request records its previous accepted/deferred intent, never another active selector. */
export type AgentPatchedSessionModelFallback = {
  previous: SessionExecutionSelection;
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
  entry: Partial<SessionEntry>;
  ts: number;
}): AgentPatchedSessionModelFallback {
  const { entry } = params;
  return {
    previous: entry.executionSelection
      ? structuredClone(entry.executionSelection)
      : {
          state: "deferred",
          request: { model: { provider: params.provider, id: params.model } },
          fallbackPermission: "configured",
        },
    prevAuthProfileOverride: entry.authProfileOverride,
    prevAuthProfileOverrideSource: entry.authProfileOverrideSource,
    prevAuthProfileOverrideCompactionCount: entry.authProfileOverrideCompactionCount,
    prevContextWindow: entry.contextWindow,
    prevThinkingLevel: entry.thinkingLevel,
    ts: params.ts,
    source: "agent-patch",
  };
}
