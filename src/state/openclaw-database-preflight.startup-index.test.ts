import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { runSessionStartupMigration } from "../config/sessions/startup-migration.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "./openclaw-database-preflight.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await flushLogger();
  setLoggerOverride(null);
  resetLogger();
  vi.unstubAllEnvs();
});

it.each(["missing", "drifted", "missing table"])(
  "admits rebuildable startup indexes and preserves table refusal (%s)",
  async (damage) => {
    const stateDir = fs.realpathSync.native(tempDirs.make("startup-index-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const logPath = path.join(stateDir, "startup.log");
    const configPath = path.join(stateDir, "openclaw.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("OPENCLAW_LOG_LEVEL", "warn");
    fs.writeFileSync(configPath, JSON.stringify({ logging: { level: "warn", file: logPath } }));
    setLoggerOverride({ level: "warn", file: logPath, consoleLevel: "silent" });
    const agentPath = openOpenClawAgentDatabase({ agentId: "main", env }).path;
    const session = { agentId: "main", env, sessionKey: "agent:main:retained" };
    await replaceSessionEntry(session, { sessionId: "retained-history", updatedAt: 1 });
    const entry = loadSessionEntry(session);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(agentPath);
    if (damage !== "missing table") {
      writer.exec("DROP INDEX idx_agent_session_nodes_active;");
    }
    if (damage === "drifted") {
      writer.exec("CREATE INDEX idx_agent_session_nodes_active ON session_nodes(session_key);");
    } else if (damage === "missing table") {
      writer.exec("DROP TABLE session_key_contract;");
    }
    writer.close();
    const before = fs.readFileSync(agentPath);
    const admission = assertOpenClawDatabasesReady({
      env,
      operation: "gateway-startup",
      config: {},
    });
    if (damage === "missing table") {
      await expect(admission).rejects.toThrow(
        /missing table session_key_contract; run openclaw doctor --fix/,
      );
      expect(fs.readFileSync(agentPath)).toEqual(before);
      return;
    }
    await expect(admission).resolves.toBeUndefined();
    expect(fs.readFileSync(agentPath)).toEqual(before);
    await runSessionStartupMigration({ cfg: {}, env, log: { info: vi.fn(), warn: vi.fn() } });
    const reader = new DatabaseSync(agentPath, { readOnly: true });
    try {
      expect(
        reader
          .prepare("SELECT sql FROM sqlite_schema WHERE name='idx_agent_session_nodes_active'")
          .get()?.sql,
      ).toMatch(/WHERE archived_at IS NULL/i);
    } finally {
      reader.close();
    }
    expect(loadSessionEntry(session)).toEqual(entry);
    await flushLogger();
    const repairRecords = () =>
      fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line): { message?: string; "1"?: unknown } => JSON.parse(line))
        .filter((record) => record.message === "Rebuilt canonical agent SQLite indexes");
    expect(repairRecords()).toEqual([
      expect.objectContaining({
        "1": expect.objectContaining({
          indexes: ["idx_agent_session_nodes_active"],
          elapsedMs: expect.any(Number),
        }),
      }),
    ]);
    await expect(
      assertOpenClawDatabasesReady({ env, operation: "gateway-restart" }),
    ).resolves.toBeUndefined();
    await runSessionStartupMigration({ cfg: {}, env, log: { info: vi.fn(), warn: vi.fn() } });
    await flushLogger();
    expect(repairRecords()).toHaveLength(1);
  },
);
