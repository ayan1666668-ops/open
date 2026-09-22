import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import type { readSessionRowTranscriptFields } from "./session-row-transcript-backfill.kernel.js";

/** Optional transcript facts keep the row generation and foreground admission on the host. */
export async function backfillSessionRowTranscriptFields(
  params: Parameters<typeof readSessionRowTranscriptFields>[0] & { shouldCommit?: () => boolean },
): Promise<ReturnType<typeof readSessionRowTranscriptFields>> {
  if (params.shouldCommit?.() === false) {
    return {};
  }
  const { shouldCommit, sessionEntry, ...scope } = params;
  const input = {
    ...scope,
    sessionEntry: {
      sessionId: sessionEntry.sessionId,
      updatedAt: sessionEntry.updatedAt,
      status: sessionEntry.status,
      lastRunId: sessionEntry.lastRunId,
      fallbackNotice: sessionEntry.fallbackNotice ? { ...sessionEntry.fallbackNotice } : undefined,
    },
  };
  return withSessionHistoryWorkerDatabase(
    toDatabaseOptions(
      resolveSqliteTranscriptReadScope({
        ...input,
        agentId: params.storeAgentId ?? params.agentId,
      }),
    ),
    async (owner) => {
      const fields = await owner.readRowBackfill(input);
      owner.assertCurrent();
      return shouldCommit?.() === false ? {} : fields;
    },
  );
}
