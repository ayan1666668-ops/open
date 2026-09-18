import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { makeTempDir } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { acquireGatewayMaintenanceCoordinator } from "../infra/state-database-coordinator.js";
import { migrateLegacyExecutionSelections } from "../infra/state-migrations.execution-selection.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase as openOpenClawAgentDatabaseRuntime,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import { removeCanonicalValidationFromHistoricalAgentFixture } from "./openclaw-agent-db.test-support.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

export const agentDbTempDirs: string[] = [];
let sharedStateDatabaseTemplatePath: string | undefined;
let currentWorkerAgentDatabaseTemplatePath: string | undefined;
let v13WorkerAgentDatabaseTemplatePath: string | undefined;

export function createTempStateDir(): string {
  return makeTempDir(agentDbTempDirs, "openclaw-agent-db-");
}

function ensureSharedStateDatabaseTemplate(): string {
  if (sharedStateDatabaseTemplatePath) {
    return sharedStateDatabaseTemplatePath;
  }
  const stateDir = makeTempDir(agentDbTempDirs, "openclaw-agent-db-shared-state-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const database = openOpenClawStateDatabase({ env });
  sharedStateDatabaseTemplatePath = database.path;
  closeOpenClawStateDatabaseForTest();
  return sharedStateDatabaseTemplatePath;
}

function materializeSharedStateDatabase(env: NodeJS.ProcessEnv | undefined): void {
  const stateDatabasePath = resolveOpenClawStateSqlitePath(env);
  if (!fs.existsSync(stateDatabasePath)) {
    // Agent schema tests own the per-agent database. Seed the shared registry
    // from one real closed database instead of rebuilding its full schema per case.
    fs.mkdirSync(path.dirname(stateDatabasePath), { recursive: true });
    fs.copyFileSync(ensureSharedStateDatabaseTemplate(), stateDatabasePath);
  }
}

export function openOpenClawAgentDatabase(
  options: Parameters<typeof openOpenClawAgentDatabaseRuntime>[0],
) {
  materializeSharedStateDatabase(options.env);
  return openOpenClawAgentDatabaseRuntime(options);
}

export function ensureCurrentWorkerAgentDatabaseTemplate(): string {
  if (currentWorkerAgentDatabaseTemplatePath) {
    return currentWorkerAgentDatabaseTemplatePath;
  }
  const stateDir = makeTempDir(agentDbTempDirs, "openclaw-agent-db-current-worker-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const template = openOpenClawAgentDatabase({ agentId: "worker-1", env });
  const templatePath = template.path;
  template.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();

  const walPath = `${templatePath}-wal`;
  if (fs.existsSync(walPath) && fs.statSync(walPath).size > 0) {
    throw new Error("current worker agent database template retained WAL content");
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    fs.rmSync(`${templatePath}${suffix}`, { force: true });
  }

  const { DatabaseSync } = requireNodeSqlite();
  const verified = new DatabaseSync(templatePath, { readOnly: true });
  try {
    const integrity = verified.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: unknown }
      | undefined;
    if (integrity?.integrity_check !== "ok") {
      throw new Error("current worker agent database template failed integrity check");
    }
    if (verified.prepare("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error("current worker agent database template failed foreign key check");
    }
    if (readSqliteNumberPragma(verified, "user_version") !== OPENCLAW_AGENT_SCHEMA_VERSION) {
      throw new Error("current worker agent database template has the wrong schema version");
    }
    const owner = verified
      .prepare("SELECT role, agent_id FROM schema_meta WHERE meta_key = 'primary'")
      .get();
    if (!owner || (owner as { agent_id?: unknown }).agent_id !== "worker-1") {
      throw new Error("current worker agent database template has the wrong owner");
    }
  } finally {
    verified.close();
  }
  currentWorkerAgentDatabaseTemplatePath = templatePath;
  return templatePath;
}

export function materializeCurrentWorkerAgentDatabase(stateDir: string): string {
  const options = {
    agentId: "worker-1",
    env: { OPENCLAW_STATE_DIR: stateDir },
  } as const;
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.copyFileSync(
    ensureCurrentWorkerAgentDatabaseTemplate(),
    databasePath,
    fs.constants.COPYFILE_EXCL,
  );
  return databasePath;
}

export function ensureV13WorkerAgentDatabaseTemplate(): string {
  if (v13WorkerAgentDatabaseTemplatePath) {
    return v13WorkerAgentDatabaseTemplatePath;
  }
  // Legacy migration cases mutate independent clones; keep one closed, verified v13
  // baseline so the test-only reverse migration is not repeated for every case.
  const stateDir = createTempStateDir();
  const databasePath = resolveOpenClawAgentSqlitePath({
    agentId: "worker-1",
    env: { OPENCLAW_STATE_DIR: stateDir },
  });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.copyFileSync(
    ensureCurrentWorkerAgentDatabaseTemplate(),
    databasePath,
    fs.constants.COPYFILE_EXCL,
  );
  downgradeCurrentAgentDatabaseToV13(databasePath);

  const { DatabaseSync } = requireNodeSqlite();
  const checkpoint = new DatabaseSync(databasePath);
  try {
    checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    checkpoint.close();
  }
  const walPath = `${databasePath}-wal`;
  if (fs.existsSync(walPath) && fs.statSync(walPath).size > 0) {
    throw new Error("v13 worker agent database template retained WAL content");
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    fs.rmSync(`${databasePath}${suffix}`, { force: true });
  }

  const verified = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(verified.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(verified.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(readSqliteNumberPragma(verified, "user_version")).toBe(13);
    expect(
      verified
        .prepare(
          "SELECT role, agent_id, schema_version FROM schema_meta WHERE meta_key = 'primary'",
        )
        .get(),
    ).toEqual({ role: "agent", agent_id: "worker-1", schema_version: 13 });
    expect(
      verified
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('sessions', 'session_entries', 'session_routes') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "session_entries" }, { name: "session_routes" }, { name: "sessions" }]);
    expect(
      verified
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('session_nodes', 'session_pending_inputs', 'session_input_completions')",
        )
        .all(),
    ).toEqual([]);
  } finally {
    verified.close();
  }
  v13WorkerAgentDatabaseTemplatePath = databasePath;
  return databasePath;
}

export function materializeV13WorkerAgentDatabase(stateDir: string): string {
  const options = {
    agentId: "worker-1",
    env: { OPENCLAW_STATE_DIR: stateDir },
  } as const;
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.copyFileSync(ensureV13WorkerAgentDatabaseTemplate(), databasePath, fs.constants.COPYFILE_EXCL);
  return databasePath;
}

export async function migrateAndOpenLegacyAgentDatabaseForTest(
  options: Parameters<typeof openOpenClawAgentDatabase>[0],
) {
  // Prepare the unrelated registry before the real maintenance lease's acquisition budget.
  materializeSharedStateDatabase(options.env);
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const coordinator = acquireGatewayMaintenanceCoordinator({
    databasePath: resolveOpenClawStateSqlitePath(options.env),
  });
  const resources = createOpenClawDatabaseMaintenanceScope(coordinator.createSchemaFenceDelegate);
  try {
    const result = await resources.run(() =>
      migrateLegacyExecutionSelections({
        cfg: { agents: { entries: { [options.agentId]: {} } } },
        env: options.env,
        configuredAgentDatabaseTargets: [{ agentId: options.agentId, path: pathname }],
      }),
    );
    if (result.warnings.length) {
      throw new Error(result.warnings.join("\n"));
    }
  } finally {
    await resources.close();
    coordinator.release();
  }
  return openOpenClawAgentDatabase(options);
}

function downgradeCurrentAgentDatabaseToV13(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    removeCanonicalValidationFromHistoricalAgentFixture(database);
    database.exec(`
      PRAGMA foreign_keys = OFF;
      PRAGMA legacy_alter_table = OFF;
      DROP TABLE session_participants;
      DROP TABLE session_pending_inputs;
      DROP TABLE session_input_completions;
      DROP INDEX IF EXISTS idx_agent_session_windows_updated_at;
      DROP INDEX IF EXISTS idx_agent_session_windows_created_at;
      DROP INDEX IF EXISTS idx_agent_session_windows_conversation;
      ALTER TABLE session_windows RENAME TO sessions;
      CREATE TABLE sessions_legacy (
        session_id TEXT NOT NULL PRIMARY KEY,
        session_key TEXT NOT NULL,
        session_scope TEXT NOT NULL DEFAULT 'conversation' CHECK (session_scope IN ('conversation', 'shared-main', 'group', 'channel')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        transcript_updated_at INTEGER DEFAULT NULL,
        transcript_observed_at INTEGER DEFAULT NULL,
        session_entry_provenance INTEGER NOT NULL DEFAULT 0 CHECK (session_entry_provenance IN (0, 1)),
        acp_owned INTEGER NOT NULL DEFAULT 0 CHECK (acp_owned IN (0, 1)),
        plugin_owner_id TEXT,
        hook_external_content_source TEXT CHECK (hook_external_content_source IS NULL OR hook_external_content_source IN ('gmail', 'webhook')),
        started_at INTEGER,
        ended_at INTEGER,
        status TEXT CHECK (status IS NULL OR status IN ('running', 'done', 'failed', 'killed', 'timeout')),
        chat_type TEXT CHECK (chat_type IS NULL OR chat_type IN ('direct', 'group', 'channel')),
        channel TEXT,
        account_id TEXT,
        primary_conversation_id TEXT,
        model_provider TEXT,
        model TEXT,
        agent_harness_id TEXT,
        parent_session_key TEXT,
        spawned_by TEXT,
        display_name TEXT,
        FOREIGN KEY (primary_conversation_id) REFERENCES conversations(conversation_id) ON DELETE SET NULL
      ) STRICT;
      INSERT INTO sessions_legacy (
        session_id, session_key, session_scope, created_at, updated_at,
        transcript_updated_at, transcript_observed_at, session_entry_provenance,
        acp_owned, plugin_owner_id, hook_external_content_source, started_at,
        ended_at, status, chat_type, channel, account_id, primary_conversation_id,
        model_provider, model, agent_harness_id, parent_session_key, spawned_by,
        display_name
      )
      SELECT
        session_id, session_key, session_scope, created_at, updated_at,
        transcript_updated_at, transcript_observed_at, session_entry_provenance,
        acp_owned, plugin_owner_id, hook_external_content_source, started_at,
        ended_at, status, chat_type, channel, account_id, primary_conversation_id,
        model_provider, model, agent_harness_id, parent_session_key, spawned_by,
        display_name
      FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_legacy RENAME TO sessions;
      CREATE INDEX idx_agent_sessions_updated_at ON sessions(updated_at DESC, session_id);
      CREATE INDEX idx_agent_sessions_created_at ON sessions(created_at DESC, session_id);
      CREATE INDEX idx_agent_sessions_conversation
        ON sessions(primary_conversation_id, updated_at DESC, session_id)
        WHERE primary_conversation_id IS NOT NULL;
      CREATE TABLE session_routes (
        session_key TEXT NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX idx_agent_session_routes_session_id ON session_routes(session_id);
      CREATE TABLE session_entries (
        session_key TEXT NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT CHECK (status IS NULL OR status IN ('running', 'done', 'failed', 'killed', 'timeout')),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX idx_agent_session_entries_updated_at
        ON session_entries(updated_at DESC, session_key);
      CREATE INDEX idx_agent_session_entries_session_updated
        ON session_entries(session_id, updated_at DESC, session_key);
      CREATE INDEX idx_agent_session_entries_status
        ON session_entries(status, session_key) WHERE status IS NOT NULL;
      CREATE TABLE session_members_v13 (
        session_key TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        added_by TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (session_key, identity_id),
        FOREIGN KEY (session_key) REFERENCES session_entries(session_key) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO session_members_v13 SELECT * FROM session_members;
      DROP TABLE session_members;
      ALTER TABLE session_members_v13 RENAME TO session_members;
      CREATE INDEX idx_agent_session_members_identity
        ON session_members(identity_id, session_key);
      ALTER TABLE transcript_rewrite_watermarks RENAME TO session_transcript_generations;
      CREATE TABLE board_tabs_v13 (
        session_key TEXT NOT NULL,
        tab_id TEXT NOT NULL,
        title TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        chat_dock TEXT NOT NULL DEFAULT 'right' CHECK (chat_dock IN ('left', 'right', 'bottom', 'hidden')),
        created_by TEXT NOT NULL CHECK (created_by IN ('user', 'agent')),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        PRIMARY KEY (session_key, tab_id)
      ) STRICT;
      INSERT INTO board_tabs_v13 SELECT * FROM board_tabs;
      DROP TABLE board_tabs;
      ALTER TABLE board_tabs_v13 RENAME TO board_tabs;
      DROP TABLE heartbeat_outcomes;
      CREATE TABLE heartbeat_outcomes (
        session_key TEXT NOT NULL PRIMARY KEY,
        run_session_key TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('progress', 'done', 'blocked', 'needs_attention')),
        summary TEXT NOT NULL,
        response_reason TEXT,
        priority TEXT CHECK (priority IS NULL OR priority IN ('low', 'normal', 'high')),
        next_check TEXT,
        task_names_json TEXT,
        wake_source TEXT,
        wake_reason TEXT,
        occurred_at INTEGER NOT NULL,
        context_run_id TEXT,
        context_claimed_at INTEGER,
        updated_at INTEGER NOT NULL
      ) STRICT;
      DROP TABLE session_nodes;
      PRAGMA user_version = 13;
      UPDATE schema_meta SET schema_version = 13 WHERE meta_key = 'primary';
    `);
  } finally {
    database.close();
  }
}

export function seedVersion1MemoryAgentDatabase(
  databasePath: string,
  options: { malformedPathFts?: boolean } = {},
): void {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT,
        app_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO schema_meta VALUES ('primary', 'agent', 1, 'worker-1', NULL, 1, 1);
      CREATE TABLE memory_index_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL
      );
      INSERT INTO memory_index_state VALUES (1, 7);
      CREATE TABLE memory_index_sources (
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (path, source)
      );
      INSERT INTO memory_index_sources (rowid, path, source, hash, mtime, size)
      VALUES
        (41, 'shared.md', 'memory', 'memory-hash', 10, 20),
        (84, 'shared.md', 'sessions', 'session-hash', 30, 40);
      CREATE TABLE memory_index_chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO memory_index_chunks VALUES (
        'sentinel', 'shared.md', 'memory', 1, 1, 'chunk-hash', 'model', 'body', '[]', 1
      );
      CREATE TRIGGER memory_index_sources_revision_after_insert
      AFTER INSERT ON memory_index_sources
      BEGIN UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END;
      CREATE TRIGGER memory_index_sources_revision_after_update
      AFTER UPDATE ON memory_index_sources
      BEGIN UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END;
      CREATE TRIGGER memory_index_sources_revision_after_delete
      AFTER DELETE ON memory_index_sources
      BEGIN UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END;
    `);
    if (options.malformedPathFts) {
      db.exec(`
        CREATE TABLE memory_index_paths_fts (wrong_column TEXT);
        INSERT INTO memory_index_paths_fts VALUES ('keep-derived-row');
        CREATE TRIGGER memory_index_paths_fts_after_delete
        AFTER DELETE ON memory_index_sources BEGIN SELECT 1; END;
      `);
      return;
    }
    db.exec(`
      CREATE VIRTUAL TABLE memory_index_paths_fts USING fts5(path, source UNINDEXED);
      INSERT INTO memory_index_paths_fts (path, source)
      VALUES ('shared.md', 'memory'), ('shared.md', 'sessions');
      CREATE TRIGGER memory_index_paths_fts_after_insert
      AFTER INSERT ON memory_index_sources
      BEGIN
        INSERT INTO memory_index_paths_fts (path, source) VALUES (NEW.path, NEW.source);
      END;
      CREATE TRIGGER memory_index_paths_fts_after_update
      AFTER UPDATE OF path, source ON memory_index_sources
      BEGIN
        DELETE FROM memory_index_paths_fts
        WHERE path = OLD.path AND source = OLD.source;
        INSERT INTO memory_index_paths_fts (path, source) VALUES (NEW.path, NEW.source);
      END;
      CREATE TRIGGER memory_index_paths_fts_after_delete
      AFTER DELETE ON memory_index_sources
      BEGIN
        DELETE FROM memory_index_paths_fts
        WHERE path = OLD.path AND source = OLD.source;
      END;
    `);
  } finally {
    db.close();
  }
}
