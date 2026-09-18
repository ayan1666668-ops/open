import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { FIRST_USE_STATE_TABLES } from "./openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { createSqliteSchemaShapeFromSql } from "./sqlite-schema-shape.test-support.js";

const V2026_7_1_2_STATE_FIXTURE_URL = new URL(
  "../../test/fixtures/sqlite/openclaw-state-v2026.7.1-2.sqlite.gz",
  import.meta.url,
);
export const V2026_7_1_2_STATE_FIXTURE_GZIP_SHA256 =
  "c775499d9a46462ae2368090a0c4ec75877784c40694046dd3af63df77b8737c";
export const V2026_7_1_2_STATE_FIXTURE_RAW_SHA256 =
  "8511bb91f02d104f818c70b08397a678045d04741c931b0ee7ce6650b5519e85";
export const V2026_7_1_2_STATE_FIXTURE_SCHEMA_SHA256 =
  "f2fd6488e283470718547fb45886f04cc940b1de798e52fbf34a3a3408ae25e4";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashSqliteSchema(database: DatabaseSync): string {
  const schema = database
    .prepare(
      `SELECT type, name, tbl_name, sql
         FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    )
    .all();
  return sha256(JSON.stringify(schema));
}

export function materializeV2026_7_1_2StateDatabase(stateDir: string): {
  compressedSha256: string;
  databasePath: string;
  rawSha256: string;
} {
  const compressed = fs.readFileSync(V2026_7_1_2_STATE_FIXTURE_URL);
  const raw = gunzipSync(compressed);
  const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.writeFileSync(databasePath, raw);
  return {
    compressedSha256: sha256(compressed),
    databasePath,
    rawSha256: sha256(raw),
  };
}

export function markStateDatabaseAsPreviousAppVersion(database: DatabaseSync): void {
  database
    .prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
    .run("2026.7.0");
}

export function createInitialStateSchemaShape() {
  const shape = createSqliteSchemaShapeFromSql(
    new URL("./openclaw-state-schema.sql", import.meta.url),
  );
  for (const tableName of FIRST_USE_STATE_TABLES) {
    delete shape[tableName];
  }
  return shape;
}

export function createOlderV6StateSchemaWithoutWorkerSshFallbackPorts(): string {
  const startMarker = "CREATE TABLE IF NOT EXISTS worker_environment_ssh_fallback_ports (";
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(startMarker);
  const endMarker = "\n) STRICT;";
  const end = start >= 0 ? OPENCLAW_STATE_SCHEMA_SQL.indexOf(endMarker, start) : -1;
  if (start < 0 || end < 0) {
    throw new Error("worker SSH fallback port schema block is missing");
  }
  return `${OPENCLAW_STATE_SCHEMA_SQL.slice(0, start)}${OPENCLAW_STATE_SCHEMA_SQL.slice(
    end + endMarker.length,
  )}`;
}

export function replaceManagedImageRecordsWithLegacyTable(
  database: DatabaseSync,
  options: { withRow: boolean },
): void {
  database.exec(`
    DROP TABLE managed_outgoing_image_records;
    CREATE TABLE managed_outgoing_image_records (
      attachment_id TEXT NOT NULL PRIMARY KEY,
      session_key TEXT NOT NULL,
      message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      retention_class TEXT,
      alt TEXT NOT NULL,
      original_media_id TEXT NOT NULL,
      original_media_subdir TEXT NOT NULL,
      original_content_type TEXT NOT NULL,
      original_width INTEGER,
      original_height INTEGER,
      original_size_bytes INTEGER,
      original_filename TEXT,
      record_json TEXT NOT NULL
    );
    CREATE INDEX idx_managed_outgoing_images_session
      ON managed_outgoing_image_records(session_key, created_at DESC, attachment_id);
    CREATE INDEX idx_managed_outgoing_images_message
      ON managed_outgoing_image_records(session_key, message_id, attachment_id)
      WHERE message_id IS NOT NULL;
    PRAGMA user_version = 2;
    UPDATE schema_meta SET schema_version = 2 WHERE meta_key = 'primary';
  `);
  if (!options.withRow) {
    return;
  }
  const record = {
    attachmentId: "legacy-attachment",
    sessionKey: "agent:main:legacy",
    messageId: "legacy-message",
    createdAt: "2026-07-17T00:00:00.000Z",
    alt: "legacy image",
    original: {
      path: "/legacy/media/outgoing/originals/legacy-media",
      contentType: "image/png",
      width: 640,
      height: 480,
      sizeBytes: 1234,
      filename: "legacy.png",
    },
  };
  database
    .prepare(
      `INSERT INTO managed_outgoing_image_records (
        attachment_id,
        session_key,
        message_id,
        created_at,
        alt,
        original_media_id,
        original_media_subdir,
        original_content_type,
        original_width,
        original_height,
        original_size_bytes,
        original_filename,
        record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.attachmentId,
      record.sessionKey,
      record.messageId,
      record.createdAt,
      record.alt,
      "legacy-media",
      "outgoing/originals",
      record.original.contentType,
      record.original.width,
      record.original.height,
      record.original.sizeBytes,
      record.original.filename,
      JSON.stringify(record),
    );
}

const LEGACY_SESSION_WATCH_SCHEMA_VERSION = 3;
const LEGACY_AMBIENT_WATCH_PREFIX = "ambient-group-watch:";

export function markStateDatabaseVersion(database: DatabaseSync, version: number): void {
  database.exec(`
    PRAGMA user_version = ${version};
    UPDATE schema_meta SET schema_version = ${version} WHERE meta_key = 'primary';
  `);
}

export const RETIRED_COMMITMENT_SCHEMA_OBJECTS = [
  "commitments",
  "idx_commitments_scope_due",
  "idx_commitments_status_due",
  "idx_commitments_scope_dedupe",
  "idx_commitments_agent_due",
  "idx_commitments_agent_sent",
] as const;

export const RETIRED_STATE_TABLES_V10 = [
  "agent_model_catalogs",
  "android_notification_recent_packages",
  "command_log_entries",
  "diagnostic_stability_bundles",
  "media_blobs",
  "model_capability_cache",
] as const;

export const FOLDED_STATE_TABLES_V12 = [
  "skill_curator_state",
  "update_check_state",
  "clawhub_promotions_feed_state",
  "model_catalog_remote",
  "voicewake_triggers",
  "voicewake_routing_config",
  "voicewake_routing_routes",
  "onboarding_recommendations",
  "cron_store_epochs",
  "tui_last_sessions",
  "sidebar_sections",
  "node_host_config",
  "web_push_vapid_keys",
] as const;

export function seedV6CommitmentSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS commitments (
      id TEXT NOT NULL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      account_id TEXT,
      recipient_id TEXT,
      thread_id TEXT,
      sender_id TEXT,
      kind TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      suggested_text TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      confidence REAL NOT NULL,
      due_earliest_ms INTEGER NOT NULL,
      due_latest_ms INTEGER NOT NULL,
      due_timezone TEXT NOT NULL,
      source_message_id TEXT,
      source_run_id TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      last_attempt_at_ms INTEGER,
      sent_at_ms INTEGER,
      dismissed_at_ms INTEGER,
      snoozed_until_ms INTEGER,
      expired_at_ms INTEGER,
      record_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_commitments_scope_due
      ON commitments(agent_id, session_key, status, due_earliest_ms, due_latest_ms);
    CREATE INDEX IF NOT EXISTS idx_commitments_status_due
      ON commitments(status, due_earliest_ms, due_latest_ms);
    CREATE INDEX IF NOT EXISTS idx_commitments_scope_dedupe
      ON commitments(agent_id, session_key, channel, dedupe_key, status);
    CREATE INDEX IF NOT EXISTS idx_commitments_agent_due
      ON commitments(agent_id, status, due_earliest_ms, due_latest_ms, session_key);
    CREATE INDEX IF NOT EXISTS idx_commitments_agent_sent
      ON commitments(agent_id, status, sent_at_ms, session_key);
    INSERT INTO commitments (
      id, agent_id, session_key, channel, kind, sensitivity, source, status,
      reason, suggested_text, dedupe_key, confidence, due_earliest_ms,
      due_latest_ms, due_timezone, created_at_ms, updated_at_ms, attempts, record_json
    ) VALUES (
      'retired-commitment', 'main', 'agent:main:main', 'telegram', 'followup',
      'normal', 'message', 'pending', 'inert', 'follow up', 'retired-dedupe',
      1.0, 10, 20, 'UTC', 1, 1, 0, '{}'
    );
    INSERT INTO state_leases (
      scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at
    ) VALUES ('test', 'preserved-lease', 'migration-test', 100, 50, '{}', 1, 2);
  `);
  markStateDatabaseVersion(database, 6);
}

export function seedAdditiveV6CommitmentSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE commitments (
      id TEXT NOT NULL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      account_id TEXT,
      recipient_id TEXT,
      thread_id TEXT,
      sender_id TEXT,
      kind TEXT NOT NULL DEFAULT 'followup',
      sensitivity TEXT NOT NULL DEFAULT 'normal',
      source TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      suggested_text TEXT NOT NULL DEFAULT '',
      dedupe_key TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0,
      due_earliest_ms INTEGER NOT NULL,
      due_latest_ms INTEGER NOT NULL,
      due_timezone TEXT NOT NULL DEFAULT 'UTC',
      source_message_id TEXT,
      source_run_id TEXT,
      created_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at_ms INTEGER,
      sent_at_ms INTEGER,
      dismissed_at_ms INTEGER,
      snoozed_until_ms INTEGER,
      expired_at_ms INTEGER,
      record_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX idx_commitments_scope_due
      ON commitments(agent_id, session_key, status, due_earliest_ms, due_latest_ms);
    CREATE INDEX idx_commitments_status_due
      ON commitments(status, due_earliest_ms, due_latest_ms);
    CREATE INDEX idx_commitments_scope_dedupe
      ON commitments(agent_id, session_key, channel, dedupe_key, status);
    CREATE INDEX idx_commitments_agent_due
      ON commitments(agent_id, status, due_earliest_ms, due_latest_ms, session_key);
    CREATE INDEX idx_commitments_agent_sent
      ON commitments(agent_id, status, sent_at_ms, session_key);
  `);
  markStateDatabaseVersion(database, 6);
}

export function seedPartiallyAdditiveV6CommitmentSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE commitments (
      id TEXT NOT NULL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      account_id TEXT,
      kind TEXT NOT NULL DEFAULT 'followup',
      status TEXT NOT NULL,
      dedupe_key TEXT NOT NULL DEFAULT '',
      due_earliest_ms INTEGER NOT NULL,
      due_latest_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      last_attempt_at_ms INTEGER,
      record_json TEXT NOT NULL
    );
    CREATE INDEX idx_commitments_scope_due
      ON commitments(agent_id, session_key, status, due_earliest_ms, due_latest_ms);
    CREATE INDEX idx_commitments_status_due
      ON commitments(status, due_earliest_ms, due_latest_ms);
  `);
  markStateDatabaseVersion(database, 6);
}

export function seedEarlyCommitmentSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE commitments (
      id TEXT NOT NULL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      due_earliest_ms INTEGER NOT NULL,
      due_latest_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX idx_commitments_scope_due
      ON commitments(agent_id, session_key, status, due_earliest_ms, due_latest_ms);
    CREATE INDEX idx_commitments_status_due
      ON commitments(status, due_earliest_ms, due_latest_ms);
  `);
}

export function seedLegacySessionWatchCursorSchema(databasePath: string): {
  ambientTarget: string;
  bomTarget: string;
  bomWatcherSessionKey: string;
  corruptTarget: string;
  databasePath: string;
  explicitTarget: string;
  replacementWatcherSessionKey: string;
  watcherSessionKey: string;
} {
  const watcherSessionKey = "agent:main:main";
  const ambientTarget = "agent:main:telegram:group:ambient";
  const bomTarget = "agent:main:telegram:group:bom";
  const bomWatcherSessionKey = "﻿agent:main:bom-watcher";
  const corruptTarget = "agent:main:telegram:group:corrupt";
  const explicitTarget = "agent:main:subagent:explicit";
  const replacementWatcherSessionKey = "�";
  const markerKey = `${LEGACY_AMBIENT_WATCH_PREFIX}${Buffer.from(watcherSessionKey, "utf8").toString("hex")}`;
  const bomMarkerKey = `${LEGACY_AMBIENT_WATCH_PREFIX}${Buffer.from(bomWatcherSessionKey, "utf8").toString("hex")}`;
  const orphanMarkerKey = `${LEGACY_AMBIENT_WATCH_PREFIX}${Buffer.from("agent:main:orphan", "utf8").toString("hex")}`;
  const { DatabaseSync } = requireNodeSqlite();
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      DROP INDEX idx_session_watch_cursors_target;
      ALTER TABLE session_watch_cursors RENAME TO session_watch_cursors_v4;
      CREATE TABLE session_watch_cursors (
        watcher_session_key TEXT NOT NULL,
        target_session_key TEXT NOT NULL,
        last_seen_sequence INTEGER NOT NULL DEFAULT 0,
        notified_sequence INTEGER NOT NULL DEFAULT 0,
        material_sequence INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (watcher_session_key, target_session_key)
      ) STRICT;
      DROP TABLE session_watch_cursors_v4;
      CREATE INDEX idx_session_watch_cursors_target
        ON session_watch_cursors(target_session_key);
      PRAGMA user_version = ${LEGACY_SESSION_WATCH_SCHEMA_VERSION};
      UPDATE schema_meta
      SET schema_version = ${LEGACY_SESSION_WATCH_SCHEMA_VERSION}
      WHERE meta_key = 'primary';
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    const insert = legacy.prepare(`
      INSERT INTO session_watch_cursors (
        watcher_session_key, target_session_key, last_seen_sequence,
        notified_sequence, material_sequence, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run(watcherSessionKey, ambientTarget, 7, 8, 9, 200);
    insert.run(watcherSessionKey, explicitTarget, 3, 4, 5, 300);
    insert.run(bomWatcherSessionKey, bomTarget, 10, 11, 12, 500);
    insert.run(replacementWatcherSessionKey, corruptTarget, 13, 14, 15, 600);
    insert.run(markerKey, ambientTarget, 7, 7, 7, 400);
    insert.run(bomMarkerKey, bomTarget, 10, 10, 10, 800);
    insert.run(`${LEGACY_AMBIENT_WATCH_PREFIX}ff`, corruptTarget, 13, 13, 13, 900);
    insert.run(orphanMarkerKey, "agent:main:telegram:group:orphan", 1, 1, 1, 100);
    insert.run(`${LEGACY_AMBIENT_WATCH_PREFIX}not-hex`, ambientTarget, 1, 1, 1, 100);
  } finally {
    legacy.close();
  }
  return {
    ambientTarget,
    bomTarget,
    bomWatcherSessionKey,
    corruptTarget,
    databasePath,
    explicitTarget,
    replacementWatcherSessionKey,
    watcherSessionKey,
  };
}

export function createLegacyAuditStateDatabase(stateDir: string): string {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
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
      INSERT INTO schema_meta (
        meta_key,
        role,
        schema_version,
        created_at,
        updated_at
      ) VALUES ('primary', 'global', 1, 10, 10);
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL UNIQUE,
        source_sequence INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_key TEXT,
        session_id TEXT,
        run_id TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT
      );
      CREATE INDEX idx_audit_events_time
        ON audit_events(occurred_at DESC, sequence DESC);
      CREATE INDEX idx_audit_events_agent_sequence
        ON audit_events(agent_id, sequence DESC);
      CREATE INDEX idx_audit_events_session_sequence
        ON audit_events(session_key, sequence DESC);
      CREATE INDEX idx_audit_events_run_sequence
        ON audit_events(run_id, sequence DESC);
      CREATE INDEX idx_audit_events_kind_sequence
        ON audit_events(kind, sequence DESC);
      CREATE INDEX idx_audit_events_status_sequence
        ON audit_events(status, sequence DESC);
      INSERT INTO audit_events (
        sequence,
        event_id,
        source_id,
        source_sequence,
        occurred_at,
        kind,
        action,
        status,
        actor_type,
        actor_id,
        agent_id,
        run_id
      ) VALUES (
        7,
        'event-legacy',
        'run-legacy:1:100:agent.run.started',
        1,
        100,
        'agent_run',
        'agent.run.started',
        'started',
        'agent',
        'main',
        'main',
        'run-legacy'
      );
      UPDATE sqlite_sequence SET seq = 40 WHERE name = 'audit_events';
    `);
  } finally {
    db.close();
  }
  return databasePath;
}

export function downgradeWorkerPlacementsToV7(db: DatabaseSync): void {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'worker_session_placements'",
    )
    .get() as { sql?: unknown } | undefined;
  if (typeof row?.sql !== "string") {
    throw new Error("missing worker_session_placements table SQL");
  }
  const v8LocalClaim = `(turn_claim_owner IS 'local' AND (\n      state IN ('local', 'requested', 'failed')\n      OR (state IN ('active', 'draining') AND execution_mode IS 'remote-exec')\n    ))`;
  const v7Create = row.sql
    .replace("CREATE TABLE worker_session_placements", "CREATE TABLE worker_session_placements_v7")
    .replace(
      "\n  execution_mode TEXT CHECK (execution_mode IN ('worker-turn', 'remote-exec')),",
      "",
    )
    .replace(
      v8LocalClaim,
      `(turn_claim_owner IS 'local' AND state IN ('local', 'requested', 'failed'))`,
    )
    .replace("\n      AND (execution_mode IS NULL OR execution_mode IS 'worker-turn')", "");
  if (v7Create.includes("execution_mode")) {
    throw new Error("failed to derive v7 worker placement schema");
  }
  const columns = (
    db.prepare("PRAGMA table_xinfo(worker_session_placements)").all() as Array<{
      hidden: number;
      name: string;
    }>
  )
    .filter((column) => column.hidden === 0 && column.name !== "execution_mode")
    .map((column) => `"${column.name}"`)
    .join(", ");
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      ${v7Create};
      INSERT INTO worker_session_placements_v7 (${columns})
        SELECT ${columns} FROM worker_session_placements;
      DROP TABLE worker_session_placements;
      ALTER TABLE worker_session_placements_v7 RENAME TO worker_session_placements;
      CREATE INDEX idx_worker_session_placements_session_key
        ON worker_session_placements(agent_id, session_key);
      CREATE INDEX idx_worker_session_placements_reconcile
        ON worker_session_placements(updated_at_ms, session_id);
      PRAGMA user_version = 7;
      UPDATE schema_meta SET schema_version = 7 WHERE meta_key = 'primary';
      COMMIT;
    `);
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}
