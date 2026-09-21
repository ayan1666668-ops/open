/**
 * Continuation durable-obligation guard for task-flow maintenance.
 *
 * Upstream `715077a3be..4feebfc3da` extracted the prune/cancel/repair decision into
 * `task-flow-maintenance-policy.ts` and added `task-flow-maintenance.worker.ts`. Both
 * are kept byte-identical to upstream here, and neither carries any notion of a
 * durable obligation — our assembly's `shouldPruneFlow` did, and the extraction would
 * otherwise have dropped it silently.
 *
 * A terminal flow still holding pending-obligation state must never be pruned: the
 * obligation is exactly the thing the retention window exists to protect, and pruning
 * loses it with no trace and no failing test.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

/** State keys whose presence means a terminal flow still owes durable work. */
export const PENDING_OBLIGATION_STATE_KEYS = ["terminalNoticePending"] as const;

export function hasUnfulfilledDurableObligation(flow: TaskFlowRecord): boolean {
  const state = flow.stateJson;
  if (!isRecord(state)) {
    return false;
  }
  return PENDING_OBLIGATION_STATE_KEYS.some((key) => state[key] !== undefined);
}
