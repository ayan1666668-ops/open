import type { SessionExecutionSelection } from "../../model-picker/execution-selection.js";

/** A rollback request records its previous accepted/deferred intent, never another active selector. */
export type AgentPatchedSessionModelFallback = {
  previous: SessionExecutionSelection;
  /** Observed route at snapshot time, retained for released SDK readback only. */
  prevModel: string;
  prevProvider: string;
  prevAuthProfileOverride?: string;
  prevAuthProfileOverrideSource?: "auto" | "user" | "user-link";
  prevAuthProfileOverrideCompactionCount?: number;
  prevContextWindow?: string;
  prevThinkingLevel?: string;
  lastValidatedPatchTs?: number;
  ts: number;
  source: "agent-patch";
};
