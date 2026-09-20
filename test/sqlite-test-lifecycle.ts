import path from "node:path";
import { normalizeModuleId, type EvaluatedModuleNode } from "vite/module-runner";
import { vi } from "vitest";

const source = (name: string) => normalizeModuleId(path.resolve(import.meta.dirname, "..", name));
const agentSource = source("src/state/openclaw-agent-db-lifecycle.ts");
const agentKey = Symbol.for("openclaw.agentDatabaseLifecycle");
const resetKey = Symbol.for("openclaw.globalSingletonLifecycleResets");

// These owners retain module closures and each other's lifecycle callbacks.
// Keep their native custody intact through drainage, then retire the whole generation.
export const sqliteTestSingletonPublications: ReadonlyMap<string, symbol> = new Map([
  [
    source("src/state/openclaw-state-worker-store.ts"),
    Symbol.for("openclaw.sharedStateWorkerOwner"),
  ],
  [source("src/infra/sqlite-worker-store.ts"), Symbol.for("openclaw.sqliteWorkerBroker")],
  [source("src/state/openclaw-state-db-cache.ts"), Symbol.for("openclaw.stateDatabaseLifecycle")],
  [agentSource, agentKey],
]);

type AgentLifecycleModule = Pick<
  typeof import("../src/state/openclaw-agent-db-lifecycle.js"),
  "agentDatabaseLifecycle" | "closeOpenClawAgentDatabasesAsync"
>;

/** Agent lease cleanup still needs its original shared-state owner and broker. */
export async function drainSqliteTestAgentOwner(
  modules: Iterable<EvaluatedModuleNode>,
  executions: ReadonlyMap<string, { external?: boolean }>,
): Promise<void> {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const owner = globalStore[agentKey] as AgentLifecycleModule["agentDatabaseLifecycle"] | undefined;
  const resources = globalStore[Symbol.for("openclaw.agentDatabaseAsyncResources")] as
    | { active: Set<unknown>; closing: Map<unknown, unknown>; selections: Set<unknown> }
    | undefined;
  const hasCustody = () =>
    Boolean(
      owner &&
      (owner.databases.size ||
        owner.leases.size ||
        owner.pending.size ||
        owner.activePending.size ||
        owner.retainedCloses.size),
    ) ||
    Boolean(
      resources && (resources.active.size || resources.closing.size || resources.selections.size),
    );
  if (!hasCustody()) {
    return;
  }
  for (const node of modules) {
    if (node.file !== agentSource) {
      continue;
    }
    const execution = executions.get(node.id.startsWith("mock:") ? node.id.slice(5) : node.id);
    const exports = node.exports as Partial<AgentLifecycleModule> | undefined;
    if (
      execution &&
      !execution.external &&
      exports &&
      exports.agentDatabaseLifecycle === owner &&
      typeof exports.closeOpenClawAgentDatabasesAsync === "function" &&
      !vi.isMockFunction(exports.closeOpenClawAgentDatabasesAsync)
    ) {
      await exports.closeOpenClawAgentDatabasesAsync();
      break;
    }
  }
  // A module reset can erase the real closer. Never load a replacement under the
  // file's mocks or abandon handles just to make the next file start cleanly.
  if (hasCustody()) {
    throw new Error(
      "SQLite test teardown cannot retire agent owners with unsettled database custody",
    );
  }
}

/** Called only for an evaluated source generation, after successful owner drainage. */
export function retireSqliteTestSingleton(key: symbol): void {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const resets = globalStore[resetKey] as Map<symbol, unknown> | undefined;
  Reflect.deleteProperty(globalStore, key);
  resets?.delete(key);
}
