import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { getChildLogger } from "../logging/logger.js";
import {
  createPrivateSqliteTempDirectory,
  createPrivateSqliteTempDirectorySync,
  resolvePrivateSqliteSnapshotStagingRoot,
} from "./sqlite-private-directory.js";
import {
  registerSnapshotTempDirectory,
  removeTempDirectory,
  retainSnapshotWork,
} from "./sqlite-readonly-location-cleanup.js";

const SQLITE_SNAPSHOT_STAGING_PREFIX = `openclaw-sqlite-readonly-${process.pid}-`;
const directoryMarker =
  /^openclaw-sqlite-readonly-([1-9]\d*)-(?:[A-Za-z0-9]{6}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/u;
const snapshotFile = /^(?:first|database\.sqlite(?:\.partial)?(?:-wal|-shm|-journal)?)$/u;
const scannedRoots = new Set<string>();

function ownerPid(name: string): number | undefined {
  const match = directoryMarker.exec(name);
  const pid = match ? Number(match[1]) : undefined;
  return pid !== undefined && Number.isSafeInteger(pid) ? pid : undefined;
}

function ownerExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM and reused PIDs are live/unknown, never permission to reclaim.
    return extractErrorCode(error) === "ESRCH";
  }
}

/** Older copies use the same PID directory marker and first/database.sqlite names. */
function abandonedSnapshotBytes(
  directory: string,
  layout: "snapshot" | "doctor-root" | "doctor-state" = "snapshot",
): number | undefined {
  const pid = ownerPid(path.basename(directory));
  const stat = fs.lstatSync(directory);
  if (
    (layout === "snapshot" && (pid === undefined || !ownerExited(pid))) ||
    !stat.isDirectory() ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    return undefined;
  }
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const pathname = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      // Doctor relocates the private family before running isolated inspectors.
      const childLayout =
        layout === "snapshot"
          ? entry.name === "openclaw-state"
            ? "doctor-root"
            : "snapshot"
          : layout === "doctor-root" && entry.name === "state"
            ? "doctor-state"
            : undefined;
      const childBytes = childLayout && abandonedSnapshotBytes(pathname, childLayout);
      if (childBytes === undefined) {
        return undefined;
      }
      bytes += childBytes;
    } else if (
      entry.isFile() &&
      (layout === "snapshot"
        ? snapshotFile.test(entry.name)
        : layout === "doctor-state" &&
          /^openclaw\.sqlite(?:-wal|-shm|-journal)?$/u.test(entry.name))
    ) {
      const file = fs.lstatSync(pathname);
      if (!file.isFile() || (process.getuid && file.uid !== process.getuid())) {
        return undefined;
      }
      bytes += file.size;
    } else {
      // Unknown files, symlinks, and unrelated directories have no cleanup contract.
      return undefined;
    }
  }
  return bytes;
}

function reclaimAbandonedSnapshots(root: string): void {
  // A worker's staging root still belongs to its parent, even after a previous
  // child handed back a completed snapshot and exited.
  if (ownerPid(path.basename(root)) !== undefined || scannedRoots.has(root)) {
    return;
  }
  scannedRoots.add(root);
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || ownerPid(entry.name) === undefined) {
        continue;
      }
      const original = path.join(root, entry.name);
      try {
        const bytes = abandonedSnapshotBytes(original);
        if (bytes === undefined) {
          continue;
        }
        // Rename transfers this dead owner's artifact to exactly one reclaimer.
        // A crash here leaves the same recognizable marker for the next start.
        const claimed = path.join(root, `${SQLITE_SNAPSHOT_STAGING_PREFIX}${randomUUID()}`);
        fs.renameSync(original, claimed);
        registerSnapshotTempDirectory(claimed);
        if (removeTempDirectory(claimed)) {
          getChildLogger({ subsystem: "infra/sqlite-snapshot" }).warn(
            { reclaimedBytes: bytes },
            `Reclaimed ${bytes} bytes from an interrupted SQLite read-only snapshot.`,
          );
        } else {
          getChildLogger({ subsystem: "infra/sqlite-snapshot" }).warn(
            "Could not remove an interrupted SQLite snapshot; check cache directory permissions.",
          );
        }
      } catch (error) {
        if (extractErrorCode(error) !== "ENOENT") {
          throw error;
        }
      }
    }
  } catch (error) {
    try {
      getChildLogger({ subsystem: "infra/sqlite-snapshot" }).warn(
        { errorCode: extractErrorCode(error) },
        "Could not reclaim interrupted SQLite snapshots; check cache directory permissions.",
      );
    } catch {
      // Reclamation must not prevent a new inspection from making progress.
    }
  }
}

export function createSqliteSnapshotStagingDirectorySync(
  root = resolvePrivateSqliteSnapshotStagingRoot(),
): string {
  reclaimAbandonedSnapshots(root);
  const directory = createPrivateSqliteTempDirectorySync(root, SQLITE_SNAPSHOT_STAGING_PREFIX);
  registerSnapshotTempDirectory(directory);
  return directory;
}

export async function allocateSqliteSnapshotStagingDirectory(
  root = resolvePrivateSqliteSnapshotStagingRoot(),
): Promise<string> {
  reclaimAbandonedSnapshots(root);
  const directory = await retainSnapshotWork(
    createPrivateSqliteTempDirectory(root, SQLITE_SNAPSHOT_STAGING_PREFIX),
  );
  registerSnapshotTempDirectory(directory);
  return directory;
}
