import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { killProcessTree } from "../kill-tree.js";

const log = createSubsystemLogger("process/orphans");

// Wall-clock comparisons against ps/procfs start times are second-resolution;
// allow generous slack so we never kill on a borderline mismatch.
const START_TIME_TOLERANCE_MS = 5_000;

export type PersistedRunRecord = {
  runId: string;
  pid: number;
  ownerPid: number;
  ownerStartedAtMs: number;
  createdAtMs: number;
  argvPreview?: string;
};

export function resolveProcessRunsDir(baseDir?: string): string {
  return path.join(baseDir ?? resolveStateDir(), "process-runs");
}

export function ownProcessStartTimeMs(): number {
  return Date.now() - process.uptime() * 1000;
}

/** Best-effort: losing a record only means the child is not reconciled later. */
export function persistRunRecord(record: PersistedRunRecord, baseDir?: string): void {
  try {
    const dir = resolveProcessRunsDir(baseDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `${record.runId}.json`), JSON.stringify(record), {
      mode: 0o600,
    });
  } catch (err) {
    log.debug(`failed to persist run record ${record.runId}: ${String(err)}`);
  }
}

export function removeRunRecord(runId: string, baseDir?: string): void {
  try {
    fs.rmSync(path.join(resolveProcessRunsDir(baseDir), `${runId}.json`), { force: true });
  } catch (err) {
    log.debug(`failed to remove run record ${runId}: ${String(err)}`);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read a process's start wall-clock time. Returns null when it cannot be
 * determined (unsupported platform, process gone) — callers must treat null
 * as "unverifiable" and fail safe (never kill).
 */
export function readProcessStartTimeMs(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 2 (comm) may contain spaces/parens; fields resume after the
      // last ")". starttime is overall field 22 → index 19 after comm+state.
      const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
      const startTicks = Number(afterComm.split(" ")[19]);
      const uptimeSec = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
      if (!Number.isFinite(startTicks) || !Number.isFinite(uptimeSec)) {
        return null;
      }
      const userHz = 100; // USER_HZ; 100 on all mainstream Linux builds
      return Date.now() - (uptimeSec - startTicks / userHz) * 1000;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const out = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
      if (out.status !== 0) {
        return null;
      }
      const parsed = Date.parse(out.stdout.trim().replace(/\s+/g, " "));
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export type ReconcileResult = {
  scanned: number;
  killed: number;
  removed: number;
};

/**
 * Kill children whose supervising process died (crash/restart) and clean up
 * their records. Kills only when both checks pass: the owner is verifiably
 * gone AND the child's start time predates its record (guards PID reuse).
 */
export async function reconcilePersistedOrphans(opts?: {
  baseDir?: string;
  graceMs?: number;
}): Promise<ReconcileResult> {
  const dir = resolveProcessRunsDir(opts?.baseDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return { scanned: 0, killed: 0, removed: 0 };
  }

  const ownStartedAtMs = ownProcessStartTimeMs();
  let killed = 0;
  let removed = 0;

  for (const name of entries) {
    const file = path.join(dir, name);
    let record: PersistedRunRecord | null = null;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedRunRecord;
    } catch {
      record = null;
    }
    if (
      !record ||
      !Number.isInteger(record.pid) ||
      !Number.isInteger(record.ownerPid) ||
      typeof record.createdAtMs !== "number"
    ) {
      fs.rmSync(file, { force: true });
      removed += 1;
      continue;
    }

    // Our own live records (same pid + same start time) are not orphans.
    if (
      record.ownerPid === process.pid &&
      Math.abs(record.ownerStartedAtMs - ownStartedAtMs) < START_TIME_TOLERANCE_MS
    ) {
      continue;
    }

    if (isPidAlive(record.ownerPid)) {
      const ownerStart = readProcessStartTimeMs(record.ownerPid);
      if (ownerStart === null) {
        // Cannot verify the owner is really gone — fail safe, keep the record.
        continue;
      }
      if (Math.abs(ownerStart - record.ownerStartedAtMs) < START_TIME_TOLERANCE_MS) {
        // Owner process is alive and matches the record — still supervised.
        continue;
      }
      // Owner pid was reused by an unrelated process → the real owner is gone.
    }

    if (isPidAlive(record.pid)) {
      const childStart = readProcessStartTimeMs(record.pid);
      if (childStart !== null && childStart <= record.createdAtMs + START_TIME_TOLERANCE_MS) {
        try {
          killProcessTree(record.pid, opts?.graceMs ? { graceMs: opts.graceMs } : undefined);
          killed += 1;
          log.warn(
            `killed orphaned child pid=${record.pid} runId=${record.runId} argv=${record.argvPreview ?? "?"} (owner pid=${record.ownerPid} gone)`,
          );
        } catch (err) {
          log.warn(`failed to kill orphaned child pid=${record.pid}: ${String(err)}`);
        }
      } else {
        log.warn(
          `skipping orphan record runId=${record.runId}: pid=${record.pid} start time unverifiable or newer than record (likely PID reuse)`,
        );
      }
    }

    fs.rmSync(file, { force: true });
    removed += 1;
  }

  return { scanned: entries.length, killed, removed };
}
