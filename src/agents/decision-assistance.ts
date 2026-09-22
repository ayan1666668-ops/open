import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope-config.js";

/** Shared Labs eligibility for experimental Decision-assisted consumers. */
export function isDecisionAssistanceEnabled(config: OpenClawConfig, agentId?: string): boolean {
  const resolvedExperimental = agentId
    ? (resolveAgentConfig(config, agentId)?.experimental ?? config.agents?.defaults?.experimental)
    : config.agents?.defaults?.experimental;
  return resolvedExperimental?.decisionAssistance ?? false;
}
