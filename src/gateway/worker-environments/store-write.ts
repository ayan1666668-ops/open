import type { DatabaseSync } from "node:sqlite";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";

function readTotalChanges(db: DatabaseSync): number {
  // sqlite-allow-raw -- connection-local change counter for post-commit invalidation.
  const row = db.prepare("SELECT total_changes() AS value").get();
  if (typeof row?.value !== "number") {
    throw new Error("SQLite did not return a numeric total_changes() value");
  }
  return row.value;
}

export function createWorkerEnvironmentStoreWriter(path: string) {
  let inventoryVersion = 0;
  return {
    write<T>(operation: (db: DatabaseSync) => T): T {
      const result = runOpenClawStateWriteTransaction(
        ({ db }) => {
          const changesBefore = readTotalChanges(db);
          const value = operation(db);
          if (readTotalChanges(db) !== changesBefore) {
            sessionChanges.emit({ all: true, scope: "worker-environments" }, db);
          }
          return value;
        },
        { path },
      );
      // Device pairing's nodeDeviceId patch deliberately stays outside this version:
      // it changes no identity/epoch/state input. Runner availability owns its own fence.
      inventoryVersion += 1;
      return result;
    },
    inventoryVersion: () => inventoryVersion,
  };
}
