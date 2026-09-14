import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { normalizeAgentRunTerminalReplySnapshot } from "../../agents/agent-run-terminal-reply.js";
import { formatErrorMessageForDisplay } from "../../infra/error-diagnostics.js";
import { isNonTerminalAgentRunStatus } from "../../shared/agent-run-status.js";
import type { DedupeEntry } from "../server-shared.js";
import type { AgentJobTerminalSnapshot } from "./agent-job-durable-terminal.js";

export type DedupeObservation =
  | { state: "active" }
  | { state: "terminal"; snapshot: AgentJobTerminalSnapshot }
  | { state: "untracked" };

export function parseDedupeObservation(entry: DedupeEntry): DedupeObservation {
  // SAFETY: dedupe payloads are JSON-like records by DedupeEntry contract; every field is rechecked below.
  const payload = entry.payload as
    | {
        status?: unknown;
        startedAt?: unknown;
        endedAt?: unknown;
        error?: unknown;
        summary?: unknown;
        stopReason?: unknown;
        livenessState?: unknown;
        yielded?: unknown;
        timeoutPhase?: unknown;
        providerStarted?: unknown;
        result?: unknown;
        terminalReply?: unknown;
      }
    | undefined;
  const status = typeof payload?.status === "string" ? payload.status : undefined;
  if (isNonTerminalAgentRunStatus(status)) {
    return { state: "active" };
  }

  const terminalStatus =
    status === "ok" || status === "timeout" || status === "error"
      ? status
      : entry.ok
        ? undefined
        : "error";
  if (!terminalStatus) {
    return { state: "untracked" };
  }

  const resultMeta = asOptionalRecord(asOptionalRecord(payload?.result)?.meta);
  const terminalReply = normalizeAgentRunTerminalReplySnapshot(
    payload?.terminalReply ?? resultMeta?.terminalReply,
  );
  const startedAt = asFiniteNumber(payload?.startedAt);
  const endedAt = asFiniteNumber(payload?.endedAt) ?? entry.ts;
  const stopReason =
    readNonBlankString(payload?.stopReason) ?? readNonBlankString(resultMeta?.stopReason);
  const livenessState =
    readNonBlankString(payload?.livenessState) ?? readNonBlankString(resultMeta?.livenessState);
  const errorMessage =
    typeof payload?.error === "string"
      ? payload.error
      : typeof payload?.summary === "string"
        ? payload.summary
        : entry.error?.message;
  const terminalOutcome = buildAgentRunTerminalOutcome({
    status: terminalStatus,
    startedAt,
    endedAt,
    // RPC errors stay native for retry policy; agent.wait is an operator-facing projection.
    error:
      errorMessage === undefined
        ? undefined
        : formatErrorMessageForDisplay(entry.error, errorMessage),
    stopReason,
    livenessState,
    timeoutPhase: payload?.timeoutPhase ?? resultMeta?.timeoutPhase,
    providerStarted: payload?.providerStarted ?? resultMeta?.providerStarted,
  });
  return {
    state: "terminal",
    snapshot: {
      status: terminalOutcome.status,
      startedAt,
      endedAt,
      error: terminalOutcome.status === "ok" ? undefined : terminalOutcome.error,
      stopReason,
      livenessState,
      ...(payload?.yielded === true || resultMeta?.yielded === true ? { yielded: true } : {}),
      ...(terminalOutcome.timeoutPhase ? { timeoutPhase: terminalOutcome.timeoutPhase } : {}),
      ...(terminalOutcome.providerStarted !== undefined
        ? { providerStarted: terminalOutcome.providerStarted }
        : {}),
      ...(terminalReply ? { terminalReply } : {}),
    },
  };
}

export function parseDedupeKey(
  key: string,
): { runId: string; source: "agent" | "chat" } | undefined {
  const separator = key.indexOf(":");
  if (separator === -1) {
    return undefined;
  }
  const source = key.slice(0, separator);
  const runId = key.slice(separator + 1);
  if ((source !== "agent" && source !== "chat") || !runId) {
    return undefined;
  }
  return { runId, source };
}
