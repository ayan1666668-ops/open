import {
  readSessionMessageIdentity,
  type SessionProjectionScope,
} from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";

type LiveTerminalIdentity = {
  runId: string;
  afterBoundaryRunId?: string;
  disposition?: "aborted" | "error" | "timeout";
};

const liveTerminalIdentities = new WeakMap<object, LiveTerminalIdentity>();
const authoritativeTerminals = new WeakMap<object, AuthoritativeTerminal>();

type AuthoritativeTerminal = {
  historyApplied: boolean;
  messageId: string;
  runId: string;
  scope: SessionProjectionScope;
};

/** Associates a live terminal projection with its run without altering transcript bytes. */
export function rememberLiveTerminalRun(
  message: unknown,
  runId: string | null | undefined,
  afterBoundaryRunId?: string,
  disposition?: LiveTerminalIdentity["disposition"],
): unknown {
  if (runId && message && typeof message === "object") {
    liveTerminalIdentities.set(message, {
      runId,
      ...(afterBoundaryRunId ? { afterBoundaryRunId } : {}),
      ...(disposition ? { disposition } : {}),
    });
  }
  return message;
}

export function isLiveTerminalForRun(message: unknown, runId: string): boolean {
  return Boolean(
    message && typeof message === "object" && liveTerminalIdentities.get(message)?.runId === runId,
  );
}

export function readLiveTerminalRunId(message: unknown): string | null {
  return message && typeof message === "object"
    ? (liveTerminalIdentities.get(message)?.runId ?? null)
    : null;
}

export function readLiveTerminalAfterBoundaryRunId(message: unknown): string | null {
  return message && typeof message === "object"
    ? (liveTerminalIdentities.get(message)?.afterBoundaryRunId ?? null)
    : null;
}

export function readLiveTerminalDisposition(
  message: unknown,
): LiveTerminalIdentity["disposition"] | null {
  return message && typeof message === "object"
    ? (liveTerminalIdentities.get(message)?.disposition ?? null)
    : null;
}

export function rememberAuthoritativeTerminal(options: {
  event: {
    clientRunId?: string | null;
    hasActiveRun?: boolean | null;
    key: string;
    runId?: string | null;
  };
  host: {
    lastLocalTerminalReconcile?: {
      sessionKey: string;
      agentId?: string;
      runId: string | null;
    } | null;
  };
  matchesChat: boolean;
  payload: unknown;
  runIdBeforeApply: string | null;
  scope: SessionProjectionScope;
}): void {
  const payload = asNullableRecord(options.payload);
  const identity = readSessionMessageIdentity(payload?.message, {
    messageId: payload?.messageId,
  });
  const messageId = identity?.role === "assistant" && !identity.isImported ? identity.id : null;
  const recent = options.host.lastLocalTerminalReconcile;
  // Shared session publication can retire the local run before this event reaches
  // the pane. Its exact scoped tombstone is a receipt, not producer admission.
  const receiptRunId =
    options.runIdBeforeApply ??
    (recent &&
    areUiSessionKeysEquivalent(recent.sessionKey, options.scope.sessionKey) &&
    recent.agentId === options.scope.agentId &&
    (!options.event.runId || options.event.runId === recent.runId) &&
    (!options.event.clientRunId || options.event.clientRunId === recent.runId)
      ? recent.runId
      : null);
  if (!receiptRunId || !options.matchesChat || options.event.hasActiveRun === true || !messageId) {
    return;
  }
  authoritativeTerminals.set(options.host, {
    historyApplied: false,
    messageId,
    runId: options.event.clientRunId ?? options.event.runId ?? receiptRunId,
    scope: options.scope,
  });
}

export function reconcileAuthoritativeTerminalHistory<T>(options: {
  host: object;
  scope: SessionProjectionScope;
  messages: T[];
}): { runId: string; messages: T[] } | null {
  const terminal = authoritativeTerminals.get(options.host);
  if (
    !terminal ||
    !terminal.scope.sessionKey ||
    !options.scope.sessionKey ||
    !areUiSessionKeysEquivalent(terminal.scope.sessionKey, options.scope.sessionKey) ||
    (["agentId", "sessionId", "activeLeafEntryId", "lifecycleRevision"] as const).some(
      (key) => terminal.scope[key] !== undefined && terminal.scope[key] !== options.scope[key],
    )
  ) {
    return null;
  }
  const messages = options.messages.filter((message) => {
    const identity = readSessionMessageIdentity(message);
    return (
      identity?.role === "assistant" &&
      !identity.isImported &&
      identity.id === terminal.messageId &&
      (!identity.runId || identity.runId === terminal.runId)
    );
  });
  if (!messages.length) {
    return null;
  }
  authoritativeTerminals.set(options.host, { ...terminal, historyApplied: true });
  return { runId: terminal.runId, messages };
}

export function authoritativeHistoryAppliedForRun(host: object, runId: string): boolean {
  const terminal = authoritativeTerminals.get(host);
  return terminal?.runId === runId && terminal.historyApplied;
}

export function normalizeFinalAssistantMessage(message: unknown): Record<string, unknown> | null {
  const candidate = asNullableRecord(message);
  if (
    !candidate ||
    (typeof candidate.role === "string" &&
      normalizeLowercaseStringOrEmpty(candidate.role) !== "assistant") ||
    (!("content" in candidate) && typeof candidate.text !== "string")
  ) {
    return null;
  }
  const assistant =
    typeof candidate.role === "string" ? candidate : { ...candidate, role: "assistant" };
  // Canonicalize text-only finals before reducing so replay identity includes the reply.
  return !Object.hasOwn(assistant, "content") && typeof assistant.text === "string"
    ? { ...assistant, content: [{ type: "text", text: assistant.text }] }
    : assistant;
}
