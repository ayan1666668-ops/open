/**
 * Direct text-completion fallback wiring: the last-mile send used when the
 * requester-agent handoff cannot carry a child completion to the user.
 */
import { deliverCompletionDirect } from "./subagent-announce-completion-delivery.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

export type CompletionContentKind = "completed_result" | "failed_notice";

type TextCompletionDirectDeliveryParams = Omit<
  Parameters<typeof deliverCompletionDirect>[0],
  "agentResult" | "contentKind"
> & { defaultContentKind: CompletionContentKind };

// The fallback keeps the announce route's own content kind unless the caller
// overrides it for a specific attempt (a failed trusted completion, a retry).
export function createTextCompletionDirectDelivery(
  params: TextCompletionDirectDeliveryParams,
): (
  contentKind?: CompletionContentKind,
  agentResult?: { payloads?: unknown },
) => Promise<SubagentAnnounceDeliveryResult | undefined> {
  const { defaultContentKind, ...delivery } = params;
  return (
    contentKind: CompletionContentKind = defaultContentKind,
    agentResult?: { payloads?: unknown },
  ) => deliverCompletionDirect({ ...delivery, contentKind, agentResult });
}
