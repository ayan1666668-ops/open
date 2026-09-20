import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import type { SessionPendingInputRow } from "./session-accessor.sqlite-pending-inputs.js";
import { readMessageIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";

function resolvePendingInputRequestHash(
  message: Record<string, unknown>,
  requestFingerprint?: string,
): string {
  return requestFingerprint
    ? `request:${requestFingerprint}`
    : createHash("sha256").update(stableStringify(message)).digest("hex");
}

function preparePendingInputMessage(
  message: PersistedUserTurnMessage,
  requestFingerprint?: string,
) {
  const { timestamp: _timestamp, ...stableMessage } = message;
  if (Buffer.byteLength(JSON.stringify(stableMessage), "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("Pending input exceeds the Gateway payload limit");
  }
  return {
    stableMessage,
    requestHash: resolvePendingInputRequestHash(stableMessage, requestFingerprint),
  };
}

export type PendingInputRequest = {
  message: PersistedUserTurnMessage;
  runId: string;
  /** Authenticated ingress binds raw input before randomized media preparation. */
  requestFingerprint?: string;
  /** Trusted frozen-cohort sources, matched against an existing full request hash only. */
  replaySourceSessionKeys?: readonly string[];
};

export function preparePendingInputRequest(params: PendingInputRequest) {
  const idempotencyKey = readMessageIdempotencyKey(params.message);
  if (!idempotencyKey || !params.runId) {
    throw new Error("Pending input requires an exact run and message idempotency key");
  }
  return {
    message: params.message,
    runId: params.runId,
    idempotencyKey,
    replaySourceSessionKeys: params.replaySourceSessionKeys,
    ...preparePendingInputMessage(params.message, params.requestFingerprint),
  };
}

/** Reconcile only a shipped scheduling-source variation against its complete accepted hash. */
export function resolvePendingInputReplayRequest(
  prepared: ReturnType<typeof preparePendingInputRequest>,
  accepted?: Pick<SessionPendingInputRow, "request_hash" | "run_id">,
) {
  const { message, replaySourceSessionKeys } = prepared;
  const original = {
    message,
    stableMessage: prepared.stableMessage,
    requestHash: prepared.requestHash,
  };
  if (!replaySourceSessionKeys) {
    return original;
  }
  if (
    prepared.requestHash.startsWith("request:") ||
    message.provenance?.kind !== "inter_session" ||
    message.provenance.sourceTool !== "subagent_settle"
  ) {
    throw new Error("Pending input source replay requires an internal settle request");
  }
  if (accepted?.run_id !== prepared.runId || accepted.request_hash === prepared.requestHash) {
    return original;
  }
  // v2026.9.5 keyed the wave but attributed it to the scheduling sibling.
  // Nothing else may vary, and an absent or unmatched receipt authorizes no substitution.
  for (const sourceSessionKey of new Set(replaySourceSessionKeys)) {
    const candidate = { ...message, provenance: { ...message.provenance, sourceSessionKey } };
    const request = preparePendingInputMessage(candidate);
    if (request.requestHash === accepted.request_hash) {
      return { message: candidate, ...request };
    }
  }
  return original;
}

export function matchesSessionPendingInputRequest(
  receipt: Pick<SessionPendingInputRow, "request_hash" | "consumed_event_id">,
  message: Record<string, unknown>,
  requestHash: string,
): boolean {
  if (receipt.request_hash === requestHash) {
    return true;
  }
  // Older collectors retain message-hash receipts. Matching one returns its
  // recorded outcome; it must never reopen pre-upgrade execution custody.
  if (receipt.consumed_event_id == null) {
    return false;
  }
  if (receipt.request_hash === resolvePendingInputRequestHash(message)) {
    return true;
  }
  const metadata = asOptionalRecord(message["__openclaw"]);
  const transport = asOptionalRecord(metadata?.transport);
  if (!metadata || !transport || !Object.hasOwn(transport, "clients")) {
    return false;
  }
  // v2026.9.4 Gateway inputs have no client sources. Preserve every other
  // request field while reconstructing their original serialized shape.
  const legacyTransport = { ...transport };
  delete legacyTransport.clients;
  const legacyMetadata = { ...metadata };
  if (Object.keys(legacyTransport).length) {
    legacyMetadata.transport = legacyTransport;
  } else {
    delete legacyMetadata.transport;
  }
  const legacyMessage = { ...message };
  if (Object.keys(legacyMetadata).length) {
    legacyMessage["__openclaw"] = legacyMetadata;
  } else {
    delete legacyMessage["__openclaw"];
  }
  return receipt.request_hash === resolvePendingInputRequestHash(legacyMessage);
}
