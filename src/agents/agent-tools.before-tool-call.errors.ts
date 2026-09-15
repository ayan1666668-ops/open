/**
 * Closed before_tool_call failure types and vetoed tool results.
 */
import { resolveToolErrorDiagnostic } from "./agent-tools.before-tool-call.diagnostics.js";
import { recordPreExecutionBlockedToolCall } from "./agent-tools.before-tool-call.state.js";
import type {
  BeforeToolCallFailureDisposition,
  HookBlockedReason,
} from "./agent-tools.before-tool-call.types.js";
import {
  formatToolExecutionErrorMessage,
  isTrustedToolExecutionPreflightError,
  registerTrustedToolNoStartError,
} from "./tool-result-error.js";

class BeforeToolCallBlockedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "BeforeToolCallBlockedError";
  }
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  Reflect.set(globalThis, Symbol.for("openclaw.beforeToolCallBlockedErrorTestApi"), {
    create(message: string): Error {
      return new BeforeToolCallBlockedError(message);
    },
  });
}

export class BeforeToolCallFailureError extends Error {
  constructor(
    message: string,
    readonly disposition: BeforeToolCallFailureDisposition,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BeforeToolCallFailureError";
  }
}

export function tagBeforeToolCallFailure(
  error: unknown,
  signal?: AbortSignal,
  stage?: "tool_preparation" | "before_tool_call",
): BeforeToolCallFailureError {
  try {
    if (error instanceof BeforeToolCallFailureError) {
      return error;
    }
  } catch {
    // Continue through the guarded formatter and classifier for hostile values.
  }
  const message = formatToolExecutionErrorMessage(error, "before_tool_call failed");
  const disposition = resolveToolErrorDiagnostic(error, signal).terminalReason;
  const tagged = new BeforeToolCallFailureError(message, disposition, error);
  if (stage === "tool_preparation" && isTrustedToolExecutionPreflightError(error)) {
    registerTrustedToolNoStartError(tagged);
  }
  return tagged;
}

/** Return the closed terminal disposition carried by a before-tool failure. */
export function getBeforeToolCallFailureDisposition(
  error: unknown,
): BeforeToolCallFailureDisposition | undefined {
  try {
    return error instanceof BeforeToolCallFailureError ? error.disposition : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns true when an error represents an intentional before_tool_call veto.
 */
export function isBeforeToolCallBlockedError(err: unknown): err is BeforeToolCallBlockedError {
  return err instanceof BeforeToolCallBlockedError;
}

const preExecutionBlockedToolResults = new WeakSet<object>();

export function isPreExecutionBlockedToolResult(result: unknown): boolean {
  return (
    result !== null && typeof result === "object" && preExecutionBlockedToolResults.has(result)
  );
}

/** Build the standard terminal result for vetoed tool calls. */
export function buildBlockedToolResult(params: {
  reason: string;
  deniedReason?: HookBlockedReason;
  toolCallId?: string;
  runId?: string;
}) {
  recordPreExecutionBlockedToolCall(params.toolCallId, params.runId);
  const result = {
    content: [{ type: "text" as const, text: params.reason }],
    details: {
      status: "blocked",
      deniedReason: params.deniedReason ?? "plugin-before-tool-call",
      reason: params.reason,
    },
  };
  preExecutionBlockedToolResults.add(result);
  return result;
}
