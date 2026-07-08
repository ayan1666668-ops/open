import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ownProcessStartTimeMs,
  persistRunRecord,
  readProcessStartTimeMs,
  reconcilePersistedOrphans,
  removeRunRecord,
  resolveProcessRunsDir,
  type PersistedRunRecord,
} from "./orphans.js";

const isWindows = process.platform === "win32";

function deadPid(): number {
  // Spawn a trivial process and wait for it to exit; its pid is then dead.
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  if (!pid) {
    throw new Error("failed to obtain dead pid");
  }
  return pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not reached in time");
}

function baseRecord(overrides: Partial<PersistedRunRecord>): PersistedRunRecord {
  return {
    runId: `test-${Math.random().toString(36).slice(2)}`,
    pid: 1,
    ownerPid: 1,
    ownerStartedAtMs: Date.now(),
    createdAtMs: Date.now(),
    argvPreview: "test",
    ...overrides,
  };
}

describe.skipIf(isWindows)("orphan run records", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-orphans-"));
  });
  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("persists and removes records", () => {
    const record = baseRecord({ pid: process.pid, ownerPid: process.pid });
    persistRunRecord(record, baseDir);
    const file = path.join(resolveProcessRunsDir(baseDir), `${record.runId}.json`);
    expect(fs.existsSync(file)).toBe(true);
    removeRunRecord(record.runId, baseDir);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("reads own process start time consistently", () => {
    const viaPs = readProcessStartTimeMs(process.pid);
    expect(viaPs).not.toBeNull();
    expect(Math.abs((viaPs ?? 0) - ownProcessStartTimeMs())).toBeLessThan(10_000);
  });

  it("keeps records owned by a live matching owner", async () => {
    const record = baseRecord({
      pid: process.pid,
      ownerPid: process.pid,
      ownerStartedAtMs: ownProcessStartTimeMs(),
    });
    persistRunRecord(record, baseDir);
    const result = await reconcilePersistedOrphans({ baseDir });
    expect(result.killed).toBe(0);
    expect(fs.existsSync(path.join(resolveProcessRunsDir(baseDir), `${record.runId}.json`))).toBe(
      true,
    );
  });

  it("removes records whose owner and child are both dead", async () => {
    const gone = deadPid();
    const record = baseRecord({ pid: gone, ownerPid: gone, ownerStartedAtMs: Date.now() });
    persistRunRecord(record, baseDir);
    const result = await reconcilePersistedOrphans({ baseDir });
    expect(result.removed).toBe(1);
    expect(result.killed).toBe(0);
    expect(fs.existsSync(path.join(resolveProcessRunsDir(baseDir), `${record.runId}.json`))).toBe(
      false,
    );
  });

  it("kills a live orphan whose owner is gone", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const childPid = child.pid;
    expect(childPid).toBeTruthy();
    try {
      await waitFor(() => isAlive(childPid as number));
      const record = baseRecord({
        pid: childPid as number,
        ownerPid: deadPid(),
        ownerStartedAtMs: Date.now() - 60_000,
        createdAtMs: Date.now() + 1_000, // child started before record cutoff
      });
      persistRunRecord(record, baseDir);
      const result = await reconcilePersistedOrphans({ baseDir, graceMs: 100 });
      expect(result.killed).toBe(1);
      await waitFor(() => !isAlive(childPid as number));
    } finally {
      if (childPid && isAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
    }
  });

  it("does not kill when the child started after the record (PID reuse guard)", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const childPid = child.pid;
    expect(childPid).toBeTruthy();
    try {
      await waitFor(() => isAlive(childPid as number));
      const record = baseRecord({
        pid: childPid as number,
        ownerPid: deadPid(),
        ownerStartedAtMs: Date.now() - 120_000,
        createdAtMs: Date.now() - 60_000, // record predates the child → looks like PID reuse
      });
      persistRunRecord(record, baseDir);
      const result = await reconcilePersistedOrphans({ baseDir });
      expect(result.killed).toBe(0);
      expect(isAlive(childPid as number)).toBe(true);
      // The stale record is still cleaned up.
      expect(result.removed).toBe(1);
    } finally {
      if (childPid && isAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
    }
  });

  it("drops malformed records", async () => {
    const dir = resolveProcessRunsDir(baseDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "junk.json"), "{not json");
    const result = await reconcilePersistedOrphans({ baseDir });
    expect(result.removed).toBe(1);
    expect(fs.existsSync(path.join(dir, "junk.json"))).toBe(false);
  });
});
