import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  cleanupSessionLifecycleArtifactsCore,
  listSessionEntriesCore,
  loadExactSessionEntry,
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  publishTranscriptUpdate,
  readSessionUpdatedAtCore,
  replaceSessionEntry,
  updateSessionEntry,
  upsertSessionEntryCore,
  type ExactSessionEntry,
  type SessionAccessScope,
  type SessionEntrySummary,
  type SessionTranscriptAccessScope,
  type SessionTranscriptReadScope,
  type SessionTranscriptWriteScope,
  type TranscriptEvent,
  type TranscriptMessageAppendOptions,
  type TranscriptMessageAppendResult,
  type TranscriptUpdatePayload,
} from "./session-accessor.js";
import { listSessionEntryRows } from "./session-accessor.sqlite-entry.js";
import type { SessionEntry } from "./types.js";

type AccessorAdapter = {
  name: string;
  entryScope(paths: TestPaths): SessionAccessScope;
  transcriptReadScope(paths: TestPaths, id?: string): SessionTranscriptReadScope;
  transcriptScope(paths: TestPaths, id?: string): SessionTranscriptAccessScope;
  loadExactSessionEntry(scope: SessionAccessScope): ExactSessionEntry | undefined;
  loadSessionEntry(scope: SessionAccessScope): SessionEntry | undefined;
  listSessionEntriesCore(
    scope: Partial<Omit<SessionAccessScope, "sessionKey">>,
  ): SessionEntrySummary[];
  readSessionUpdatedAtCore(scope: SessionAccessScope): number | undefined;
  upsertSessionEntry(
    scope: SessionAccessScope,
    patch: Partial<SessionEntry>,
  ): Promise<SessionEntry | null>;
  replaceSessionEntry(scope: SessionAccessScope, entry: SessionEntry): Promise<SessionEntry | null>;
  patchSessionEntryCore(
    scope: SessionAccessScope,
    update: (
      entry: SessionEntry,
      context: { existingEntry?: SessionEntry },
    ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
    options?: { fallbackEntry?: SessionEntry; preserveActivity?: boolean; replaceEntry?: boolean },
  ): Promise<SessionEntry | null>;
  updateSessionEntry(
    scope: SessionAccessScope,
    update: (entry: SessionEntry) => Partial<SessionEntry> | null,
  ): Promise<SessionEntry | null>;
  cleanupSessionLifecycleArtifactsCore(params: {
    storePath: string;
    sessionKeySegmentPrefix: string;
    transcriptContentMarker: string;
    orphanTranscriptMinAgeMs: number;
    nowMs?: number;
  }): Promise<{ removedEntries: number; archivedTranscriptArtifacts: number }>;
  loadTranscriptEvents(scope: SessionTranscriptReadScope): Promise<TranscriptEvent[]>;
  appendTranscriptEvent(scope: SessionTranscriptAccessScope, event: TranscriptEvent): Promise<void>;
  appendTranscriptMessage<TMessage>(
    scope: SessionTranscriptWriteScope,
    options: TranscriptMessageAppendOptions<TMessage>,
  ): Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
  publishTranscriptUpdate(
    scope: SessionTranscriptWriteScope,
    update?: TranscriptUpdatePayload,
  ): Promise<void>;
};

export type TestPaths = {
  sqlitePath: string;
  stateDir: string;
  storePath: string;
  tempDir: string;
};

export const publicAccessorAdapter: AccessorAdapter = {
  name: "public-accessor",
  entryScope: (paths) => ({
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
    sessionKey: "agent:main:main",
    storePath: paths.sqlitePath,
  }),
  transcriptScope: (paths, id = "session-1") => ({
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
    sessionId: id,
    sessionKey: "agent:main:main",
    storePath: paths.sqlitePath,
  }),
  transcriptReadScope: (paths, id = "session-1") => ({
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
    sessionId: id,
    storePath: paths.sqlitePath,
  }),
  loadSessionEntry,
  loadExactSessionEntry,
  listSessionEntriesCore,
  readSessionUpdatedAtCore,
  upsertSessionEntry: upsertSessionEntryCore,
  replaceSessionEntry,
  patchSessionEntryCore,
  updateSessionEntry,
  cleanupSessionLifecycleArtifactsCore,
  loadTranscriptEvents,
  appendTranscriptEvent,
  appendTranscriptMessage,
  publishTranscriptUpdate,
};

export const sqliteAdapter: AccessorAdapter = {
  ...publicAccessorAdapter,
  name: "sqlite",
  listSessionEntriesCore: listSessionEntryRows,
  updateSessionEntry: patchSessionEntryCore,
};
