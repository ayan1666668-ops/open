import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../../../logging/diagnostic-session-state.js";
import { recordLoopOutcome } from "../../agent-tools.before-tool-call.diagnostics.js";
import type { HookContext } from "../../agent-tools.before-tool-call.types.js";
import { admitToolCallBatch } from "../../tool-loop-admission.js";
import { createRunToolOutcomeState } from "./tool-outcome-state.js";

const decisionMocks = vi.hoisted(() => ({
  evaluateDecision: vi.fn(),
}));

vi.mock("../../../decisions/runtime.js", () => ({
  evaluateDecision: decisionMocks.evaluateDecision,
}));

const repeatedArgs = { path: "/synthetic/repeated" };
const repeatedResult = {
  content: [{ type: "text", text: "unchanged" }],
  details: { source: "fixture" },
};

function configWithDecisionModel(decisionModel: string | undefined): OpenClawConfig {
  return {
    agents: {
      defaults: {
        ...(decisionModel === undefined ? {} : { decisionModel }),
      },
    },
    tools: { loopDetection: { enabled: true, semanticNoProgress: "shadow" } },
  };
}

function createState(config: OpenClawConfig, agentId = "main") {
  return createRunToolOutcomeState({
    config,
    agentId,
    signal: new AbortController().signal,
    laneTaskAbortController: new AbortController(),
    assertAdmittedActive: vi.fn(),
    goal: "Finish without repeating unchanged reads",
  });
}

async function driveRepeatedResults(params: {
  config: OpenClawConfig;
  agentId?: string;
  state: ReturnType<typeof createState>;
}) {
  const agentId = params.agentId ?? "main";
  const sessionKey = `semantic-no-progress-${agentId}`;
  const runId = `run-${agentId}`;
  const ctx: HookContext = {
    agentId,
    sessionKey,
    sessionId: sessionKey,
    runId,
    loopDetection: params.state.resolvedLoopDetectionConfig,
    semanticNoProgressObserver: params.state.semanticNoProgressObserver,
  };
  const warningCounts: number[] = [];

  for (let index = 0; index < 20; index += 1) {
    const toolCallId = `repeat-${index}`;
    const candidate = {
      toolCall: {
        type: "toolCall" as const,
        id: toolCallId,
        name: "read",
        arguments: repeatedArgs,
      },
      args: repeatedArgs,
    };
    const admission = await admitToolCallBatch([candidate], ctx);
    if (admission.warnings?.[0]) {
      warningCounts.push(admission.warnings[0].count);
    }
    expect(admission.intervention).toBeUndefined();
    admission.commitReadyCalls?.([{ toolCallId, args: repeatedArgs }]);
    await recordLoopOutcome({
      ctx,
      toolName: "read",
      toolParams: repeatedArgs,
      toolCallId,
      result: repeatedResult,
      toolCallOrdinal: index + 1,
    });
  }

  const critical = await admitToolCallBatch(
    [
      {
        toolCall: {
          type: "toolCall" as const,
          id: "critical",
          name: "read",
          arguments: repeatedArgs,
        },
        args: repeatedArgs,
      },
    ],
    ctx,
  );
  const history = getDiagnosticSessionState({
    sessionKey,
    sessionId: sessionKey,
  }).toolCallHistory;
  return { critical, history, warningCounts };
}

describe("run-owned semantic no-progress observation", () => {
  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    decisionMocks.evaluateDecision.mockReset();
  });

  it.each([
    ["an absent global decision model", configWithDecisionModel(undefined), "main"],
    [
      "an empty owning-agent override",
      {
        ...configWithDecisionModel("fixture/judge"),
        agents: {
          defaults: { decisionModel: "fixture/judge" },
          entries: { worker: { decisionModel: "" } },
        },
      } satisfies OpenClawConfig,
      "worker",
    ],
  ])("preserves deterministic loop behavior with %s", async (_label, config, agentId) => {
    const state = createState(config, agentId);

    expect(state.semanticNoProgressObserver).toBeUndefined();
    const originalResult = structuredClone(repeatedResult);
    const result = await driveRepeatedResults({ config, agentId, state });

    expect(repeatedResult).toEqual(originalResult);
    expect(result.warningCounts).toEqual([10]);
    expect(result.history).toHaveLength(21);
    expect(result.history?.slice(0, 20)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: "read", resultHash: expect.any(String) }),
      ]),
    );
    expect(new Set(result.history?.slice(0, 20).map((entry) => entry.resultHash))).toHaveLength(1);
    expect(result.history?.at(-1)).toMatchObject({ outcomeKind: "tool-loop-veto" });
    expect(result.critical.intervention).toMatchObject({
      kind: "critical-tool-loop",
      detector: "generic_repeat",
      count: 20,
    });
    expect(decisionMocks.evaluateDecision).not.toHaveBeenCalled();
  });

  it("keeps a stalled shadow verdict non-authoritative at the critical loop boundary", async () => {
    decisionMocks.evaluateDecision.mockResolvedValue({
      status: "ok",
      provenance: {
        providerId: "fixture",
        rubricVersion: "semantic-no-progress-shadow-v1",
        runtimeGeneration: "fixture",
      },
      result: {
        model: "fixture/judge",
        answers: {
          verdict: { type: "choice", choice: "stalled", probabilities: { stalled: 1 } },
        },
      },
    });
    const config = configWithDecisionModel("fixture/judge");
    const state = createState(config);

    const result = await driveRepeatedResults({ config, state });

    expect(decisionMocks.evaluateDecision).toHaveBeenCalled();
    expect(state.semanticNoProgressObserver?.snapshot().latestJudgment?.verdict).toBe("stalled");
    expect(result.warningCounts).toEqual([10]);
    expect(result.critical.intervention).toMatchObject({
      kind: "critical-tool-loop",
      detector: "generic_repeat",
      count: 20,
    });
    await state.semanticNoProgressObserver?.close();
  });
});
