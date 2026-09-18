import { isDeepStrictEqual } from "node:util";
import type { ReplySessionAuthContext } from "../agents/auth-profiles/session-override.js";
import type { AcceptedCompactionSuccessor } from "../agents/embedded-agent-runner/compaction-successor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { prepareSelection, type CompactionPreparation } from "./execution-selection-preparation.js";
import {
  getSessionExecutionSelection,
  type ModelExecutionSelection,
  type PreparedSessionExecutionSelection,
  type PrepareSessionExecutionSelectionParams,
} from "./execution-selection.js";

export type PreparedCompactionSelection =
  | Exclude<PreparedSessionExecutionSelection, { status: "ready" }>
  | (Extract<PreparedSessionExecutionSelection, { status: "ready" }> & {
      onCommitted: (accepted: AcceptedCompactionSuccessor) => void;
    });

export type PrepareSessionCompactionExecutionSelectionParams = Omit<
  PrepareSessionExecutionSelectionParams,
  "request" | "modelInput" | "sessionEntry" | "sessionKey" | "replyAuth"
> & {
  sessionEntry: InternalSessionEntry;
  sessionKey: string;
  replyAuth?: ReplySessionAuthContext;
  selection: ModelExecutionSelection;
};

/** Same-model maintenance can use a declared transport fallback without changing session intent. */
export async function prepareSessionCompactionExecutionSelection(
  params: PrepareSessionCompactionExecutionSelectionParams,
): Promise<PreparedCompactionSelection> {
  if (!isDeepStrictEqual(getSessionExecutionSelection(params.sessionEntry), params.selection)) {
    return {
      status: "rejected",
      reason: "not-allowed",
      message: "The session selection changed. Retry compaction.",
    };
  }
  const compaction: CompactionPreparation = {
    selection: params.selection,
    expected: {
      sessionId: params.sessionEntry.sessionId,
      lifecycleRevision: params.sessionEntry.lifecycleRevision,
      activeWriterRunId: params.sessionEntry.activeWriterRunId,
    },
  };
  const prepared = await prepareSelection(
    {
      ...params,
      replyAuth: params.replyAuth ?? { isNewSession: false },
      request: { kind: "selection", selection: params.selection },
    },
    compaction,
  );
  if (prepared.status !== "ready") {
    return prepared;
  }
  return {
    ...prepared,
    onCommitted: (accepted) => {
      // The admitted sink advances identity only; selection, account and native-owner facts stay fixed.
      if (accepted.previousSessionId !== compaction.expected.sessionId) {
        return;
      }
      compaction.expected = {
        sessionId: accepted.entry.sessionId,
        lifecycleRevision: accepted.entry.lifecycleRevision,
        activeWriterRunId: accepted.entry.activeWriterRunId,
      };
    },
  };
}
