import fs from "node:fs";
import { setImmediate } from "node:timers/promises";
import { listCliRuntimeModelBackendBindings } from "../agents/cli-backends.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import { importSqliteSessionRowsBatch } from "../config/sessions/session-accessor.sqlite-import.js";
import { normalizePersistedSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import type { SessionStoreTarget as ResolvedSessionStoreTarget } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareDeferredPluginSessionImportReader } from "../infra/deferred-plugin-session-sources.js";
import { prepareLegacyAcpMigrationSource } from "../infra/legacy-acp-migration-source.js";
import { importLegacyAcpSessionMetadata } from "../infra/state-migrations.acp-session-metadata.js";
import { resolveExecutionSelectionExecutorKind } from "../model-picker/apply-session-model-selection.js";
import {
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
} from "./doctor-session-sqlite-artifact.js";
import type { LegacySessionRecord } from "./doctor-session-sqlite-discovery.js";
import {
  countTranscriptEventsForPath,
  createTranscriptEventReader,
  readOnlySqliteValidationSnapshot,
  readTranscriptFingerprint,
  type ReadOnlySqliteValidationSnapshot,
} from "./doctor-session-sqlite-readers.js";
import type {
  DoctorSessionSqliteOptions,
  DoctorSessionSqliteTargetReport,
} from "./doctor-session-sqlite-types.js";
import { migrateSessionExecutionSelection } from "./doctor/shared/session-execution-selection.js";

type SessionStoreTarget = ResolvedSessionStoreTarget & { sqlitePath?: string };
type SessionEntryTransform = NonNullable<
  NonNullable<DoctorSessionSqliteOptions["importDatabase"]>["transformEntry"]
>;
const SESSION_IMPORT_BATCH_SIZE = 256;

export async function importLegacySessionRecords(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  target: SessionStoreTarget;
  records: readonly LegacySessionRecord[];
  report: DoctorSessionSqliteTargetReport;
  importDatabase?: DoctorSessionSqliteOptions["importDatabase"];
}): Promise<void> {
  const { cfg, env, target, records, report, importDatabase: supplied } = params;
  if (records.length === 0) {
    return;
  }
  const cliRuntimeProviders = supplied?.transformEntry
    ? undefined
    : new Map(
        listCliRuntimeModelBackendBindings({ config: cfg, env, includeSetupRegistry: true }).map(
          ({ runtime, provider }) => [runtime, provider],
        ),
      );
  const defaultProvider = supplied?.transformEntry
    ? undefined
    : resolveDefaultModelForAgent({
        cfg,
        agentId: target.agentId,
        allowPluginNormalization: false,
      }).provider;
  const transformEntry: SessionEntryTransform =
    supplied?.transformEntry ??
    ((source, sessionKey) => {
      const entry = normalizePersistedSessionEntryShape(
        migrateSessionExecutionSelection({
          entry: source,
          classifyExecutor: (id) => resolveExecutionSelectionExecutorKind(cfg, id),
          defaultProvider,
          cliRuntimeProviders,
        }).entry,
        { sessionKey },
      );
      if (!entry) {
        throw new Error(
          "Legacy session selection conversion produced an invalid session; source retained.",
        );
      }
      return entry;
    });
  const importedTranscriptSources = new Set<string>();
  const existingSnapshot = readOnlySqliteValidationSnapshot(target);
  for (let offset = 0; offset < records.length; offset += SESSION_IMPORT_BATCH_SIZE) {
    const pending = records.slice(offset, offset + SESSION_IMPORT_BATCH_SIZE).flatMap((record) => {
      const prepared = prepareLegacySessionImport(
        target,
        record,
        report,
        importedTranscriptSources,
        existingSnapshot.ok ? existingSnapshot.snapshot : undefined,
        transformEntry,
      );
      return prepared ? [{ ...prepared, record }] : [];
    });
    const imported = await importSqliteSessionRowsBatch(
      pending.map((entry) => entry.params),
      supplied,
    );
    for (const [index, result] of imported.entries()) {
      const record = pending[index]?.record;
      if (record && result.recovery) {
        record.recovery = result.recovery;
      }
    }
    report.importedEntries += imported.length;
    report.importedTranscriptEvents += imported.reduce(
      (total, result) => total + result.transcriptEvents,
      0,
    );
    report.issues.push(...pending.flatMap((entry) => (entry.issue ? [entry.issue] : [])));
    await setImmediate();
  }
}

function prepareLegacySessionImport(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
  importedTranscriptSources: Set<string>,
  existingSnapshot: ReadOnlySqliteValidationSnapshot | undefined,
  transformEntry: SessionEntryTransform,
) {
  if (
    record.historical &&
    record.transcriptPath &&
    !sameMigrationArtifact(
      record.historical.identity,
      readMigrationArtifactIdentity(record.transcriptPath),
    )
  ) {
    report.issues.push({
      code: "historical_transcript_deferred",
      sessionKey: record.sessionKey,
      message: `${record.historical.originalPath}: source changed after discovery; retained without importing`,
    });
    return undefined;
  }
  const transcriptSourceKey = record.transcriptPath
    ? `${record.entry.sessionId}\0${record.transcriptPath}`
    : undefined;
  const transcriptFingerprint =
    transcriptSourceKey !== undefined &&
    !importedTranscriptSources.has(transcriptSourceKey) &&
    record.transcriptPath &&
    fs.existsSync(record.transcriptPath)
      ? readTranscriptFingerprint(record.transcriptPath)
      : undefined;
  record.sourceFingerprint = transcriptFingerprint;
  const result = countTranscriptEventsForPath(record.transcriptPath);
  const transcriptMtimeMs = readLegacyTranscriptMtimeMs(record);
  const acpEntry = !record.historical
    ? normalizePersistedSessionEntryShape(record.entry, { sessionKey: record.sessionKey })
    : undefined;
  const entry = transformEntry(record.entry, record.sessionKey);
  const params = {
    historicalOnly: Boolean(record.historical),
    allowMalformedRowRepair: true,
    repairLegacyTranscript: true,
    agentId: target.agentId,
    entry,
    ...(acpEntry?.acp
      ? {
          legacyAcpMigrationSource: prepareLegacyAcpMigrationSource({
            sourcePath: target.storePath,
            sourceSessionKey: record.sessionKey,
            sessionId: acpEntry.sessionId,
            lifecycleRevision: acpEntry.lifecycleRevision,
            meta: acpEntry.acp,
          }),
        }
      : {}),
    preserveExactStoredKey: true,
    sessionKey: record.sessionKey,
    storePath: target.sqlitePath ?? target.storePath,
  };
  if (result.status === "missing") {
    if (markAlreadyMigratedTranscript(record, report, existingSnapshot)) {
      return undefined;
    }
    return {
      issue: {
        code: "transcript_missing",
        message: `Transcript file is missing: ${record.transcriptPath}`,
        sessionKey: record.sessionKey,
      },
      params,
    };
  }
  if (transcriptSourceKey) {
    importedTranscriptSources.add(transcriptSourceKey);
  }
  return {
    ...(result.status === "malformed"
      ? {
          issue: {
            code: "transcript_malformed" as const,
            message: result.message,
            sessionKey: record.sessionKey,
          },
        }
      : {}),
    params: {
      ...params,
      ...(record.transcriptPath && transcriptFingerprint
        ? {
            readTranscriptEvents: createTranscriptEventReader(
              record.transcriptPath,
              record.entry.sessionId,
              result.status === "malformed",
              transcriptFingerprint,
              record.historical?.originalPath ?? record.transcriptPath,
            ),
          }
        : {}),
      ...(transcriptMtimeMs !== undefined ? { transcriptMtimeMs } : {}),
    },
  };
}

function markAlreadyMigratedTranscript(
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
  snapshot: ReadOnlySqliteValidationSnapshot | undefined,
): boolean {
  const migratedEvents = countAlreadyMigratedTranscriptEventsForImport(snapshot, record);
  if (migratedEvents === undefined) {
    return false;
  }
  report.validatedEntries += 1;
  report.validatedTranscriptEvents += migratedEvents;
  return true;
}
function countAlreadyMigratedTranscriptEventsForImport(
  snapshot: ReadOnlySqliteValidationSnapshot | undefined,
  record: LegacySessionRecord,
): number | undefined {
  if (!snapshot) {
    return undefined;
  }
  const normalizedKey = record.sessionKey;
  if (snapshot.sessionIdsBySessionKey.get(normalizedKey) !== record.entry.sessionId) {
    return undefined;
  }
  return snapshot.transcriptEventCountsBySessionId.get(record.entry.sessionId) ?? 0;
}
function readLegacyTranscriptMtimeMs(record: LegacySessionRecord): number | undefined {
  if (!record.transcriptPath) {
    return undefined;
  }
  try {
    const mtimeMs = Math.floor(fs.statSync(record.transcriptPath).mtimeMs);
    return Number.isFinite(mtimeMs) && mtimeMs >= 0 ? mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/** Publish lifecycle metadata only after the core import receipt proves source custody. */
export function publishLegacyAcpSessionMetadata(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  target: SessionStoreTarget;
  records: readonly LegacySessionRecord[];
  report: DoctorSessionSqliteTargetReport;
}): void {
  const readVerifiedCoreImport = prepareDeferredPluginSessionImportReader(params);
  for (const record of params.records) {
    if (record.historical || !record.entry.acp) {
      continue;
    }
    const imported = importLegacyAcpSessionMetadata({
      cfg: params.cfg,
      env: params.env,
      agentId: params.target.agentId,
      sourcePath: params.target.storePath,
      sourceSessionKey: record.sessionKey,
      sessionKey: record.sessionKey,
      sessionId: record.entry.sessionId,
      lifecycleRevision: record.entry.lifecycleRevision,
      meta: record.entry.acp,
      preserveSource: true,
      readVerifiedCoreImport,
    });
    if (imported === "deferred") {
      params.report.issues.push({
        code: "acp_metadata_deferred",
        sessionKey: record.sessionKey,
        message: "ACP metadata has no verified canonical session owner; source retained.",
      });
    }
  }
}
