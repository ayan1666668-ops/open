import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { acquireGatewayMaintenanceCoordinator } from "../infra/state-database-coordinator.js";
import { migrateLegacyExecutionSelections } from "../infra/state-migrations.execution-selection.js";
import * as agentMaintenance from "./openclaw-agent-db-maintenance-lease.js";
import { closeOpenClawAgentDatabasesForTest } from "./openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "./openclaw-database-preflight.js";
import {
  createReleasedStateDatabase,
  snapshotPreflightSourceManifest,
} from "./openclaw-database-preflight.test-support.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { repairAuditEventsSchema } from "./openclaw-state-db-audit-migration.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("execution selection database maintenance", () => {
  it("leaves current schemas unchanged without requiring stopped-writer maintenance", async () => {
    const stateDir = tempDirs.make("openclaw-current-execution-selection-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const { db } = openOpenClawStateDatabase({ env });
    // Keep the WAL owner alive so ordinary read-side WAL/SHM creation is not a migration.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = snapshotPreflightSourceManifest(stateDir);
    await expect(migrateLegacyExecutionSelections({ cfg: {}, env })).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    expect(snapshotPreflightSourceManifest(stateDir)).toEqual(before);
  });

  it("admits supported forward state migration after Doctor repairs audit and execution selection", async () => {
    const { env, stateDir, statePath } = createReleasedStateDatabase(
      tempDirs.make("openclaw-startup-database-admission-"),
    );
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(statePath);
    try {
      expect(repairAuditEventsSchema(database)).toBe(true);
    } finally {
      database.close();
    }
    const before = snapshotPreflightSourceManifest(stateDir);
    await expect(
      assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config: {} }),
    ).rejects.toThrow("acp-execution-selection-v18");
    expect(snapshotPreflightSourceManifest(stateDir)).toEqual(before);
    expect(() => openOpenClawStateDatabase({ env })).toThrow("acp-execution-selection-v18");
    const coordinator = acquireGatewayMaintenanceCoordinator({ databasePath: statePath });
    const resources = createOpenClawDatabaseMaintenanceScope(coordinator.createSchemaFenceDelegate);
    try {
      const result = await resources.run(() => migrateLegacyExecutionSelections({ cfg: {}, env }));
      expect(result.warnings).toEqual([]);
    } finally {
      await resources.close();
      coordinator.release();
    }
    await expect(
      assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config: {} }),
    ).resolves.toBeUndefined();
    const migrated = openOpenClawStateDatabase({ env });
    expect(migrated.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
  });

  it("retains legacy selectors and schema markers if Doctor stops after maintenance preparation", async () => {
    const { env, stateDir, statePath } = createReleasedStateDatabase(
      tempDirs.make("openclaw-startup-database-admission-"),
    );
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(statePath);
    legacy
      .prepare(
        "INSERT INTO acp_sessions (session_key, session_id, backend, agent, runtime_session_name, mode, runtime_options_json, state, last_activity_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "agent:main:acp:retained",
        "retained-generation",
        "fixture-backend",
        "fixture-agent",
        "retained-handle",
        "persistent",
        '{"model":"selected","other":"preserved"}',
        "idle",
        1,
        1,
      );
    const metadata = legacy.prepare("SELECT * FROM schema_meta").all();
    const selections = legacy.prepare("SELECT * FROM acp_sessions ORDER BY session_key").all();
    legacy.close();
    const interrupted = vi
      .spyOn(agentMaintenance, "withAgentDatabaseMaintenanceLease")
      .mockRejectedValueOnce(new Error("interrupted after maintenance preparation"));
    const coordinator = acquireGatewayMaintenanceCoordinator({ databasePath: statePath });
    const resources = createOpenClawDatabaseMaintenanceScope(coordinator.createSchemaFenceDelegate);
    try {
      await expect(
        resources.run(() => migrateLegacyExecutionSelections({ cfg: {}, env })),
      ).rejects.toThrow("interrupted after maintenance preparation");
    } finally {
      interrupted.mockRestore();
      await resources.close();
      coordinator.release();
    }
    const after = new DatabaseSync(statePath, { readOnly: true });
    try {
      expect(after.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(after.prepare("SELECT * FROM schema_meta").all()).toEqual(metadata);
      expect(after.prepare("SELECT * FROM acp_sessions ORDER BY session_key").all()).toEqual(
        selections,
      );
      expect(
        after
          .prepare(
            "SELECT name, strict FROM pragma_table_list WHERE name IN ('schema_meta', 'state_leases', 'agent_database_leases') ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: "agent_database_leases", strict: 1 },
        { name: "schema_meta", strict: 1 },
        { name: "state_leases", strict: 1 },
      ]);
    } finally {
      after.close();
    }
    const backupRoot = path.join(stateDir, "backups", "execution-selection");
    const backups = fs.readdirSync(backupRoot);
    expect(backups).toHaveLength(1);
    const saved = new DatabaseSync(path.join(backupRoot, backups[0]!, "shared.sqlite"), {
      readOnly: true,
    });
    try {
      expect(saved.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(saved.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(saved.prepare("SELECT * FROM schema_meta").all()).toEqual(metadata);
      expect(saved.prepare("SELECT * FROM acp_sessions ORDER BY session_key").all()).toEqual(
        selections,
      );
      expect(
        saved.prepare("SELECT strict FROM pragma_table_list WHERE name = 'state_leases'").get(),
      ).toEqual({ strict: 0 });
    } finally {
      saved.close();
    }
  });

  it("does not repair current-schema lease table drift through the historical prerequisite", async () => {
    const stateDir = tempDirs.make("openclaw-current-lease-drift-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawStateDatabase({ env });
    const statePath = opened.path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const drifted = new DatabaseSync(statePath);
    const canonical = drifted
      .prepare("SELECT sql FROM sqlite_schema WHERE name = 'state_leases'")
      .get();
    if (typeof canonical?.sql !== "string") {
      throw new Error("Missing lease schema");
    }
    drifted.exec("DROP TABLE state_leases");
    drifted.exec(canonical.sql.replace(/ STRICT$/u, ""));
    drifted.close();
    const coordinator = acquireGatewayMaintenanceCoordinator({ databasePath: statePath });
    const resources = createOpenClawDatabaseMaintenanceScope(coordinator.createSchemaFenceDelegate);
    try {
      await expect(
        resources.run(() => migrateLegacyExecutionSelections({ cfg: {}, env })),
      ).rejects.toThrow("failed to acquire agent database maintenance lease");
    } finally {
      await resources.close();
      coordinator.release();
    }
    const unchanged = new DatabaseSync(statePath, { readOnly: true });
    try {
      expect(unchanged.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        unchanged.prepare("SELECT strict FROM pragma_table_list WHERE name = 'state_leases'").get(),
      ).toEqual({ strict: 0 });
    } finally {
      unchanged.close();
    }
    expect(fs.existsSync(path.join(stateDir, "backups", "execution-selection"))).toBe(false);
  });
});
