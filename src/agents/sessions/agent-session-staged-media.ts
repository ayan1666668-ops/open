import { recordInboundMediaOwnersInValue } from "../../media/inbound-media-ownership.js";
import type { AgentEvent, AgentMessage } from "../runtime/index.js";

/**
 * A staged media reference is readable only by the session that published its result, and a
 * persisted toolResult is where that reference lands in a session. This binds ownership at that
 * point, and it is AWAITED before the message reaches a listener or the store: every reader
 * learns the reference from this message, and the route refuses a staged object with no owner,
 * so the owner must be on the record while the reference is still invisible to everyone else.
 *
 * Best-effort: a failed write leaves the object unbound, which the route refuses, so a failure
 * here narrows access rather than widening it.
 */
export async function bindStagedMediaOwnership(
  message: AgentMessage,
  sessionKey: string | undefined,
): Promise<string[]> {
  if (message.role !== "toolResult" || !sessionKey) {
    return [];
  }
  return await recordInboundMediaOwnersInValue(message.content, { sessionKey }).catch(() => []);
}

/**
 * Binds the reference a `message_end` event is about to publish, so the session base can await it
 * as one call. Any other event carries no reference to bind.
 */
export async function bindStagedMediaOwnershipForEvent(
  event: AgentEvent,
  sessionKey: string | undefined,
): Promise<string[]> {
  return event.type === "message_end"
    ? await bindStagedMediaOwnership(event.message, sessionKey)
    : [];
}
