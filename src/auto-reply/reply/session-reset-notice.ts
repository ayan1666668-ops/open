import type { AutomaticSessionResetReason } from "../../config/sessions.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import type { ReplyPayload } from "../reply-payload.js";

export function formatAutomaticSessionResetNotice(reason: AutomaticSessionResetReason): string {
  return reason === "idle"
    ? "🧭 Started a new session after the configured idle timeout."
    : "🧭 Started a new session at the configured daily reset boundary.";
}

export function buildAutomaticSessionResetNoticePayload(params: {
  reason?: AutomaticSessionResetReason;
  payloads: readonly ReplyPayload[];
}): ReplyPayload | undefined {
  if (
    !params.reason ||
    !params.payloads.some(
      (payload) => !payload.isError && !payload.isReasoning && hasReplyPayloadContent(payload),
    )
  ) {
    return undefined;
  }
  return { text: formatAutomaticSessionResetNotice(params.reason) };
}
