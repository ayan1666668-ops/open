import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { NodeInvokeCancelEvent } from "../../packages/gateway-protocol/src/schema/nodes.js";

export function buildNodeInvokeCancel(invokeId: string, nodeId: string): NodeInvokeCancelEvent {
  return { invokeId, nodeId };
}

export function buildNodeInvokeRequest(params: {
  id: string;
  nodeId: string;
  command: string;
  params?: unknown;
  timeoutMs: number;
  idempotencyKey?: string;
  sessionKey?: string;
}) {
  return {
    id: params.id,
    nodeId: params.nodeId,
    command: params.command,
    paramsJSON: params.params === undefined ? null : JSON.stringify(params.params),
    timeoutMs: params.timeoutMs,
    idempotencyKey: params.idempotencyKey,
    sessionKey: normalizeOptionalString(params.sessionKey),
  };
}

/** Measure the same outer encoding sent to nodes, including paramsJSON escaping. */
export function serializeNodeEvent(event: string, payload: unknown): string {
  return JSON.stringify({ type: "event", event, payload });
}
