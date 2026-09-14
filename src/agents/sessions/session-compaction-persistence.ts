import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-transcript-state.js";
import type {
  SessionTranscriptRuntimeTarget,
  SessionTranscriptWriteScope,
} from "../../config/sessions/session-accessor.types.js";
import type { CompactionEntry } from "./session-manager-types.js";

/** Prepared data only; the original runtime owner still authorizes the commit. */
export type PreparedCompactionAppend = {
  scope: SessionTranscriptRuntimeTarget &
    Pick<SessionTranscriptWriteScope, "expectedLifecycleRevision" | "expectedWriterRunId">;
  event: CompactionEntry;
  appendIntent?: "active-branch";
  expectedMutationAt?: number | null;
  initializeEntry?: boolean;
};

export type CommittedCompactionAppend = {
  result: CompactionEntry;
  before: SessionTranscriptContextVersion;
  after: SessionTranscriptContextVersion;
};

export type CompactionAppendPersistence = (
  prepared: PreparedCompactionAppend,
) => CommittedCompactionAppend;

const invocation = new AsyncLocalStorage<{
  manager: object;
  persist: CompactionAppendPersistence;
}>();

/** Bind host accounting only to this exact manager's synchronous compaction invocation. */
export function withSessionCompactionPersistence(
  manager: object,
  persist: CompactionAppendPersistence | undefined,
  append: () => string,
): string {
  return persist ? invocation.run({ manager, persist }, append) : append();
}

export function getSessionCompactionPersistence(
  manager: object,
): CompactionAppendPersistence | undefined {
  const current = invocation.getStore();
  return current?.manager === manager ? current.persist : undefined;
}
