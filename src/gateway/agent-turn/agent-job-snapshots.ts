import {
  buildAgentRunTerminalOutcome,
  mergeAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import { mergeAgentRunTerminalReplySnapshot } from "../../agents/agent-run-terminal-reply.js";
import type {
  AgentJobTerminalSnapshot,
  AgentRunObservation,
  AgentRunSnapshot,
} from "./agent-job-durable-terminal.js";

export function terminalOutcomeFromAgentJobSnapshot(
  snapshot: AgentJobTerminalSnapshot,
): AgentRunTerminalOutcome | undefined {
  if (snapshot.pendingError) {
    return undefined;
  }
  return buildAgentRunTerminalOutcome(snapshot);
}

export function shouldPreserveAgentJobTerminalSnapshot(
  existing: AgentJobTerminalSnapshot,
  incoming: AgentJobTerminalSnapshot,
): boolean {
  const existingOutcome = terminalOutcomeFromAgentJobSnapshot(existing);
  const incomingOutcome = terminalOutcomeFromAgentJobSnapshot(incoming);
  if (!existingOutcome || !incomingOutcome) {
    return false;
  }
  return mergeAgentRunTerminalOutcome(existingOutcome, incomingOutcome) === existingOutcome;
}

export function mergeAgentJobSnapshot(
  existing: AgentRunSnapshot | undefined,
  incoming: AgentRunSnapshot,
): AgentRunSnapshot {
  if (!existing) {
    return incoming;
  }
  const terminalReply = mergeAgentRunTerminalReplySnapshot(
    existing.terminalReply,
    incoming.terminalReply,
  );
  const terminalDelivery = incoming.terminalDelivery ?? existing.terminalDelivery;
  const terminalReceipt = incoming.terminalReceipt ?? existing.terminalReceipt;
  const existingOutcome = terminalOutcomeFromAgentJobSnapshot(existing);
  const incomingOutcome = terminalOutcomeFromAgentJobSnapshot(incoming);
  const preservesProvisionalFailure =
    existing.executionSettled !== true &&
    incoming.executionSettled === true &&
    existingOutcome !== undefined &&
    existingOutcome.status !== "ok" &&
    incomingOutcome?.reason === "completed";
  const incomingSettlesAfterProvisional =
    existing.executionSettled !== true && incoming.executionSettled === true;
  const canonical =
    existing.executionSettled === true ||
    (incomingSettlesAfterProvisional
      ? preservesProvisionalFailure
      : shouldPreserveAgentJobTerminalSnapshot(existing, incoming))
      ? existing
      : incoming;
  // Terminal status, execution settlement, and producer evidence are independent.
  return {
    ...canonical,
    executionSettled: existing.executionSettled === true || incoming.executionSettled === true,
    ...(terminalDelivery ? { terminalDelivery } : {}),
    ...(terminalReceipt ? { terminalReceipt } : {}),
    ...(terminalReply ? { terminalReply } : {}),
    cachedAt: incoming.cachedAt,
    recordedAt: incoming.recordedAt,
    version: incoming.version,
  };
}

export function toPublicAgentJobSnapshot(snapshot: AgentRunObservation): AgentJobTerminalSnapshot {
  return {
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
    error: snapshot.error,
    stopReason: snapshot.stopReason,
    livenessState: snapshot.livenessState,
    yielded: snapshot.yielded,
    pendingError: snapshot.pendingError,
    timeoutPhase: snapshot.timeoutPhase,
    providerStarted: snapshot.providerStarted,
    ...(snapshot.terminalDelivery ? { terminalDelivery: snapshot.terminalDelivery } : {}),
    terminalReceipt: snapshot.terminalReceipt,
    terminalReply: snapshot.terminalReply,
  };
}
