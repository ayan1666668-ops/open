import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import type { AssembleResult } from "../../../context-engine/types.js";
import { installDecisionFixture } from "../../agent-hooks/compaction-safeguard-semantic.test-support.js";
import type { AgentMessage } from "../../runtime/index.js";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const tempPaths: string[] = [];

function sourceMessages(): AgentMessage[] {
  return [
    { role: "user", content: "Keep the pending deployment unchanged.", timestamp: 1 },
    castAgentMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }],
      timestamp: 2,
    }),
    {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "Completed historical check. ".repeat(30) }],
      isError: false,
      timestamp: 3,
    },
    castAgentMessage({
      role: "assistant",
      content: [{ type: "text", text: "The deployment remains pending." }],
      timestamp: 4,
    }),
    { role: "user", content: "Continue without deploying.", timestamp: 5 },
  ];
}

function shadowConfig(kind: "absent" | "agent-disabled"): OpenClawConfig {
  return {
    agents: {
      defaults: {
        ...(kind === "agent-disabled" ? { decisionModel: "semantic-fixture/default-v1" } : {}),
        turnContextCuration: { mode: "shadow", minEstimatedTokens: 1, recentMessages: 2 },
      },
      ...(kind === "agent-disabled" ? { entries: { main: { decisionModel: "" } } } : {}),
    },
  };
}

describe("admitted embedded turn-context shadow eligibility", () => {
  beforeAll(preloadRunEmbeddedAttemptForTests);
  beforeEach(resetEmbeddedAttemptHarness);
  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it.each([
    { engine: "legacy" as const, eligibility: "absent" as const },
    { engine: "legacy" as const, eligibility: "agent-disabled" as const },
    { engine: "custom" as const, eligibility: "absent" as const },
    { engine: "custom" as const, eligibility: "agent-disabled" as const },
  ])(
    "preserves $engine views with $eligibility Decision eligibility",
    async ({ engine, eligibility }) => {
      const config = shadowConfig(eligibility);
      const { requests } = installDecisionFixture("preserved", undefined, config);
      const source = sourceMessages();
      const expectedMessages = structuredClone(source);
      const assembled: AssembleResult = { messages: source, estimatedTokens: 300 };
      let modelMessages: AgentMessage[] | undefined;

      const result = await createContextEngineAttemptRunner({
        contextEngine: {
          assemble: async () => assembled,
          info: { id: "custom-engine", name: "Custom fixture", version: "1.0.0" },
        },
        sessionKey: `agent:main:turn-context-shadow-${engine}-${eligibility}`,
        tempPaths,
        sessionMessages: source,
        attemptOverrides: {
          ...(engine === "legacy" ? { contextEngine: undefined } : {}),
          config,
        },
        sessionPrompt: async (session) => {
          modelMessages = structuredClone(session.messages as AgentMessage[]);
          session.messages = [
            ...session.messages,
            { role: "assistant", content: "done", timestamp: 6 },
          ];
        },
      });

      expect(requests).toHaveLength(0);
      expect(modelMessages).toEqual(expectedMessages);
      expect(source).toEqual(expectedMessages);
      expect(result.messagesSnapshot).toEqual([
        ...expectedMessages,
        { role: "assistant", content: "done", timestamp: 6 },
      ]);
    },
  );
});
