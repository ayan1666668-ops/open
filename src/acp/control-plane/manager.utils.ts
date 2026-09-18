import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { SessionAcpLifecycle, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { toErrorObject } from "../../infra/errors.js";
import {
  getCommittedSessionExecutionSelection,
  isAcpExecutionSelection,
  type AcpExecutionSelection,
} from "../../model-picker/execution-selection.js";
/** Shared ACP manager normalization, resolution, and error helpers. */
import { ACP_ERROR_CODES, AcpRuntimeError } from "../runtime/errors.js";
import { buildAcpDatabaseSessionKey } from "../runtime/session-meta-keys.js";
import { resolveSessionStorePathForAcp } from "../runtime/session-meta-store.js";
import type { AcpSessionResolution, AcpSessionTarget } from "./manager.types.js";

/** Builds the stale-session error shown when ACP metadata is missing. */
export function resolveMissingMetaError(sessionKey: string): AcpRuntimeError {
  return new AcpRuntimeError(
    "ACP_SESSION_INIT_FAILED",
    `ACP metadata is missing for ${sessionKey}. Recreate this ACP session with /acp spawn and rebind the thread.`,
  );
}

/** Converts a session resolution union into the runtime error callers should throw. */
export function resolveAcpSessionResolutionError(
  resolution: AcpSessionResolution,
): AcpRuntimeError | null {
  if (resolution.kind === "ready") {
    return null;
  }
  if (resolution.kind === "stale") {
    return resolution.error;
  }
  return new AcpRuntimeError(
    "ACP_SESSION_INIT_FAILED",
    `Session is not ACP-enabled: ${resolution.sessionKey}`,
  );
}

export const ACP_SELECTION_REPAIR_MESSAGE =
  "The app did not confirm the last change. Start a new session, or repair this session before sending another message.";

export function requireAcpExecutionSelection(
  entry: SessionEntry | undefined,
): AcpExecutionSelection {
  const selection = getCommittedSessionExecutionSelection(entry);
  if (!selection || !isAcpExecutionSelection(selection)) {
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "The session execution selection is incomplete. Reinitialize this session.",
    );
  }
  return selection;
}

/** Returns ready metadata; an uncertain external write must remain paused after restart. */
export function requireReadySession(
  resolution: AcpSessionResolution,
): Extract<AcpSessionResolution, { kind: "ready" }> {
  if (resolution.kind === "ready") {
    if (
      resolution.meta.state === "error" &&
      resolution.meta.lastError === ACP_SELECTION_REPAIR_MESSAGE
    ) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", ACP_SELECTION_REPAIR_MESSAGE);
    }
    return resolution;
  }
  throw toErrorObject(resolveAcpSessionResolutionError(resolution), "Non-Error thrown");
}

/** Resolve ownership before main aliases can erase the encoded agent namespace. */
export function resolveAcpSessionTarget(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): AcpSessionTarget {
  const normalized = normalizeLowercaseStringOrEmpty(params.sessionKey);
  if (!normalized) {
    throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
  }
  const { agentId, storeSessionKey: sessionKey } = resolveSessionStorePathForAcp({
    ...params,
    sessionKey: normalized,
  });
  return { agentId, sessionKey };
}

/** Components normalize before encoding; base64url itself is case-sensitive. */
export function acpSessionActorKey(target: AcpSessionTarget): string {
  return buildAcpDatabaseSessionKey(
    normalizeLowercaseStringOrEmpty(target.sessionKey),
    target.agentId,
  );
}

/** Restricts runtime-provided error codes to the ACP error-code enum. */
export function normalizeAcpErrorCode(code: string | undefined): AcpRuntimeError["code"] {
  if (!code) {
    return "ACP_TURN_FAILED";
  }
  const normalized = code.trim().toUpperCase();
  for (const allowed of ACP_ERROR_CODES) {
    if (allowed === normalized) {
      return allowed;
    }
  }
  return "ACP_TURN_FAILED";
}

export function createUnsupportedControlError(params: {
  backend: string;
  control: string;
}): AcpRuntimeError {
  return new AcpRuntimeError(
    "ACP_BACKEND_UNSUPPORTED_CONTROL",
    `ACP backend "${params.backend}" does not support ${params.control}.`,
  );
}

export function hasLegacyAcpIdentityProjection(meta: SessionAcpLifecycle): boolean {
  const raw = meta as Record<string, unknown>;
  return (
    Object.hasOwn(raw, "backendSessionId") ||
    Object.hasOwn(raw, "agentSessionId") ||
    Object.hasOwn(raw, "sessionIdsProvisional")
  );
}
