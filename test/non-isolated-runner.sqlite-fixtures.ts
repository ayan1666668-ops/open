import path from "node:path";

export function sqliteLifecycleFixtureFiles(repoRoot: string): Record<string, string> {
  const source = (name: string) => JSON.stringify(path.join(repoRoot, "src", name));
  return {
    "11-a-sqlite-owner.test.ts": `
import { afterAll, expect, it, vi } from "vitest";
import path from "node:path";
vi.mock(${source("infra/runtime-worker-url.ts")}, () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/shared-state.worker.js"),
}));
import { isSqliteWorkerStoreAvailable } from ${source("infra/sqlite-worker-store.ts")};
import { registerOpenClawStateDatabaseAsyncResource } from ${source("state/openclaw-state-db-cache.ts")};
import { openOpenClawStateWorkerCleanupStore } from ${source("state/openclaw-state-worker-store.ts")};
import { openOpenClawAgentDatabase } from ${source("state/openclaw-agent-db.ts")};
const drainKey = Symbol.for("fixture.sqliteDrain");
it("retains a real shared-state owner after host admission is refused", async () => {
  expect(isSqliteWorkerStoreAvailable({})).toBe(false);
  await expect(openOpenClawStateWorkerCleanupStore("/synthetic/state.sqlite", {
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
    coordinatorRuntime: { directory: "/synthetic/coordinators", keepAlive: false },
  }, () => {})).rejects.toMatchObject({ code: "unavailable" });
  const database = openOpenClawAgentDatabase({
    agentId: "fixture",
    env: { OPENCLAW_STATE_DIR: path.join(import.meta.dirname, "agent-state") },
  });
  const retained = { database, drains: 0 };
  Reflect.set(globalThis, drainKey, retained);
  registerOpenClawStateDatabaseAsyncResource({ async close() {
    expect(Reflect.get(globalThis, drainKey)).toBe(retained);
    expect(database.db.isOpen).toBe(false);
    expect(retained.drains).toBe(0);
    await Promise.resolve();
    retained.drains++;
  } });
});
afterAll(() => {
  const retained = Reflect.get(globalThis, drainKey);
  expect(retained.database.db.isOpen).toBe(true);
  expect(retained.drains).toBe(0);
  vi.resetModules();
});
`,
    "11-b-sqlite-cleanup.test.ts": `
import { expect } from "vitest";
import ${source("state/openclaw-agent-execution-cleanup.test.ts")};
const drainKey = Symbol.for("fixture.sqliteDrain");
const retained = Reflect.get(globalThis, drainKey);
expect(retained.drains).toBe(1);
expect(retained.database.db.isOpen).toBe(false);
Reflect.deleteProperty(globalThis, drainKey);
`,
  };
}
