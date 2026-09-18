import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { expect } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

/** Capture persistent artifacts without releasing the test writer's POSIX locks. */
export function snapshotPreflightSourceManifest(stateDir: string, allowAgentReadMarks?: string) {
  // Opening/closing the main file in the writer's process releases its POSIX
  // locks. Observe in a child so SQLite still sees a live owner during inspection.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
      import fs from "node:fs";
      import path from "node:path";
      import { createHash } from "node:crypto";
      const [stateDir, allowAgentReadMarks] = process.argv.slice(1);
      const manifest = fs.readdirSync(stateDir, { recursive: true, encoding: "utf8" })
        .filter(entry => !entry.startsWith("tmp" + path.sep))
        .filter(entry => fs.statSync(path.join(stateDir, entry)).isFile())
        .toSorted().map(entry => {
          const pathname = path.join(stateDir, entry);
          const bytes = fs.readFileSync(pathname);
          if (pathname === allowAgentReadMarks + "-shm") bytes.fill(0, 100, 120);
          return [entry, createHash("sha256").update(bytes).digest("hex")];
        });
      console.log(JSON.stringify(manifest));
      `,
      stateDir,
      allowAgentReadMarks ?? "",
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

export function createReleasedStateDatabase(stateDir: string) {
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const statePath = resolveOpenClawStateSqlitePath(env);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    gunzipSync(
      fs.readFileSync(
        new URL("../../test/fixtures/sqlite/openclaw-state-v2026.7.1-2.sqlite.gz", import.meta.url),
      ),
    ),
  );
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}\n");
  return { env, stateDir, statePath };
}

export function snapshotSourceFamily(databasePath: string) {
  const paths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].filter(fs.existsSync);
  return {
    entries: fs.readdirSync(path.dirname(databasePath)).toSorted(),
    files: paths.map((pathname) => {
      const stat = fs.statSync(pathname, { bigint: true });
      return {
        pathname,
        bytes: fs.readFileSync(pathname),
        birthtimeNs: stat.birthtimeNs,
        ctimeNs: stat.ctimeNs,
        dev: stat.dev,
        ino: stat.ino,
        mtimeNs: stat.mtimeNs,
        size: stat.size,
      };
    }),
  };
}

export function createExplicitStateDatabase(
  stateDir: string,
  schemaSql = OPENCLAW_STATE_SCHEMA_SQL,
): string {
  const databasePath = path.join(stateDir, "candidate.sqlite");
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    // Match production bootstrap: one durable commit, not one per schema object.
    runSqliteImmediateTransactionSync(database, () => {
      database.exec(`${schemaSql}; PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
      database
        .prepare(
          `INSERT INTO schema_meta (
             meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
           ) VALUES ('primary', 'global', ?, NULL, NULL, 1, 1)`,
        )
        .run(OPENCLAW_STATE_SCHEMA_VERSION);
    });
  } finally {
    database.close();
  }
  return databasePath;
}
