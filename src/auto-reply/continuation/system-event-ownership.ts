import { withSystemEventOwner } from "../../infra/system-event-ownership.js";

export function withContinuationOwner<T extends object>(
  options: T,
  ownerAgentId: string | undefined,
): T {
  if (!ownerAgentId) {
    throw new Error("Continuation system event owner is unavailable.");
  }
  return withSystemEventOwner(options, ownerAgentId);
}

export function bindContinuationOwner(ownerAgentId: string | undefined) {
  return <T extends object>(options: T): T => withContinuationOwner(options, ownerAgentId);
}
