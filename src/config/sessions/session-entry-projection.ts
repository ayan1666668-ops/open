import {
  projectExecutionSelectionEntry,
  type PublicSessionEntry,
} from "../../model-picker/execution-selection-projection.js";
import { clearAllCliSessions } from "./cli-session-binding.js";
import {
  SESSION_TOTAL_TOKENS_VERSION,
  type InternalSessionEntry,
  type SessionEntry,
} from "./types.js";

export const SESSION_ENTRY_PRIVATE_CLEAR_PATCH = {
  activeWriterRunId: undefined,
  lastRunId: undefined,
  lifecycleRunId: undefined,
  mainRestartRecovery: undefined,
  pendingProjectGitUrl: undefined,
  pendingWorktree: undefined,
  sessionDiffBaselineCapture: undefined,
  transcriptByteCompactionLatch: undefined,
} satisfies Partial<InternalSessionEntry>;

const PRIVATE_SESSION_ENTRY_KEYS = [
  "cliHistoryBoundary",
  "publicShare",
  "activeWriterRunId",
  "lastRunId",
  "lifecycleRunId",
  "mainRestartRecovery",
  "pendingProjectGitUrl",
  "pendingWorktree",
  "sessionDiffBaselineCapture",
  "transcriptByteCompactionLatch",
] as const satisfies readonly (keyof InternalSessionEntry)[];

/** Strip runtime authority before handing a canonical snapshot to another core subsystem. */
export function stripPrivateSessionEntryFields(entry: InternalSessionEntry): SessionEntry;
export function stripPrivateSessionEntryFields(
  entry: Partial<InternalSessionEntry>,
): Partial<SessionEntry>;
export function stripPrivateSessionEntryFields(
  entry: Partial<InternalSessionEntry> & { thinkingLevelSelection?: unknown },
): Partial<SessionEntry> {
  const projected = { ...entry };
  for (const key of PRIVATE_SESSION_ENTRY_KEYS) {
    delete projected[key];
  }
  delete projected.thinkingLevelSelection;
  if (projected.modelFallback) {
    const fallback: typeof projected.modelFallback & { prevThinkingLevelSelection?: unknown } = {
      ...projected.modelFallback,
    };
    delete fallback.prevThinkingLevelSelection;
    projected.modelFallback = fallback;
  }
  return projected;
}

export function projectPublicSessionEntry(entry: InternalSessionEntry): PublicSessionEntry {
  return {
    ...projectExecutionSelectionEntry(stripPrivateSessionEntryFields(entry)),
    sessionId: entry.sessionId,
    updatedAt: entry.updatedAt,
  };
}

// A completed context rewrite invalidates the previous run snapshot, not the transcript ledger.
export const COMPACTION_RUN_USAGE_CLEAR_PATCH = {
  inputTokens: undefined,
  outputTokens: undefined,
  cacheRead: undefined,
  cacheWrite: undefined,
  estimatedCostUsd: undefined,
} satisfies Partial<InternalSessionEntry>;

export function projectCompactionAccountingPatch(
  current: InternalSessionEntry,
  params: {
    amount?: number;
    compactionKind?: "context-engine" | "native-harness" | "server-endpoint";
    now?: number;
    tokensAfter?: number;
    transcriptByteCompactionLatch?: NonNullable<
      InternalSessionEntry["transcriptByteCompactionLatch"]
    >;
  },
): Partial<InternalSessionEntry> {
  const incrementBy = Math.max(0, params.amount ?? 1);
  const tokensAfter =
    typeof params.tokensAfter === "number" &&
    Number.isFinite(params.tokensAfter) &&
    params.tokensAfter >= 0
      ? Math.floor(params.tokensAfter)
      : undefined;
  const patch: Partial<InternalSessionEntry> = {
    compactionCount: (current.compactionCount ?? 0) + incrementBy,
    transcriptByteCompactionLatch: params.transcriptByteCompactionLatch,
    updatedAt: params.now ?? Date.now(),
    ...(incrementBy > 0 || tokensAfter !== undefined ? COMPACTION_RUN_USAGE_CLEAR_PATCH : {}),
    ...(incrementBy > 0 ? { contextBudgetStatus: undefined } : {}),
  };
  if (params.compactionKind === "context-engine") {
    clearAllCliSessions(patch);
  }
  if (tokensAfter !== undefined) {
    Object.assign(patch, {
      totalTokens: tokensAfter,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    });
  } else if (incrementBy > 0) {
    patch.totalTokensFresh = false;
    patch.totalTokensVersion = undefined;
  }
  return patch;
}
