import type { CompactionRequestBudget } from "../../sessions/compaction/request-budget.js";
import {
  restoreEmbeddedRunTimeoutAbandonment,
  type EmbeddedRunTimeoutRecoveryMarker,
} from "../runs.js";
import type { EmbeddedAgentMeta } from "../types.js";
import type { EmbeddedContextAccountingEvent } from "./internal-params.js";

export function createEmbeddedRunContextRecoveryState() {
  let timeoutRecoveryMarker: EmbeddedRunTimeoutRecoveryMarker | undefined;
  const state = {
    autoCompactionCount: 0,
    // SAFETY: No budget exists until the active physical attempt supplies prepared foreground facts.
    compactionRequestBudget: undefined as CompactionRequestBudget | undefined,
    lastCompactionTokensAfter: undefined as number | undefined,
    // SAFETY: The snapshot starts absent; typed accounting events supply its later values.
    currentContextSnapshot: undefined as { tokens: number | undefined } | undefined,
    lastContextBudgetStatus: undefined as EmbeddedAgentMeta["contextBudgetStatus"],
    overflowCompactionAttempts: 0,
    timeoutCompactionAttempts: 0,
    toolResultTruncationAttempted: false,
    observeContextAccounting(event: EmbeddedContextAccountingEvent) {
      // Producer order, not terminal usage copies, determines the current context.
      const tokens = event.kind === "compaction" ? event.tokensAfter : event.contextTokens;
      state.currentContextSnapshot = { tokens };
      if (event.kind === "compaction") {
        state.autoCompactionCount += 1;
        state.lastCompactionTokensAfter = tokens;
        return;
      }
      // A model turn that produced usage means the prompt was admitted, so the
      // overflow the budget was spent on is over. Without this the counter only
      // ever grows and a long run exhausts its three attempts on unrelated
      // overflows it already recovered from.
      state.overflowCompactionAttempts = 0;
    },
    /**
     * Refunds an overflow compaction attempt that freed no context.
     *
     * The budget exists to stop unbounded compaction loops, so it may only be
     * charged for compactions that actually shrank the prompt. A compaction
     * reporting `tokensAfter >= tokensBefore` removed nothing and must not
     * consume one of the three attempts.
     */
    refundOverflowCompactionAttempt() {
      if (state.overflowCompactionAttempts > 0) {
        state.overflowCompactionAttempts -= 1;
      }
    },
    retainTimeoutRecoveryMarker(marker: EmbeddedRunTimeoutRecoveryMarker) {
      timeoutRecoveryMarker = marker;
    },
    restoreTimeoutRecoveryAbandonment() {
      const marker = timeoutRecoveryMarker;
      timeoutRecoveryMarker = undefined;
      return marker ? restoreEmbeddedRunTimeoutAbandonment(marker) : false;
    },
  };
  return state;
}

export type EmbeddedRunContextRecoveryState = ReturnType<
  typeof createEmbeddedRunContextRecoveryState
>;
