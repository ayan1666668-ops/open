import path from "node:path";

export function sqliteLifecycleFixtureFiles(repoRoot: string): Record<string, string> {
  const source = (name: string) => JSON.stringify(path.join(repoRoot, "src", name));
  return {
    "11-a-sqlite-owner.test.ts": `
import { afterAll, expect, it, vi } from "vitest";
vi.mock("node:worker_threads", () => ({ isMainThread: false }));
vi.mock(${source("infra/runtime-worker-url.ts")}, () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/shared-state.worker.js"),
}));
import { isSqliteWorkerStoreAvailable } from ${source("infra/sqlite-worker-store.ts")};
import { registerOpenClawStateDatabaseAsyncResource } from ${source("state/openclaw-state-db-cache.ts")};
import { openOpenClawStateWorkerCleanupStore } from ${source("state/openclaw-state-worker-store.ts")};
const drainKey = Symbol.for("fixture.sqliteDrain");
it("retains a real shared-state owner after host admission is refused", async () => {
  expect(isSqliteWorkerStoreAvailable({})).toBe(false);
  await expect(openOpenClawStateWorkerCleanupStore("/synthetic/state.sqlite", {
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
    coordinatorRuntime: { directory: "/synthetic/coordinators", keepAlive: false },
  }, () => {})).rejects.toMatchObject({ code: "unavailable" });
  Reflect.set(globalThis, drainKey, 0);
  registerOpenClawStateDatabaseAsyncResource({ async close() {
    expect(Reflect.get(globalThis, drainKey)).toBe(0);
    await Promise.resolve();
    Reflect.set(globalThis, drainKey, 1);
  } });
});
afterAll(() => expect(Reflect.get(globalThis, drainKey)).toBe(0));
`,
    "11-b-sqlite-cleanup.test.ts": `
import { expect } from "vitest";
import ${source("state/openclaw-agent-execution-cleanup.test.ts")};
const drainKey = Symbol.for("fixture.sqliteDrain");
expect(Reflect.get(globalThis, drainKey)).toBe(1);
Reflect.deleteProperty(globalThis, drainKey);
`,
  };
}
