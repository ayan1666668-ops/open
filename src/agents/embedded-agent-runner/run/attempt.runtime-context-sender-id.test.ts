// The recall path must hand context engines the same runtime identity the
// capture path gets: engines that route recall by senderId silently lose
// per-user namespacing when assemble() receives no runtimeContext.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryPluginState } from "../../../plugins/memory-state.test-fixtures.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { AttemptContextEngine } from "./attempt-context-engine-helpers.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();

type CapturedRuntimeContext = Record<string, unknown> | undefined;

function makeCapturingContextEngine(bucket: {
  assemble: CapturedRuntimeContext[];
  afterTurn: CapturedRuntimeContext[];
}): AttemptContextEngine {
  return {
    info: {
      id: "test-context-engine",
      name: "Test Context Engine",
      version: "0.0.1",
    },
    assemble: async (params) => {
      bucket.assemble.push((params as { runtimeContext?: CapturedRuntimeContext }).runtimeContext);
      return { messages: params.messages, estimatedTokens: 1 };
    },
    ingest: async () => ({ ingested: true }),
    afterTurn: async (params) => {
      bucket.afterTurn.push((params as { runtimeContext?: CapturedRuntimeContext }).runtimeContext);
    },
  } as AttemptContextEngine;
}

describe("runEmbeddedAttempt runtime context sender identity", () => {
  const sessionKey = "agent:main:guildchat:channel:test-runtime-sender";
  const tempPaths: string[] = [];

  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    clearMemoryPluginState();
    hoisted.runContextEngineMaintenanceMock.mockReset().mockResolvedValue(undefined);
    hoisted.detectAndLoadPromptImagesMock.mockClear();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    clearMemoryPluginState();
    vi.restoreAllMocks();
  });

  it("threads the attempt sender identity into pre-turn assemble like afterTurn", async () => {
    const captured = { assemble: [], afterTurn: [] } as {
      assemble: CapturedRuntimeContext[];
      afterTurn: CapturedRuntimeContext[];
    };
    const result = await createContextEngineAttemptRunner({
      contextEngine: makeCapturingContextEngine(captured),
      sessionKey,
      tempPaths,
      attemptOverrides: {
        senderId: "user-42",
      },
    });

    expect(projectAgentRunAttemptTerminal(result.terminal).promptError).toBeNull();
    expect(captured.assemble.length).toBeGreaterThan(0);
    expect(captured.assemble[0]?.senderId).toBe("user-42");
    expect(captured.afterTurn.length).toBeGreaterThan(0);
    expect(captured.afterTurn[0]?.senderId).toBe("user-42");
  });
});
