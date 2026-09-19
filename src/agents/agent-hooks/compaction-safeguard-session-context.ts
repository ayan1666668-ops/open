import { isRealConversationMessage } from "../compaction-real-conversation.js";
import {
  buildSessionContext as buildCoreSessionContext,
  type AgentMessage,
  type SessionTreeEntry as CoreSessionTreeEntry,
} from "../runtime/index.js";

function readSessionBranch(sessionManager: unknown): CoreSessionTreeEntry[] {
  try {
    const entries: unknown = (sessionManager as { getBranch?: () => unknown })?.getBranch?.();
    return Array.isArray(entries) ? (entries as CoreSessionTreeEntry[]) : [];
  } catch {
    return [];
  }
}

function projectBranchEntries(entries: CoreSessionTreeEntry[]): AgentMessage[] {
  try {
    return buildCoreSessionContext(entries).messages as AgentMessage[];
  } catch {
    return [];
  }
}

/** Messages visible after the last reset or compaction boundary. */
export function collectSessionContextMessages(sessionManager: unknown): AgentMessage[] {
  return projectBranchEntries(readSessionBranch(sessionManager));
}

/** Boundary-scoped messages covered by the current compaction preparation. */
export function collectPreparationRangeMessages(
  sessionManager: unknown,
  firstKeptEntryId: string,
): AgentMessage[] {
  const entries = readSessionBranch(sessionManager);
  const firstKeptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
  if (firstKeptIndex < 0) {
    return [];
  }
  return projectBranchEntries(entries.slice(0, firstKeptIndex)).filter(
    (message) => message.role !== "compactionSummary",
  );
}

export function containsRealConversation(messages: AgentMessage[]): boolean {
  return messages.some((message, index, allMessages) =>
    isRealConversationMessage(message, allMessages, index),
  );
}
