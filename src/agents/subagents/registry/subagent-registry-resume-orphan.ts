import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { reconcileOrphanedRun } from "./subagent-registry-helpers.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentRunOrphanReason } from "./subagent-session-reconciliation.js";

export function handleOrphanedSubagentResume(params: {
  runId: string;
  entry: SubagentRunRecord;
  source: "live" | "restore";
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  persist: (...runIds: string[]) => void;
  complete: (completion: SubagentCompletionRequest, source: string) => Promise<void>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): boolean {
  const orphanReason = resolveSubagentRunOrphanReason({
    entry: params.entry,
    includeStaleUnended: params.source === "restore",
  });
  if (!orphanReason) {
    return false;
  }
  if (
    params.entry.requesterSettleWake === undefined &&
    params.entry.completion?.required !== true &&
    reconcileOrphanedRun({
      runId: params.runId,
      entry: params.entry,
      reason: orphanReason,
      source: params.source === "restore" ? "restore" : "resume",
      runs: params.runs,
      resumedRuns: params.resumedRuns,
    })
  ) {
    params.persist(params.runId);
    return true;
  }
  if (typeof params.entry.execution.endedAt === "number") {
    return false;
  }
  void params
    .complete(
      {
        runId: params.runId,
        expectedEntry: params.entry,
        endedAt: Date.now(),
        outcome: { status: "error", error: `subagent run orphaned: ${orphanReason}` },
        reason: SUBAGENT_ENDED_REASON_ERROR,
        triggerCleanup: true,
      },
      "orphan-resume",
    )
    .catch((error: unknown) => {
      params.warn("failed to settle orphaned subagent run", { runId: params.runId, error });
    });
  return true;
}
