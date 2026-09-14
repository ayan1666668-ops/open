import {
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agent-run-terminal-outcome.js";
import type { AgentRunDisposition } from "../internal-event-contract.js";
import { isAbortedAgentStopReason } from "../run-termination.js";

/**
 * Which of the two events a `timeout` outcome actually records.
 *
 * `child-stopped` — the gateway reported the child run itself settled, so the
 * outcome is terminal and its timing describes the child.
 * `child-unconfirmed` — only a deadline elapsed (this waiter's budget, or the
 * stored run deadline). No stop was observed, so the child may still be
 * running and the outcome describes the end of the WAIT, not of the run.
 */
type SubagentTimeoutDisposition = "child-stopped" | "child-unconfirmed";

export type SubagentRunOutcome = {
  status: "ok" | "error" | "timeout" | "unknown";
  /**
   * Written only by producers that observed something other than the run
   * publishing its own terminal state: a waiter whose budget expired while the
   * run stayed live, or a kill. Absence therefore means `exited`; read it
   * through `resolveSubagentRunDisposition` rather than defaulting inline.
   */
  disposition?: AgentRunDisposition;
  error?: string;
  /** Legacy persisted timeout evidence. New outcomes write `disposition` only. */
  timeoutDisposition?: SubagentTimeoutDisposition;
  startedAt?: number;
  endedAt?: number;
  elapsedMs?: number;
};

/** Subagents apply explicit cancellation ownership after canonical timeout attribution. */
export function classifySubagentTerminalOutcome(outcome: AgentRunTerminalOutcome) {
  const classification = classifyAgentRunTerminalOutcome(outcome);
  return classification === "timeout" || !isAbortedAgentStopReason(outcome.stopReason)
    ? classification
    : "cancellation";
}

/** Read legacy wait evidence through the same public disposition as new outcomes. */
export function resolveSubagentRunDisposition(
  outcome: SubagentRunOutcome | undefined,
): AgentRunDisposition {
  if (outcome?.disposition) {
    return outcome.disposition;
  }
  if (outcome?.status === "timeout" && outcome.timeoutDisposition) {
    return outcome.timeoutDisposition === "child-unconfirmed" ? "still-running" : "exited";
  }
  return "exited";
}
