import { Worker } from "node:worker_threads";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  captureStateDatabaseCoordinatorRuntime,
  resolveStateDatabaseCoordinatorPath,
} from "../infra/state-database-coordinator.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";

/** Hold only the synthetic fixture's coordinator, with release independent of its main thread. */
export function holdStateDatabaseCoordinator(releaseAfterMs: number) {
  const database = openOpenClawStateDatabase();
  const coordinatorPath = resolveStateDatabaseCoordinatorPath({
    databasePath: database.path,
    runtimeDirectory: captureStateDatabaseCoordinatorRuntime().directory,
    uid: process.getuid?.(),
  });
  const released = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const ready = createDeferred();
  const holder = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workerData.path);
    db.exec("PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE");
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      Atomics.store(new Int32Array(workerData.released), 0, 1);
      db.exec("ROLLBACK");
      db.close();
      parentPort.close();
    };
    const timer = setTimeout(release, workerData.releaseAfterMs);
    parentPort.once("message", release);
    parentPort.postMessage("ready");
  `,
    {
      eval: true,
      workerData: { path: coordinatorPath, released: released.buffer, releaseAfterMs },
    },
  );
  const joined = new Promise<number>((resolve, reject) => {
    holder.once("message", () => ready.resolve());
    holder.once("error", (error: Error) => {
      ready.reject(error);
      reject(error);
    });
    holder.once("exit", resolve);
  });
  void joined.catch(() => undefined);
  return {
    ready: ready.promise,
    released,
    joined,
    release: () => {
      if (Atomics.load(released, 0) === 0) {
        holder.postMessage("release", []);
      }
    },
  };
}
