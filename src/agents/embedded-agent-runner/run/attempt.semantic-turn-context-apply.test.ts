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

function eligibleAssembly(): AssembleResult {
  const messages: AgentMessage[] = [
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
  return {
    messages,
    estimatedTokens: 300,
    semanticCurationCandidates: {
      discretionaryMessageIndexes: [1, 2],
      requiredIdentifiers: [],
    },
  };
}

function applyConfig(kind: "absent" | "agent-disabled"): OpenClawConfig {
  return {
    agents: {
      defaults: {
        ...(kind === "agent-disabled" ? { decisionModel: "semantic-fixture/default-v1" } : {}),
        turnContextCuration: {
          mode: "apply",
          minEstimatedTokens: 1,
          recentMessages: 2,
          economics: {
            modelId: "gpt-test",
            savedMsPerEstimatedToken: 100,
            decisionOverheadMs: 1,
            cachePenaltyMs: 1,
          },
        },
      },
      ...(kind === "agent-disabled" ? { entries: { main: { decisionModel: "" } } } : {}),
    },
  };
}

describe("admitted embedded turn-context apply eligibility", () => {
  beforeAll(preloadRunEmbeddedAttemptForTests);
  beforeEach(resetEmbeddedAttemptHarness);
  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it.each([
    { label: "global decision model is absent", kind: "absent" as const },
    { label: "owning agent explicitly disables decisions", kind: "agent-disabled" as const },
  ])("preserves model and transcript views when $label", async ({ kind }) => {
    const config = applyConfig(kind);
    const { requests } = installDecisionFixture("preserved", undefined, config);
    const assembled = eligibleAssembly();
    const expectedMessages = structuredClone(assembled.messages);
    let modelMessages: AgentMessage[] | undefined;

    const result = await createContextEngineAttemptRunner({
      contextEngine: {
        assemble: async () => assembled,
        info: { id: "attested-engine", name: "Owner-attested fixture", version: "1.0.0" },
      },
      sessionKey: `agent:main:turn-context-apply-${kind}`,
      tempPaths,
      sessionMessages: assembled.messages,
      attemptOverrides: { config },
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
    expect(result.messagesSnapshot).toEqual([
      ...expectedMessages,
      { role: "assistant", content: "done", timestamp: 6 },
    ]);
    expect(assembled.messages).toEqual(expectedMessages);
  });
});
