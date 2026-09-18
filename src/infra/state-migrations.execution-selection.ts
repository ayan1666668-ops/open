import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { selectAcpSessionRowForStoreEntry } from "../acp/runtime/session-meta-keys.js";
import { listCliRuntimeModelBackendBindings } from "../agents/cli-backends.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import {
  resolveTargetSqliteOptions,
  resolveTargetSqlitePath,
} from "../commands/doctor-session-sqlite-readers.js";
import { isSessionSqliteMigrationWarning } from "../commands/doctor-session-sqlite-types.js";
import { runDoctorSessionSqlite } from "../commands/doctor-session-sqlite.js";
import {
  migrateSessionExecutionSelection,
  type LegacyAcpExecutionSelection,
} from "../commands/doctor/shared/session-execution-selection.js";
import { resolveStateDir } from "../config/paths.js";
import { normalizePersistedSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import {
  resolveConfiguredAgentDatabaseTargets,
  resolveSessionStoreTargets,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExecutionSelectionExecutorKind } from "../model-picker/apply-session-model-selection.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { registerAgentDatabaseMaintenanceAccess } from "../state/openclaw-agent-db-lease.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { assertOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-maintenance.js";
import { ensureOpenClawAgentDatabasePermissions } from "../state/openclaw-agent-db-permissions.js";
import { readOpenClawAgentDatabaseRegistryRows } from "../state/openclaw-agent-db-registry-listing.js";
import { assertSupportedAgentSchemaVersion } from "../state/openclaw-agent-db-schema-read.js";
import { ensureOpenClawAgentSchema } from "../state/openclaw-agent-db-schema.js";
import type { DB as AgentDatabase } from "../state/openclaw-agent-db.generated.js";
import { preflightOpenClawDatabaseSchemas } from "../state/openclaw-database-preflight.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_STATE_STRICT_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import { assertSupportedStateSchemaVersion } from "../state/openclaw-state-db-schema-version.js";
import {
  repairOpenClawStateDatabaseSchema,
  repairOpenClawStateDatabaseSchemaIfNeeded,
} from "../state/openclaw-state-db.js";
import {
  resolveOpenClawRegisteredAgentDatabasePath,
  resolveOpenClawAgentDatabaseStoredPath,
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
import { configureSqliteConnectionPragmas } from "./sqlite-wal.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "./sqlite-worker-identity.js";
import { discoverAgentDatabaseMigrationTargets } from "./state-migrations.media-persistence-targets.js";
import type { MigrationMessages } from "./state-migrations.types.js";

type LegacySharedDatabase = {
  agent_databases: {
    agent_id: string;
    path: string;
    schema_version: number;
    last_seen_at: number;
    size_bytes: number | null;
  };
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
  if (!isRecord(value)) {
    throw new Error("Session migration requires an object row.");
  }
  return value;
}

async function backUpMigrationDatabase(
  sourcePath: string,
  targetPath: string,
  assertOwned: () => void,
) {
  assertOwned();
  const identity = readDatabasePathIdentitySync(sourcePath);
  const assertCurrent = () => {
    assertOwned();
    assertExistingDatabaseIdentity(sourcePath, identity.key);
  };
  await createVerifiedSqliteSnapshot({
    sourcePath,
    targetPath,
    preserveRowIds: true,
    beforePublish: assertCurrent,
  });
  assertCurrent();
  return assertCurrent;
}

function createSelectionBackupDirectory(env: NodeJS.ProcessEnv): string {
  const root = path.join(resolveStateDir(env), "backups", "execution-selection");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(root, "migration-"));
}

async function prepareLegacyMaintenanceTables(
  sharedPath: string,
  env: NodeJS.ProcessEnv,
  scope: OpenClawDatabaseMaintenanceScope,
) {
  const database = openNodeSqliteDatabase(sharedPath, { readOnly: true });
  let version: number;
  try {
    version = assertSupportedStateSchemaVersion(database, sharedPath);
  } finally {
    database.close();
  }
  if (version >= OPENCLAW_STATE_STRICT_SCHEMA_VERSION) {
    return undefined;
  }
  const owner = scope.createSchemaFenceDelegate({
    databasePath: sharedPath,
    actorId: "execution-selection-maintenance-prerequisite",
  });
  if (!owner) {
    throw new Error("Doctor maintenance prerequisite has no live schema owner.");
  }
  try {
    const directory = createSelectionBackupDirectory(env);
    const assertCurrent = await backUpMigrationDatabase(
      sharedPath,
      path.join(directory, "shared.sqlite"),
      () => {
        scope.assertAdmission();
        if (owner.closed) {
          throw new Error("Doctor schema owner closed before migration.");
        }
      },
    );
    const result = repairOpenClawStateDatabaseSchema(
      { env },
      (db) => {
        assertCurrent();
        if (assertSupportedStateSchemaVersion(db, sharedPath) !== version) {
          throw new Error("Shared schema changed after the verified migration backup.");
        }
      },
      "lease-prerequisite",
    );
    if (result.warnings.length) {
      throw new Error(result.warnings.join("\n"));
    }
    return { directory, assertCurrent, changes: result.changes, release: () => owner.release() };
  } catch (error) {
    owner.release();
    throw error;
  }
}

/** Copy execution intent under Doctor's stopped-writer authority before retiring its sources. */
export async function migrateLegacyExecutionSelections(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  configuredAgentDatabaseTargets?: readonly { agentId: string; path: string }[];
}): Promise<MigrationMessages> {
  const env = params.env ?? process.env;
  const sharedPath = resolveOpenClawStateSqlitePath(env);
  if (!fs.existsSync(sharedPath)) {
    return { changes: [], warnings: [] };
  }
  const scope = getOpenClawDatabaseMaintenanceScope();
  if (!scope?.ownsSchemaMaintenance) {
    const preflight = await preflightOpenClawDatabaseSchemas({
      env,
      agentAdmissionConfig: params.cfg,
      configuredAgentDatabaseTargets:
        params.configuredAgentDatabaseTargets ??
        ((registeredDatabases) =>
          resolveConfiguredAgentDatabaseTargets(params.cfg, { env, registeredDatabases })),
    });
    if (
      !preflight.pendingMigrations?.length &&
      !preflight.incompatible.length &&
      !preflight.indeterminate.length &&
      !preflight.agentRefusals?.length
    ) {
      return repairOpenClawStateDatabaseSchemaIfNeeded({ env });
    }
    throw new Error("Execution selection migration requires stopped-writer Doctor maintenance.");
  }
  scope.assertAdmission();
  const prerequisite = await prepareLegacyMaintenanceTables(sharedPath, env, scope);
  try {
    return await withAgentDatabaseMaintenanceLease(
      { env, schemaPolicy: "existing" },
      async (maintenance) => {
        const shared = openNodeSqliteDatabase(sharedPath, { readOnly: true });
        let registered: Array<{ agentId: string; path: string }>;
        let sources: Array<LegacySharedDatabase["acp_sessions"]>;
        let sharedVersion: number;
        try {
          sharedVersion = readSqliteUserVersion(shared);
          const db = getNodeSqliteKysely<LegacySharedDatabase>(shared);
          registered = readOpenClawAgentDatabaseRegistryRows(shared, sharedPath).map((row) => ({
            agentId: row.agent_id,
            path: resolveOpenClawRegisteredAgentDatabasePath(sharedPath, row.path),
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
        if (sharedVersion >= 18 && !pending) {
          return repairOpenClawStateDatabaseSchema({ env });
        }
        const backupDirectory = prerequisite?.directory ?? createSelectionBackupDirectory(env);
        const assertSharedCurrent =
          prerequisite?.assertCurrent ??
          (await backUpMigrationDatabase(
            sharedPath,
            path.join(backupDirectory, "shared.sqlite"),
            () => maintenance.assertOwned(),
          ));
        const sourceByKey = new Map(sources.map((row) => [row.session_key, row]));
        const copied = new Map<string, string>();
        const agentFences = new Map<string, () => void>();
        const migratedTargets = new Map(
          discovery.targets.map((target) => [
            target.path,
            { agentId: target.agentId, path: target.path },
          ]),
        );
        const sourceDatabase = openNodeSqliteDatabase(path.join(backupDirectory, "shared.sqlite"), {
          readOnly: true,
        });
        try {
          const classifyExecutor = (id: string) =>
            resolveExecutionSelectionExecutorKind(params.cfg, id);
          const cliRuntimeProviders = new Map(
            listCliRuntimeModelBackendBindings({
              config: params.cfg,
              includeSetupRegistry: true,
            }).map(({ runtime, provider }) => [runtime, provider]),
          );
          const defaultProviders = new Map<string, string>();
          const convert = (entry: unknown, sessionKey: string, databaseAgentId: string) => {
            const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? databaseAgentId;
            let defaultProvider = defaultProviders.get(agentId);
            if (!defaultProvider) {
              defaultProvider = resolveDefaultModelForAgent({ cfg: params.cfg, agentId }).provider;
              defaultProviders.set(agentId, defaultProvider);
            }
            const binding = normalizePersistedSessionEntryShape(entry, { sessionKey });
            if (!binding) {
              throw new Error("Session binding is invalid; original selection retained.");
            }
            const sourceKey = sources.length
              ? selectAcpSessionRowForStoreEntry(
                  sourceDatabase,
                  sessionKey,
                  agentId,
                  params.cfg,
                  binding,
                )?.session_key
              : undefined;
            const source = sourceKey ? sourceByKey.get(sourceKey) : undefined;
            const options = source?.runtime_options_json
              ? parseEntry(source.runtime_options_json)
              : {};
            const acp: LegacyAcpExecutionSelection | undefined = source
              ? {
                  backend: source.backend,
                  agent: source.agent,
                  ...(typeof options.model === "string" ? { model: options.model } : {}),
                }
              : undefined;
            return {
              ...migrateSessionExecutionSelection({
                entry,
                acp,
                classifyExecutor,
                defaultProvider,
                cliRuntimeProviders,
              }),
              source,
            };
          };
          const migrateRows = (
            database: DatabaseSync,
            target: { agentId: string; path: string },
            assertCurrent: () => void,
          ) => {
            assertCurrent();
            const db = getNodeSqliteKysely<Pick<AgentDatabase, "session_nodes">>(database);
            const rows = executeSqliteQuerySync(
              database,
              db
                .selectFrom("session_nodes")
                .select(["session_key", "current_session_id", "entry_json"]),
            ).rows;
            const targetPath = fs.realpathSync(target.path);
            for (const row of rows) {
              if (row.entry_json === "{}") {
                continue;
              }
              const entry = parseEntry(row.entry_json);
              if (entry.sessionId !== row.current_session_id) {
                throw new Error(
                  "Session identity is inconsistent; migration retained the original row.",
                );
              }
              const result = convert(entry, row.session_key, target.agentId);
              if (result.source) {
                const owner = copied.get(result.source.session_key);
                if (owner && owner !== targetPath) {
                  throw new Error(
                    "ACP selection has multiple owning database candidates; its shared source was retained.",
                  );
                }
              }
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
              if (result.source) {
                copied.set(result.source.session_key, targetPath);
              }
            }
            assertCurrent();
          };
          for (const [index, target] of discovery.targets.entries()) {
            const assertAgentCurrent = await backUpMigrationDatabase(
              target.path,
              path.join(backupDirectory, `agent-${index}.sqlite`),
              () => maintenance.assertOwned(),
            );
            agentFences.set(target.path, assertAgentCurrent);
            const database = openNodeSqliteDatabase(target.path);
            try {
              assertAgentCurrent();
              assertOpenClawAgentDatabaseOwner(database, {
                agentId: target.agentId,
                pathname: target.path,
              });
              assertSupportedAgentSchemaVersion(database, target.path);
              const version = readSqliteUserVersion(database);
              const migrate = () => migrateRows(database, target, assertAgentCurrent);
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
            const stores = resolveSessionStoreTargets(
              params.cfg,
              { allAgents: true },
              { env, registeredDatabases: registered },
            );
            for (const store of stores) {
              if (store.storePath.endsWith(".sqlite") || !fs.existsSync(store.storePath)) {
                continue;
              }
              const options = resolveTargetSqliteOptions(store, env);
              const pathname = resolveTargetSqlitePath(store, env);
              let assertCurrent = agentFences.get(pathname);
              if (!assertCurrent && fs.existsSync(pathname)) {
                assertCurrent = await backUpMigrationDatabase(
                  pathname,
                  path.join(backupDirectory, `import-${agentFences.size}.sqlite`),
                  () => maintenance.assertOwned(),
                );
              }
              maintenance.assertOwned();
              ensureOpenClawAgentDatabasePermissions(pathname, options);
              const db = openNodeSqliteDatabase(pathname);
              const identity = readDatabasePathIdentitySync(pathname);
              const assertImportCurrent =
                assertCurrent ??
                (() => {
                  maintenance.assertOwned();
                  assertExistingDatabaseIdentity(pathname, identity.key);
                });
              agentFences.set(pathname, assertImportCurrent);
              const target = { path: pathname, agentId: options.agentId };
              migratedTargets.set(pathname, target);
              let wal: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
              try {
                assertImportCurrent();
                registerOpenClawAgentDatabaseIdentity(db);
                registerAgentDatabaseMaintenanceAccess(db);
                ensureOpenClawAgentSchema(
                  db,
                  target.agentId,
                  pathname,
                  OPENCLAW_AGENT_SCHEMA_VERSION,
                  () => migrateRows(db, target, assertImportCurrent),
                );
                wal = configureSqliteConnectionPragmas(db, {
                  databasePath: pathname,
                  databaseLabel: "Doctor prerequisite session import",
                  foreignKeys: true,
                  synchronous: "NORMAL",
                });
                const report = await runDoctorSessionSqlite({
                  cfg: params.cfg,
                  env,
                  mode: "import",
                  agent: store.agentId,
                  store: store.storePath,
                  importDatabase: {
                    database: { db, path: pathname, agentId: target.agentId, walMaintenance: wal },
                    assertCurrent: assertImportCurrent,
                    transformEntry(entry, key) {
                      const converted = convert(entry, key, store.agentId);
                      const result = normalizePersistedSessionEntryShape(converted.entry, {
                        sessionKey: key,
                      });
                      if (!result) {
                        throw new Error(
                          "Legacy session conversion is invalid; original source retained.",
                        );
                      }
                      return result;
                    },
                  },
                });
                assertImportCurrent();
                const failures = report.targets
                  .flatMap((reportedTarget) => reportedTarget.issues)
                  .filter((issue) => !isSessionSqliteMigrationWarning(issue));
                if (failures.length) {
                  throw new Error(failures.map((issue) => issue.message).join("\n"));
                }
                runSqliteImmediateTransactionSync(db, () =>
                  migrateRows(db, target, assertImportCurrent),
                );
              } finally {
                try {
                  wal?.close();
                } finally {
                  clearNodeSqliteKyselyCacheForDatabase(db);
                  if (db.isOpen) {
                    db.close();
                  }
                }
              }
            }
          }
          if (sources.some((source) => !copied.has(source.session_key))) {
            throw new Error(
              "ACP selections have no verified owning session; original shared selections were retained.",
            );
          }
          assertSharedCurrent();
          const repaired = repairOpenClawStateDatabaseSchema({ env }, (database) => {
            assertSharedCurrent();
            for (const assertCurrent of agentFences.values()) {
              assertCurrent();
            }
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
            for (const target of migratedTargets.values()) {
              const values = {
                agent_id: target.agentId,
                path: resolveOpenClawAgentDatabaseStoredPath(sharedPath, target.path),
                schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
                last_seen_at: Date.now(),
                size_bytes: fs.statSync(target.path).size,
              };
              executeSqliteQuerySync(
                database,
                db
                  .insertInto("agent_databases")
                  .values(values)
                  .onConflict((conflict) =>
                    conflict.columns(["agent_id", "path"]).doUpdateSet(values),
                  ),
              );
            }
            maintenance.assertOwnedInTransaction(database);
            assertSharedCurrent();
          });
          if (repaired.warnings.length) {
            throw new Error(repaired.warnings.join("\n"));
          }
          return {
            changes: [
              ...(prerequisite?.changes ?? []),
              ...repaired.changes,
              `Preserved execution selections in ${migratedTargets.size} agent database(s). Verified backups: ${backupDirectory}`,
            ],
            warnings: [],
          };
        } finally {
          clearNodeSqliteKyselyCacheForDatabase(sourceDatabase);
          sourceDatabase.close();
        }
      },
    );
  } finally {
    prerequisite?.release();
  }
}
