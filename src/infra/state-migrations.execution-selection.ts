import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import {
  migrateSessionExecutionSelection,
  type LegacyAcpExecutionSelection,
} from "../commands/doctor/shared/session-execution-selection.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExecutionSelectionExecutorKind } from "../model-picker/apply-session-model-selection.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { assertOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-maintenance.js";
import { assertSupportedAgentSchemaVersion } from "../state/openclaw-agent-db-schema-read.js";
import { ensureOpenClawAgentSchema } from "../state/openclaw-agent-db-schema.js";
import type { DB as AgentDatabase } from "../state/openclaw-agent-db.generated.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import { repairOpenClawStateDatabaseSchema } from "../state/openclaw-state-db.js";
import {
  resolveOpenClawRegisteredAgentDatabasePath,
  resolveOpenClawStateSqlitePath,
} from "../state/openclaw-state-db.paths.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  clearNodeSqliteKyselyCacheForDatabase,
} from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import { discoverAgentDatabaseMigrationTargets } from "./state-migrations.media-persistence-targets.js";
import type { MigrationMessages } from "./state-migrations.types.js";

type LegacySharedDatabase = {
  agent_databases: { agent_id: string; path: string; schema_version: number };
  acp_sessions: {
    session_key: string;
    session_id: string | null;
    backend: string;
    agent: string;
    runtime_options_json: string | null;
  };
};

function parseEntry(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) throw new Error("Session migration requires an object row.");
  return value;
}

/** Copy execution intent under Doctor's stopped-writer authority before retiring its sources. */
export async function migrateLegacyExecutionSelections(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  configuredAgentDatabaseTargets?: readonly { agentId: string; path: string }[];
}): Promise<MigrationMessages> {
  const env = params.env ?? process.env;
  const sharedPath = resolveOpenClawStateSqlitePath(env);
  if (!fs.existsSync(sharedPath)) return { changes: [], warnings: [] };
  const scope = getOpenClawDatabaseMaintenanceScope();
  if (!scope?.ownsSchemaMaintenance) {
    throw new Error("Execution selection migration requires stopped-writer Doctor maintenance.");
  }
  scope.assertAdmission();
  return withAgentDatabaseMaintenanceLease(
    { env, schemaPolicy: "existing" },
    async (maintenance) => {
      const shared = openNodeSqliteDatabase(sharedPath, { readOnly: true });
      let registered: Array<{ agentId: string; path: string; storedPath: string }>;
      let sources: Array<LegacySharedDatabase["acp_sessions"]>;
      let sharedVersion: number;
      try {
        sharedVersion = readSqliteUserVersion(shared);
        const db = getNodeSqliteKysely<LegacySharedDatabase>(shared);
        registered = executeSqliteQuerySync(
          shared,
          db.selectFrom("agent_databases").selectAll(),
        ).rows.map((row) => ({
          agentId: row.agent_id,
          path: resolveOpenClawRegisteredAgentDatabasePath(sharedPath, row.path),
          storedPath: row.path,
        }));
        sources = tableHasColumn(shared, "acp_sessions", "backend")
          ? executeSqliteQuerySync(shared, db.selectFrom("acp_sessions").selectAll()).rows
          : [];
      } finally {
        clearNodeSqliteKyselyCacheForDatabase(shared);
        shared.close();
      }
      const discovery = discoverAgentDatabaseMigrationTargets({
        configuredAgentDatabaseTargets:
          params.configuredAgentDatabaseTargets ??
          resolveConfiguredAgentDatabaseTargets(params.cfg, {
            env,
            registeredDatabases: registered,
          }),
        registeredAgentDatabases: registered,
        env,
      });
      if (discovery.failures.length || discovery.externalWarnings.length) {
        throw new Error([...discovery.warnings, ...discovery.externalWarnings].join("\n"));
      }
      const pending = discovery.targets.some((target) => {
        const database = openNodeSqliteDatabase(target.path, { readOnly: true });
        try {
          assertSupportedAgentSchemaVersion(database, target.path);
          return readSqliteUserVersion(database) < OPENCLAW_AGENT_SCHEMA_VERSION;
        } finally {
          database.close();
        }
      });
      if (sharedVersion >= 18 && !pending) return { changes: [], warnings: [] };
      const backupRoot = path.join(resolveStateDir(env), "backups", "execution-selection");
      fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
      const backupDirectory = fs.mkdtempSync(path.join(backupRoot, "migration-"));
      await createVerifiedSqliteSnapshot({
        sourcePath: sharedPath,
        targetPath: path.join(backupDirectory, "shared.sqlite"),
        preserveRowIds: true,
        beforePublish: () => maintenance.assertOwned(),
      });
      const sourceByKey = new Map(sources.map((row) => [row.session_key, row]));
      const copied = new Set<string>();
      for (const [index, target] of discovery.targets.entries()) {
        maintenance.assertOwned();
        await createVerifiedSqliteSnapshot({
          sourcePath: target.path,
          targetPath: path.join(backupDirectory, `agent-${index}.sqlite`),
          preserveRowIds: true,
          beforePublish: () => maintenance.assertOwned(),
        });
        maintenance.assertOwned();
        const database = openNodeSqliteDatabase(target.path);
        try {
          assertOpenClawAgentDatabaseOwner(database, {
            agentId: target.agentId,
            pathname: target.path,
          });
          assertSupportedAgentSchemaVersion(database, target.path);
          const version = readSqliteUserVersion(database);
          const migrate = () => {
            const db = getNodeSqliteKysely<Pick<AgentDatabase, "session_nodes">>(database);
            const rows = executeSqliteQuerySync(
              database,
              db
                .selectFrom("session_nodes")
                .select(["session_key", "current_session_id", "entry_json"]),
            ).rows;
            for (const row of rows) {
              if (row.entry_json === "{}") continue;
              const source = sourceByKey.get(row.session_key);
              const entry = parseEntry(row.entry_json);
              if (entry.sessionId !== row.current_session_id) {
                throw new Error(
                  "Session identity is inconsistent; migration retained the original row.",
                );
              }
              let acp: LegacyAcpExecutionSelection | undefined;
              if (source) {
                if (copied.has(source.session_key)) {
                  throw new Error(
                    "ACP selection has multiple owning database candidates; its shared source was retained.",
                  );
                }
                if (source.session_id && source.session_id !== entry.sessionId) {
                  throw new Error(
                    "ACP source and session generation differ; migration retained both.",
                  );
                }
                const options = source.runtime_options_json
                  ? parseEntry(source.runtime_options_json)
                  : {};
                acp = {
                  backend: source.backend,
                  agent: source.agent,
                  ...(typeof options.model === "string" ? { model: options.model } : {}),
                };
              }
              const result = migrateSessionExecutionSelection({
                entry,
                acp,
                classifyExecutor: (id) => resolveExecutionSelectionExecutorKind(params.cfg, id),
                defaultProvider: resolveDefaultModelForAgent({
                  cfg: params.cfg,
                  agentId: target.agentId,
                }).provider,
              });
              if (result.changed) {
                executeSqliteQuerySync(
                  database,
                  db
                    .updateTable("session_nodes")
                    .set({ entry_json: JSON.stringify(result.entry) })
                    .where("session_key", "=", row.session_key)
                    .where("entry_json", "=", row.entry_json),
                );
              }
              if (source) copied.add(source.session_key);
            }
            maintenance.assertOwned();
          };
          if (version < OPENCLAW_AGENT_SCHEMA_VERSION) {
            ensureOpenClawAgentSchema(
              database,
              target.agentId,
              target.path,
              OPENCLAW_AGENT_SCHEMA_VERSION,
              migrate,
            );
          } else {
            // A retry validates the committed target without rewriting its accepted intent.
            runSqliteImmediateTransactionSync(database, migrate);
          }
        } finally {
          clearNodeSqliteKyselyCacheForDatabase(database);
          database.close();
        }
      }
      if (sources.some((source) => !copied.has(source.session_key))) {
        throw new Error(
          "ACP selections have no verified owning session; original shared selections were retained.",
        );
      }
      maintenance.assertOwned();
      const repaired = repairOpenClawStateDatabaseSchema({ env }, (database) => {
        maintenance.assertOwnedInTransaction(database);
        const db = getNodeSqliteKysely<LegacySharedDatabase>(database);
        if (tableHasColumn(database, "acp_sessions", "backend")) {
          const currentSources = executeSqliteQuerySync(
            database,
            db.selectFrom("acp_sessions").selectAll(),
          ).rows;
          if (!isDeepStrictEqual(currentSources, sources)) {
            throw new Error("ACP migration source changed before retirement; retry Doctor.");
          }
          for (const source of sources) {
            const options = source.runtime_options_json
              ? parseEntry(source.runtime_options_json)
              : {};
            delete options.model;
            executeSqliteQuerySync(
              database,
              db
                .updateTable("acp_sessions")
                .set({
                  runtime_options_json: Object.keys(options).length
                    ? JSON.stringify(options)
                    : null,
                })
                .where("session_key", "=", source.session_key),
            );
          }
          // sqlite-allow-raw -- Versioned retirement occurs only after every owning agent committed its pair.
          database.exec(
            "DROP INDEX IF EXISTS idx_acp_sessions_agent_activity; ALTER TABLE acp_sessions DROP COLUMN backend; ALTER TABLE acp_sessions DROP COLUMN agent;",
          );
        }
        for (const registration of registered) {
          if (
            discovery.targets.some(
              (target) =>
                target.agentId === registration.agentId && target.path === registration.path,
            )
          ) {
            executeSqliteQuerySync(
              database,
              db
                .updateTable("agent_databases")
                .set({ schema_version: OPENCLAW_AGENT_SCHEMA_VERSION })
                .where("agent_id", "=", registration.agentId)
                .where("path", "=", registration.storedPath),
            );
          }
        }
        maintenance.assertOwnedInTransaction(database);
      });
      if (repaired.warnings.length) throw new Error(repaired.warnings.join("\n"));
      return {
        changes: [
          `Preserved execution selections in ${discovery.targets.length} agent database(s). Verified backups: ${backupDirectory}`,
        ],
        warnings: [],
      };
    },
  );
}
