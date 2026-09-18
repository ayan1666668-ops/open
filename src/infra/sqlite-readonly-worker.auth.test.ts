import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { BrokerChild } from "../process/spawn-broker/child.js";
import { runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../process/spawn-broker/host.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { runSqliteReadOnlyWorker } from "./sqlite-readonly-worker.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const skipBroker = process.platform === "win32" || Boolean(process.versions.bun);

function createAuthDatabase(key = "synthetic") {
  const source = path.join(tempDirs.make("openclaw-auth-transport-"), "source.sqlite");
  const store = {
    version: 1,
    profiles: { "fixture:default": { type: "api_key", provider: "fixture", key } },
  };
  const state = { lastGood: { fixture: "fixture:default" } };
  const database = new (requireNodeSqlite().DatabaseSync)(source);
  try {
    database.exec(`
      CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT);
      CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT);
    `);
    database
      .prepare("INSERT INTO auth_profile_store VALUES (?, ?)")
      .run("primary", JSON.stringify(store));
    database
      .prepare("INSERT INTO auth_profile_state VALUES (?, ?)")
      .run("primary", JSON.stringify(state));
  } finally {
    database.close();
  }
  return { source, store, state };
}

function read(source: string, sourceKind: "canonical" | "snapshot", signal?: AbortSignal) {
  return runSqliteReadOnlyWorker(source, {
    mode: "auth-profile-rows",
    source: sourceKind,
    expectedIdentity: readDatabasePathIdentitySync(source).key,
    env: { ...process.env },
    coordinatorRuntime: {
      directory: tempDirs.make("openclaw-auth-read-coordinator-"),
      keepAlive: false,
    },
    signal,
  });
}

describe.each([
  { label: "native", broker: false, sourceKind: "canonical" },
  { label: "broker", broker: true, sourceKind: "canonical" },
  { label: "snapshot with active broker", broker: true, sourceKind: "snapshot" },
] as const)("auth SQLite transport: $label", (transport) => {
  it.skipIf(transport.broker && skipBroker)(
    "reads complete oversized auth rows and joins the child before returning",
    async () => {
      const { source, store, state } = createAuthDatabase(`${"synthetic".repeat(1_200_000)}🌊`);
      const sourceBefore = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
      const broker = transport.broker ? createSpawnBrokerHost() : undefined;
      let child: ChildProcess | undefined;
      let closed = false;
      let stdoutBytes = 0;
      const observe = <T extends ChildProcess>(value: T): T => {
        child = value;
        value.once("close", () => {
          closed = true;
        });
        const capture = () =>
          value.stdout?.on("data", (data: Buffer) => {
            stdoutBytes += data.length;
          });
        if (value instanceof BrokerChild) {
          void value.ready().then(capture, () => {});
        } else {
          capture();
        }
        return value;
      };
      try {
        await broker?.ready();
        const actual =
          await vi.importActual<typeof import("node:child_process")>("node:child_process");
        vi.mocked(spawn).mockImplementationOnce((...args) => observe(actual.spawn(...args)));
        if (broker) {
          const brokerSpawn = broker.spawn.bind(broker);
          vi.spyOn(broker, "spawn").mockImplementation((...args) => observe(brokerSpawn(...args)));
          // A previous generation's cleanup error must not poison a new native exit.
          vi.spyOn(broker, "waitForCleanup").mockRejectedValue(
            new Error("prior broker generation cleanup failed"),
          );
        }
        const reading = () => read(source, transport.sourceKind);
        const rows = await (broker ? runWithSpawnBroker(broker, reading) : reading());
        const expected = JSON.stringify({
          store: { status: "readable", raw: store },
          state: { status: "readable", raw: state },
        });
        const received = JSON.stringify(rows);
        expect(received.length).toBe(expected.length);
        const digest = (value: string) => createHash("sha256").update(value).digest("hex");
        expect(digest(received)).toBe(digest(expected));
        expect(child instanceof BrokerChild).toBe(transport.label === "broker");
        expect(closed).toBe(true);
        expect(child?.exitCode).toBe(0);
        expect(child?.connected).toBe(false);
        expect(stdoutBytes).toBe(0);
        expect(createHash("sha256").update(fs.readFileSync(source)).digest("hex")).toBe(
          sourceBefore,
        );
        const writer = new (requireNodeSqlite().DatabaseSync)(source);
        try {
          writer.prepare("UPDATE auth_profile_state SET state_json = ?").run('{"lastGood":{}}');
        } finally {
          writer.close();
        }
        const refreshed = await (broker ? runWithSpawnBroker(broker, reading) : reading());
        expect(refreshed.state).toEqual({ status: "readable", raw: { lastGood: {} } });
      } finally {
        vi.restoreAllMocks();
        await broker?.close();
        vi.mocked(spawn).mockReset();
      }
    },
  );
});

describe.skipIf(skipBroker)("auth SQLite broker lifecycle", () => {
  it("cancels an admitted read before IPC readiness and joins its child", async () => {
    const { source } = createAuthDatabase();
    const broker = createSpawnBrokerHost();
    const ready = createDeferredCore();
    const admitted = createDeferredCore<BrokerChild>();
    const abort = new AbortController();
    let reading: Promise<unknown> | undefined;
    try {
      await broker.ready();
      const brokerSpawn = broker.spawn.bind(broker);
      vi.spyOn(broker, "spawn").mockImplementation((...args) => {
        const child = brokerSpawn(...args);
        const actualReady = child.ready();
        vi.spyOn(child, "ready").mockImplementation(() => actualReady.then(() => ready.promise));
        void actualReady.then(() => admitted.resolve(child), admitted.reject);
        return child;
      });
      reading = runWithSpawnBroker(broker, () => read(source, "canonical", abort.signal));
      const failure = new Error("auth read cancelled before readiness");
      const rejected = expect(reading).rejects.toBe(failure);
      const child = await admitted.promise;
      abort.abort(failure);
      await rejected;
      expect(child.signalCode).toBe("SIGKILL");
      expect(child.connected).toBe(false);
    } finally {
      ready.resolve();
      abort.abort();
      await Promise.allSettled([reading]);
      await broker.close();
    }
  });

  it("rejects an unavailable broker without falling back to a local auth read", async () => {
    const { source } = createAuthDatabase();
    const broker = createSpawnBrokerHost();
    try {
      await broker.ready();
      await broker.close();
      vi.spyOn(broker, "waitForCleanup").mockRejectedValue(
        new Error("prior broker generation cleanup failed"),
      );
      await expect(runWithSpawnBroker(broker, () => read(source, "canonical"))).rejects.toThrow(
        "Spawn broker is unavailable",
      );
    } finally {
      await broker.close();
    }
  });

  it.each([false, true])(
    "retains a failed read until lost-broker cleanup settles (cleanup failure: %s)",
    async (cleanupFails) => {
      const { source } = createAuthDatabase();
      const broker = createSpawnBrokerHost();
      const admitted = createDeferredCore<BrokerChild>();
      const ready = createDeferredCore();
      const cleanupEntered = createDeferredCore();
      const releaseCleanup = createDeferredCore();
      const cleanupFailure = new Error("recorded broker cleanup failure");
      let reading: Promise<unknown> | undefined;
      let settled = false;
      try {
        await broker.ready();
        const brokerSpawn = broker.spawn.bind(broker);
        vi.spyOn(broker, "spawn").mockImplementation((...args) => {
          const child = brokerSpawn(...args);
          const actualReady = child.ready();
          vi.spyOn(child, "ready").mockImplementation(() => actualReady.then(() => ready.promise));
          void actualReady.then(() => admitted.resolve(child), admitted.reject);
          return child;
        });
        const cleanup = broker.waitForCleanup.bind(broker);
        const cleanupSpy = vi.spyOn(broker, "waitForCleanup").mockImplementation(async () => {
          cleanupEntered.resolve();
          await releaseCleanup.promise;
          await cleanup();
          if (cleanupFails) {
            throw cleanupFailure;
          }
        });
        reading = runWithSpawnBroker(broker, () => read(source, "canonical"));
        void reading.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        const rejected = cleanupFails
          ? expect(reading).rejects.toMatchObject({
              message: "Auth read and child cleanup failed",
              cause: expect.objectContaining({ message: expect.stringContaining("Spawn broker") }),
              errors: [expect.any(Error), cleanupFailure],
            })
          : expect(reading).rejects.toThrow("Spawn broker");
        const child = await admitted.promise;
        process.kill(broker.pid!, "SIGKILL");
        await cleanupEntered.promise;
        await child.waitForClose();
        expect(settled).toBe(false);
        releaseCleanup.resolve();
        await rejected;
        expect(settled).toBe(true);
        cleanupSpy.mockRestore();
      } finally {
        ready.resolve();
        releaseCleanup.resolve();
        await Promise.allSettled([reading]);
        vi.restoreAllMocks();
        await broker.close();
      }
    },
  );
});
