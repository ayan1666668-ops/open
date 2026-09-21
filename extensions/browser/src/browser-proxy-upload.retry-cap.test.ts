import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";

const probeWarns = vi.hoisted(() => [] as string[]);
const probeErrors = vi.hoisted(() => [] as string[]);

vi.mock("openclaw/plugin-sdk/runtime-env", () => {
  const logger = {
    warn: (message: unknown) => {
      probeWarns.push(String(message));
    },
    error: (message: unknown) => {
      probeErrors.push(String(message));
    },
    debug: () => {},
    trace: () => {},
    info: () => {},
    child: () => logger,
    isEnabled: () => false,
  };
  return { createSubsystemLogger: () => logger };
});

const {
  discardStagedBrowserProxyUpload,
  ensureBrowserProxyUploadCleanup,
  hasBrowserProxyUploadWork,
} = await import("./browser-proxy-upload.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const RETRY_MS = 60 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
// Captured before fake timers replace the global; fs threadpool completions
// still need real event-loop time to settle.
const realSetTimeout = setTimeout;

async function waitForReal(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, 20);
    });
  }
  throw new Error("timed out waiting for asynchronous cleanup state");
}

function recoveryWarns(): string[] {
  return probeWarns.filter((message) => message.includes("recovery failed; retrying"));
}

function recoveryErrors(): string[] {
  return probeErrors.filter((message) => message.includes("recovery gave up"));
}

function cleanupWarns(): string[] {
  return probeWarns.filter((message) => message.includes("cleanup failed; retrying"));
}

function cleanupErrors(): string[] {
  return probeErrors.filter((message) => message.includes("cleanup gave up"));
}

async function makeStagedUpload(rootPrefix: string): Promise<{
  stagingRoot: string;
  staged: string;
}> {
  const root = tempDirs.make(rootPrefix);
  const stagingRoot = path.join(root, "uploads", ".proxy-uploads");
  const staged = path.join(stagingRoot, "upload-x");
  await fs.mkdir(path.join(staged, "0"), { recursive: true });
  await fs.writeFile(path.join(staged, "f.txt"), "x");
  return { stagingRoot, staged };
}

it("bounds recovery retries and unpins active work after giving up", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const root = tempDirs.make("openclaw-browser-proxy-recovery-cap-");
  const uploadDir = path.join(root, "uploads");
  const stagingRoot = path.join(uploadDir, ".proxy-uploads");
  await fs.mkdir(stagingRoot, { recursive: true });
  await fs.chmod(stagingRoot, 0o000);
  try {
    probeWarns.length = 0;
    probeErrors.length = 0;
    // Three command-driven attempts: two retries, then a single error and give-up.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await ensureBrowserProxyUploadCleanup({ uploadDir });
    }
    expect(recoveryWarns().length).toBe(2);
    expect(recoveryErrors().length).toBe(1);
    // Further command-driven and explicit recovery entries stay silent.
    await ensureBrowserProxyUploadCleanup({ uploadDir });
    await ensureBrowserProxyUploadCleanup({ uploadDir, retentionMs: RETENTION_MS });
    expect(recoveryWarns().length).toBe(2);
    expect(recoveryErrors().length).toBe(1);
    // No retry timer was armed, so active work is unpinned.
    await waitForReal(() => !hasBrowserProxyUploadWork());
    // Even if a timer had been armed, advancing past it must stay silent.
    await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, 100);
    });
    expect(recoveryWarns().length).toBe(2);
    expect(recoveryErrors().length).toBe(1);
  } finally {
    vi.useRealTimers();
    await fs.chmod(stagingRoot, 0o700).catch(() => {});
  }
});

it("resets the recovery attempt count after a success", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const root = tempDirs.make("openclaw-browser-proxy-recovery-reset-");
  const uploadDir = path.join(root, "uploads");
  const stagingRoot = path.join(uploadDir, ".proxy-uploads");
  await fs.mkdir(stagingRoot, { recursive: true });
  await fs.chmod(stagingRoot, 0o000);
  try {
    probeWarns.length = 0;
    probeErrors.length = 0;
    await ensureBrowserProxyUploadCleanup({ uploadDir });
    expect(recoveryWarns().length).toBe(1);
    // Fault clears; the next explicit recovery succeeds and resets the count.
    await fs.chmod(stagingRoot, 0o700);
    await ensureBrowserProxyUploadCleanup({ uploadDir, retentionMs: RETENTION_MS });
    await waitForReal(() => !hasBrowserProxyUploadWork());
    // A fresh fault earns a fresh attempt budget: two warns before the give-up.
    await fs.chmod(stagingRoot, 0o000);
    await ensureBrowserProxyUploadCleanup({ uploadDir, retentionMs: RETENTION_MS });
    await ensureBrowserProxyUploadCleanup({ uploadDir, retentionMs: RETENTION_MS });
    await ensureBrowserProxyUploadCleanup({ uploadDir, retentionMs: RETENTION_MS });
    expect(recoveryWarns().length).toBe(3);
    expect(recoveryErrors().length).toBe(1);
  } finally {
    vi.useRealTimers();
    await fs.chmod(stagingRoot, 0o700).catch(() => {});
  }
});

it("bounds cleanup retries and unpins active work after giving up", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const { staged } = await makeStagedUpload("openclaw-browser-proxy-cleanup-cap-");
  await fs.chmod(staged, 0o000);
  try {
    probeWarns.length = 0;
    probeErrors.length = 0;
    await discardStagedBrowserProxyUpload({ body: {}, directory: staged });
    expect(cleanupWarns().length).toBe(1);
    expect(hasBrowserProxyUploadWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await waitForReal(() => cleanupWarns().length >= 2);
    expect(hasBrowserProxyUploadWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await waitForReal(() => cleanupErrors().length >= 1);
    expect(cleanupWarns().length).toBe(2);
    // Giving up cleared the pending retry timer, so active work is unpinned.
    await waitForReal(() => !hasBrowserProxyUploadWork());
    // No further retries fire after the give-up.
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, 100);
    });
    expect(cleanupWarns().length).toBe(2);
    expect(cleanupErrors().length).toBe(1);
  } finally {
    vi.useRealTimers();
    await fs.chmod(staged, 0o700).catch(() => {});
  }
});

it("resets the cleanup attempt count after a success", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const first = await makeStagedUpload("openclaw-browser-proxy-cleanup-reset-a-");
  await fs.chmod(first.staged, 0o000);
  try {
    probeWarns.length = 0;
    probeErrors.length = 0;
    await discardStagedBrowserProxyUpload({ body: {}, directory: first.staged });
    expect(cleanupWarns().length).toBe(1);
    // Fault clears; the armed retry succeeds, removes the directory, resets count.
    await fs.chmod(first.staged, 0o700);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await waitForReal(() => !hasBrowserProxyUploadWork());
    // A fresh fault on a new staged upload earns a fresh attempt budget.
    const second = await makeStagedUpload("openclaw-browser-proxy-cleanup-reset-b-");
    await fs.chmod(second.staged, 0o000);
    await discardStagedBrowserProxyUpload({ body: {}, directory: second.staged });
    expect(cleanupWarns().length).toBe(2);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await waitForReal(() => cleanupWarns().length >= 3);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await waitForReal(() => cleanupErrors().length >= 1);
    expect(cleanupWarns().length).toBe(3);
    expect(cleanupErrors().length).toBe(1);
    await fs.chmod(second.staged, 0o700).catch(() => {});
  } finally {
    vi.useRealTimers();
    await fs.chmod(first.staged, 0o700).catch(() => {});
  }
});
