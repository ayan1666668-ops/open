import path from "node:path";
import { createDeferred } from "../../../test/helpers/promise.js";
import { onSubagentRegistryPersisted } from "../../agents/subagents/registry/subagent-registry-state.js";
import {
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { getAgentTestMocks } from "./agent.test-harness.js";

// Shared by ACP manual spawns, plugin subagents, and native subagent handler fixtures.
export function mockSpawnedChildSessionEntry(childSessionKey: string, root: string) {
  const mocks = getAgentTestMocks();
  // The real transcript target reader must stay inside this fixture's state directory.
  mocks.userTurnStorePath = path.join(root, "agents", "main", "sessions", "sessions.json");
  mocks.loadSessionEntry.mockReturnValue({
    cfg: {},
    storePath: mocks.userTurnStorePath,
    entry: { sessionId: "spawned-child-session", updatedAt: Date.now() },
    canonicalKey: childSessionKey,
  });
  mocks.updateSessionStore.mockResolvedValue(undefined);
  mocks.agentCommand.mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: { durationMs: 100 },
  });
}

export function createPluginSubagentTestLifetime(params: {
  root: string;
  runId: string;
  childSessionKey: string;
}) {
  const work = new AsyncWorkScope();
  const cleanupCompleted = createDeferred();
  const unsubscribe = onSubagentRegistryPersisted(() => {
    const entry = getSubagentRunByChildSessionKey(params.childSessionKey);
    if (entry?.runId === params.runId && entry.cleanupCompletedAt) {
      cleanupCompleted.resolve();
    }
  });
  return {
    work,
    cleanupCompleted: cleanupCompleted.promise,
    async [Symbol.asyncDispose]() {
      unsubscribe();
      await work.drain();
      resetSubagentRegistryForTests({ persist: false });
      await cleanupSessionStateForTest({ stateDir: params.root });
    },
  };
}
