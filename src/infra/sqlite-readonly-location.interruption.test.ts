import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setLoggerOverride } from "../logging/logger.js";
import { testApi } from "../logging/logger.test-support.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "./sqlite-readonly-location.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  setLoggerOverride(null);
  vi.unstubAllEnvs();
});

it.skipIf(process.platform === "win32").each([
  { signal: "SIGTERM", relocated: false },
  { signal: "SIGKILL", relocated: false },
  { signal: "SIGTERM", relocated: true },
])(
  "reclaims a $signal-interrupted copy on the next inspection (Doctor layout: $relocated)",
  async ({ signal, relocated }) => {
    const root = tempDirs.make("sqlite-interrupted-owner-");
    const cache = path.join(root, "cache");
    const source = path.join(root, "source.sqlite");
    const log = path.join(root, "cleanup.log");
    fs.mkdirSync(cache);
    fs.writeFileSync(log, "");
    setLoggerOverride({ level: "warn", file: log });
    const database = new (requireNodeSqlite().DatabaseSync)(source);
    database.exec("CREATE TABLE probe(value BLOB); INSERT INTO probe VALUES(zeroblob(2097152));");
    database.close();
    const before = fs.readFileSync(source);
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        `import fs from 'node:fs'; import path from 'node:path';
         import { prepareSqliteReadOnlyLocationSyncInProcess } from ${JSON.stringify(new URL("./sqlite-readonly-location.ts", import.meta.url).href)};
         const write = fs.writeSync;
         fs.writeSync = (...args) => {
           const bytes = write(...args);
           if (!${JSON.stringify(relocated)}) process.kill(process.pid, ${JSON.stringify(signal)});
           return bytes;
         };
         const prepared = prepareSqliteReadOnlyLocationSyncInProcess(${JSON.stringify(source)}, ${JSON.stringify(cache)});
         const relocated = path.join(path.dirname(prepared.location), 'openclaw-state/state/openclaw.sqlite');
         fs.mkdirSync(path.dirname(relocated), { recursive: true });
         fs.renameSync(prepared.location, relocated);
         process.kill(process.pid, ${JSON.stringify(signal)});`,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBe(signal);
    const abandoned = fs.readdirSync(cache).map((entry) => path.join(cache, entry));
    expect(abandoned).toHaveLength(1);
    const retainedBytes = fs.statSync(
      path.join(abandoned[0]!, relocated ? "openclaw-state/state/openclaw.sqlite" : "first"),
    ).size;
    expect(retainedBytes).toBeGreaterThan(0);
    const prepared = prepareSqliteReadOnlyLocationSyncInProcess(source, cache);
    try {
      expect(abandoned.every((directory) => !fs.existsSync(directory))).toBe(true);
      const reader = new (requireNodeSqlite().DatabaseSync)(prepared.location, { readOnly: true });
      try {
        expect(reader.prepare("SELECT length(value) AS bytes FROM probe").get()).toEqual({
          bytes: 2097152,
        });
      } finally {
        reader.close();
      }
    } finally {
      prepared.cleanup();
    }
    expect(fs.readdirSync(cache)).toEqual([]);
    expect(fs.readFileSync(source)).toEqual(before);
    await testApi.flushFileLogQueueForTests();
    expect(fs.readFileSync(log, "utf8")).toContain(`Reclaimed ${retainedBytes} bytes`);
  },
);

it.skipIf(process.platform === "win32")(
  "preserves live owners and unrecognized artifacts during reclamation",
  () => {
    const root = tempDirs.make("sqlite-reclaim-ownership-");
    const source = path.join(root, "source.sqlite");
    const cache = path.join(root, "cache");
    fs.mkdirSync(cache);
    const database = new (requireNodeSqlite().DatabaseSync)(source);
    database.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('preserved');");
    database.close();
    const before = fs.readFileSync(source);
    const exited = spawnSync(process.execPath, ["-e", ""], { timeout: 30_000 });
    expect(exited.status).toBe(0);
    const markers = {
      live: `openclaw-sqlite-readonly-${process.pid}-Alive1`,
      child: `openclaw-sqlite-readonly-${exited.pid}-Nested`,
      unknown: `openclaw-sqlite-readonly-${exited.pid}-Unknow`,
      symlink: `openclaw-sqlite-readonly-${exited.pid}-Symlin`,
      unmarked: "unrelated-cache",
    };
    for (const directory of Object.values(markers)) {
      fs.mkdirSync(path.join(cache, directory));
    }
    fs.writeFileSync(path.join(cache, markers.live, "database.sqlite"), "active snapshot");
    fs.mkdirSync(path.join(cache, markers.child, markers.live));
    fs.writeFileSync(path.join(cache, markers.child, markers.live, "first"), "active child");
    fs.writeFileSync(path.join(cache, markers.unknown, "operator.txt"), "retain");
    fs.symlinkSync(source, path.join(cache, markers.symlink, "database.sqlite"));
    const prepared = prepareSqliteReadOnlyLocationSyncInProcess(source, cache);
    prepared.cleanup();
    expect(fs.readdirSync(cache).toSorted()).toEqual(Object.values(markers).toSorted());
    expect(fs.readFileSync(path.join(cache, markers.live, "database.sqlite"), "utf8")).toBe(
      "active snapshot",
    );
    expect(fs.readFileSync(path.join(cache, markers.child, markers.live, "first"), "utf8")).toBe(
      "active child",
    );
    expect(fs.readFileSync(source)).toEqual(before);
  },
);
