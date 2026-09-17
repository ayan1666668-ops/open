// Memory Core tests cover memory watcher liveness: a lost watcher must not leave
// the index stale behind a clean dirty flag until someone reindexes by hand.
import { AsyncLocalStorage } from "node:async_hooks";
import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { FSWatcher } from "chokidar";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import { MemoryIndexManager } from "./manager.js";

const CHOKIDAR_FACTORY_KEY = Symbol.for("openclaw.test.memoryWatchFactory");
const NATIVE_FACTORY_KEY = Symbol.for("openclaw.test.memoryNativeWatchFactory");
const WATCH_DEBOUNCE_MS = 1_500;
const WATCH_PRESSURE_STARTUP_CHECK_MS = 10_000;
const SEARCH_POLL_TIMEOUT_MS = 15_000;

type FakeNativeWatcher = ReturnType<typeof createFakeNativeWatcher>;
type FakeChokidarWatcher = ReturnType<typeof createFakeChokidarWatcher>;
type ObservedAsyncContext = { turn?: string; pendingInput?: string };

function activeFilesystemWatchers() {
  return process.getActiveResourcesInfo().filter((resource) => resource === "FSEventWrap").length;
}

// A native fs.watch stand-in that never delivers events: the OS handle is dead
// from the manager's point of view, but it still accepts error listeners.
function createFakeNativeWatcher(dir: string) {
  const errorHandlers: Array<(err: Error) => void> = [];
  const watcher = {
    dir,
    closed: false,
    on: vi.fn((event: string, handler: (err: Error) => void) => {
      if (event === "error") {
        errorHandlers.push(handler);
      }
      return watcher;
    }),
    close: vi.fn(() => {
      watcher.closed = true;
    }),
    emitError: (err: Error) => {
      for (const handler of errorHandlers) {
        handler(err);
      }
    },
  };
  return watcher;
}

// A chokidar stand-in with the same public surface the manager touches. `add`
// can be made to throw so the native-error fallback path fails to restore coverage.
function createFakeChokidarWatcher(options: { addThrows: boolean }) {
  const watcher = {
    closed: false,
    on: vi.fn(() => watcher),
    once: vi.fn(() => watcher),
    add: vi.fn(() => {
      if (options.addThrows) {
        throw new Error("simulated chokidar add failure");
      }
      return watcher;
    }),
    close: vi.fn(async () => {
      watcher.closed = true;
    }),
    getWatched: vi.fn(() => ({}) as Record<string, string[]>),
  };
  return watcher;
}

function currentChokidar(manager: MemoryIndexManager): FSWatcher | null {
  const watcher = Reflect.get(manager, "watcher");
  // SAFETY: the manager keeps its chokidar instance on the protected `watcher`
  // field; the test reads it to simulate a watcher that died while still held.
  return (watcher as FSWatcher | null) ?? null;
}

function isDirty(manager: MemoryIndexManager): boolean {
  return Reflect.get(manager, "dirty") === true;
}

async function waitForChokidarReady(watcher: FSWatcher, memoryDir: string): Promise<void> {
  const target = path.resolve(memoryDir);
  await expect
    .poll(() => Object.keys(watcher.getWatched()).some((dir) => path.resolve(dir) === target), {
      timeout: SEARCH_POLL_TIMEOUT_MS,
    })
    .toBe(true);
}

async function expectSearchHit(manager: MemoryIndexManager, text: string): Promise<void> {
  await expect
    .poll(async () => (await manager.search(text)).map((result) => result.snippet), {
      timeout: SEARCH_POLL_TIMEOUT_MS,
    })
    .toContain(text);
}

async function createLivenessManager(state: { workspaceDir: string; env: NodeJS.ProcessEnv }) {
  await configureMemoryCoreDreamingStateForTests(state.env);
  const memoryDir = path.join(state.workspaceDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, "baseline.md"), "Amber lantern baseline.");
  const cfg: OpenClawConfig = {
    plugins: { enabled: false },
    agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
    memory: {
      search: {
        provider: "none",
        sources: ["memory"],
        store: { vector: { enabled: false } },
        query: { minScore: 0 },
      },
    },
  };
  const manager = await MemoryIndexManager.get({ cfg, agentId: "main" });
  if (!manager) {
    throw new Error("memory manager unavailable");
  }
  await manager.sync({ reason: "test-initial-index" });
  await expect.poll(() => isDirty(manager)).toBe(false);
  return { manager, memoryDir };
}

describe("memory watch liveness", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, CHOKIDAR_FACTORY_KEY);
    Reflect.deleteProperty(globalThis, NATIVE_FACTORY_KEY);
    resetMemoryCoreDreamingStateForTests();
  });

  it("reconciles and re-arms after a native watcher error whose chokidar fallback fails", async () => {
    const state = await createOpenClawTestState({ label: "memory-watch-liveness-error" });
    const nativeWatchers: FakeNativeWatcher[] = [];
    const chokidarWatchers: FakeChokidarWatcher[] = [];
    Reflect.set(
      globalThis,
      NATIVE_FACTORY_KEY,
      vi.fn((dir: string) => {
        const watcher = createFakeNativeWatcher(dir);
        nativeWatchers.push(watcher);
        return watcher;
      }),
    );
    Reflect.set(
      globalThis,
      CHOKIDAR_FACTORY_KEY,
      vi.fn(() => {
        const watcher = createFakeChokidarWatcher({ addThrows: true });
        chokidarWatchers.push(watcher);
        return watcher;
      }),
    );
    let manager: MemoryIndexManager | null = null;
    try {
      const created = await createLivenessManager(state);
      manager = created.manager;
      const activeManager = manager;
      const { memoryDir } = created;
      const initialNativeCount = nativeWatchers.length;
      const memoryWatcher = nativeWatchers.find((watcher) => watcher.dir === memoryDir);
      if (!memoryWatcher) {
        throw new Error("expected a native watcher on the memory directory");
      }
      expect(chokidarWatchers).toHaveLength(1);

      // The native handle dies with a non-capacity error. The manager covers the
      // gap once and tries to fall back to chokidar, but that attach fails, so
      // no watcher observes the memory directory afterwards.
      memoryWatcher.emitError(Object.assign(new Error("EIO: watcher died"), { code: "EIO" }));
      expect(memoryWatcher.close).toHaveBeenCalled();
      expect(chokidarWatchers[0]?.add).toHaveBeenCalledWith(memoryDir);
      await expect
        .poll(() => isDirty(activeManager), { timeout: SEARCH_POLL_TIMEOUT_MS })
        .toBe(true);
      await expect
        .poll(() => isDirty(activeManager), { timeout: SEARCH_POLL_TIMEOUT_MS })
        .toBe(false);

      // A file written after the loss has no watcher left to mark the index dirty.
      const text = "Cobalt heron discovered.";
      await fs.writeFile(path.join(memoryDir, "fresh.md"), text);
      await sleep(WATCH_DEBOUNCE_MS + 500);
      expect(isDirty(activeManager)).toBe(false);

      // The next search must reconcile the memory source and rebuild coverage.
      await expectSearchHit(activeManager, text);
      expect(nativeWatchers.length).toBeGreaterThan(initialNativeCount);
      expect(nativeWatchers.slice(initialNativeCount).some((w) => w.dir === memoryDir)).toBe(true);
      expect(chokidarWatchers).toHaveLength(2);
      expect(chokidarWatchers[0]?.closed).toBe(true);
    } finally {
      await manager?.close();
      await state.cleanup();
    }
  }, 60_000);

  it("reconciles and re-arms after the held chokidar watcher is closed silently", async () => {
    const state = await createOpenClawTestState({ label: "memory-watch-liveness-closed" });
    const memoryDir = path.join(state.workspaceDir, "memory");
    // Route the memory directory to chokidar by failing native watch creation
    // with a non-capacity error; chokidar itself stays real.
    Reflect.set(
      globalThis,
      NATIVE_FACTORY_KEY,
      vi.fn((dir: string) => {
        if (path.resolve(dir) === path.resolve(memoryDir)) {
          throw Object.assign(new Error("EIO: native watch unavailable"), { code: "EIO" });
        }
        return createFakeNativeWatcher(dir);
      }),
    );
    let manager: MemoryIndexManager | null = null;
    try {
      const created = await createLivenessManager(state);
      manager = created.manager;
      const activeManager = manager;
      const original = currentChokidar(activeManager);
      if (!original) {
        throw new Error("expected a chokidar watcher on the memory directory");
      }
      await waitForChokidarReady(original, memoryDir);

      // Baseline: the live watcher marks the index dirty on its own.
      const liveText = "Violet badger arrived.";
      await fs.writeFile(path.join(memoryDir, "live.md"), liveText);
      await expect
        .poll(() => isDirty(activeManager), { timeout: SEARCH_POLL_TIMEOUT_MS })
        .toBe(true);
      await expectSearchHit(activeManager, liveText);
      await expect
        .poll(() => isDirty(activeManager), { timeout: SEARCH_POLL_TIMEOUT_MS })
        .toBe(false);

      // The watcher dies without an error event while the manager still holds it.
      await original.close();
      expect(original.closed).toBe(true);
      const text = "Cobalt heron discovered.";
      await fs.writeFile(path.join(memoryDir, "fresh.md"), text);
      await sleep(WATCH_DEBOUNCE_MS + 500);
      expect(isDirty(activeManager)).toBe(false);

      // The next search must notice the dead watcher, reconcile, and re-arm.
      await expectSearchHit(activeManager, text);
      const rearmed = currentChokidar(activeManager);
      if (!rearmed) {
        throw new Error("expected the manager to re-arm a chokidar watcher");
      }
      expect(rearmed).not.toBe(original);
      expect(rearmed.closed).toBe(false);

      // The re-armed watcher observes later edits on its own again.
      await waitForChokidarReady(rearmed, memoryDir);
      const laterText = "Saffron otter returned.";
      await fs.writeFile(path.join(memoryDir, "later.md"), laterText);
      await expect
        .poll(() => isDirty(activeManager), { timeout: SEARCH_POLL_TIMEOUT_MS })
        .toBe(true);
      await expectSearchHit(activeManager, laterText);
    } finally {
      await manager?.close();
      await state.cleanup();
    }
  }, 60_000);

  it("re-arms outside the requesting turn's async context and releases the replacement on close", async () => {
    const state = await createOpenClawTestState({ label: "memory-watch-liveness-context" });
    const memoryDir = path.join(state.workspaceDir, "memory");
    const initialWatchers = activeFilesystemWatchers();
    const openWatchers = new Set<nativeFs.FSWatcher>();
    const turnContext = new AsyncLocalStorage<string>();
    const pendingInputContext = new AsyncLocalStorage<string>();
    const observeContext = (): ObservedAsyncContext => ({
      turn: turnContext.getStore(),
      pendingInput: pendingInputContext.getStore(),
    });
    const watcherContexts: ObservedAsyncContext[] = [];
    const timerContexts: ObservedAsyncContext[] = [];
    // Mirror the context-isolation probe of manager.watcher-filesystem.test.ts:
    // record the turn/input stores visible when the manager creates native
    // watchers and when its watch debounce or pressure-check timers are armed.
    const originalWatch = nativeFs.watch;
    const watchObserver = vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
      watcherContexts.push(observeContext());
      const watcher = originalWatch(...args);
      openWatchers.add(watcher);
      watcher.once("close", () => openWatchers.delete(watcher));
      return watcher;
    });
    syncBuiltinESMExports();
    const originalSetTimeout = globalThis.setTimeout;
    const timerObserver = vi.spyOn(globalThis, "setTimeout").mockImplementation((...args) => {
      if (args[1] === WATCH_DEBOUNCE_MS || args[1] === WATCH_PRESSURE_STARTUP_CHECK_MS) {
        timerContexts.push(observeContext());
      }
      return originalSetTimeout(...args);
    });
    let manager: MemoryIndexManager | null = null;
    try {
      const created = await createLivenessManager(state);
      manager = created.manager;
      const activeManager = manager;
      const original = currentChokidar(activeManager);
      if (!original) {
        throw new Error("expected a chokidar watcher for the workspace memory files");
      }
      await waitForChokidarReady(original, state.workspaceDir);
      watcherContexts.length = 0;
      timerContexts.length = 0;

      // The held chokidar watcher dies silently; a later search runs inside an
      // active turn with pending input, exactly where the loss is noticed.
      await original.close();
      expect(original.closed).toBe(true);
      await turnContext.run("requesting turn", () =>
        pendingInputContext.run("accepted input", async () => {
          expect(turnContext.getStore()).toBe("requesting turn");
          expect(pendingInputContext.getStore()).toBe("accepted input");
          await expectSearchHit(activeManager, "Amber lantern baseline.");
        }),
      );
      const rearmed = currentChokidar(activeManager);
      if (!rearmed) {
        throw new Error("expected the search to re-arm a chokidar watcher");
      }
      expect(rearmed).not.toBe(original);
      expect(rearmed.closed).toBe(false);
      expect(watcherContexts.length).toBeGreaterThan(0);

      // The replacement watcher still drives watch sync, and neither its
      // handles nor the debounce timers they arm retain the requesting turn.
      const laterText = "Saffron otter returned.";
      await fs.writeFile(path.join(memoryDir, "later.md"), laterText);
      await expect
        .poll(() => isDirty(activeManager), { timeout: SEARCH_POLL_TIMEOUT_MS })
        .toBe(true);
      await expectSearchHit(activeManager, laterText);
      expect(timerContexts.length).toBeGreaterThan(0);
      for (const context of [...watcherContexts, ...timerContexts]) {
        expect(context).toEqual({ turn: undefined, pendingInput: undefined });
      }

      // Replacement handles belong to the manager: close releases every one.
      await activeManager.close();
      await expect.poll(() => openWatchers.size).toBe(0);
      // Bun emits watcher close events but does not expose Node's FSEventWrap census.
      if (!process.versions.bun) {
        await expect.poll(activeFilesystemWatchers).toBe(initialWatchers);
      }
    } finally {
      await manager?.close();
      timerObserver.mockRestore();
      watchObserver.mockRestore();
      syncBuiltinESMExports();
      await state.cleanup();
    }
  }, 60_000);
});
