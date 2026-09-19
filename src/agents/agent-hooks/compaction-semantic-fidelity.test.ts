import { describe, expect, it, vi } from "vitest";
import type { DecisionOutcome } from "../../decisions/types.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  isCompactionSemanticRepairFinding,
  observeCompactionSemanticFidelity,
} from "./compaction-semantic-fidelity.js";

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}

describe("compaction semantic fidelity", () => {
  it("skips user content already preserved verbatim", async () => {
    const evaluate = vi.fn(
      async () =>
        ({
          status: "unavailable",
          reason: "not-configured",
        }) satisfies DecisionOutcome,
    );
    const result = await observeCompactionSemanticFidelity(
      {
        sourceMessages: [user("Keep production untouched."), user("Deploy staging.")],
        retainedContext: "Deploy staging.",
        signal: new AbortController().signal,
      },
      evaluate,
    );

    expect(result.verbatimPreserved).toBe(1);
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          sourceItems: [expect.objectContaining({ text: "Keep production untouched." })],
        }),
      }),
      expect.any(Object),
    );
  });

  it("returns no-candidates without calling the judgment runtime", async () => {
    const evaluate = vi.fn();
    const result = await observeCompactionSemanticFidelity(
      {
        sourceMessages: [user("Deploy staging.")],
        retainedContext: "Deploy staging.",
        signal: new AbortController().signal,
      },
      evaluate,
    );

    expect(result.status).toBe("no-candidates");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("preserves choice distributions and provenance", async () => {
    const outcome: DecisionOutcome = {
      status: "ok",
      result: {
        model: "fixture",
        answers: {
          "recent-user-1": {
            type: "choice",
            choice: "contradicted",
            probabilities: {
              preserved: 0.01,
              missing: 0.03,
              contradicted: 0.9,
              inactive_or_completed: 0.01,
              uncertain: 0.05,
            },
            confidence: 0.88,
          },
        },
        usage: { inputTokens: 42, outputTokens: 0 },
      },
      provenance: {
        providerId: "fixture",
        rubricVersion: "1",
        runtimeGeneration: "generation",
      },
    };
    const evaluate = vi.fn(async () => outcome);

    const result = await observeCompactionSemanticFidelity(
      {
        sourceMessages: [user("Use staging only. Production is not authorized.")],
        retainedContext: "Deploy to production.",
        signal: new AbortController().signal,
      },
      evaluate,
    );

    expect(result).toMatchObject({
      status: "ok",
      providerId: "fixture",
      model: "fixture",
      findings: [
        {
          relation: "contradicted",
          sourceText: "Use staging only. Production is not authorized.",
          sourceTruncated: false,
          confidence: 0.88,
          probabilities: { contradicted: 0.9 },
        },
      ],
    });
    expect(evaluate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ agentId: undefined }),
    );
  });

  it("passes the compaction owner to the decision runtime", async () => {
    const evaluate = vi.fn(
      async () =>
        ({
          status: "unavailable",
          reason: "not-configured",
        }) satisfies DecisionOutcome,
    );

    await observeCompactionSemanticFidelity(
      {
        sourceMessages: [user("Keep production untouched.")],
        retainedContext: "Deployment notes.",
        agentId: "specialist",
        signal: new AbortController().signal,
      },
      evaluate,
    );

    expect(evaluate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ agentId: "specialist" }),
    );
  });

  it("only qualifies strong missing or contradicted findings with complete source evidence", () => {
    expect(
      isCompactionSemanticRepairFinding({
        id: "one",
        relation: "missing",
        sourceText: "Keep production untouched.",
        sourceTruncated: false,
        probabilities: { missing: 0.84 },
      }),
    ).toBe(true);
    expect(
      isCompactionSemanticRepairFinding({
        id: "two",
        relation: "contradicted",
        sourceText: "Keep production untouched.",
        sourceTruncated: false,
        probabilities: { contradicted: 0.79 },
      }),
    ).toBe(false);
    expect(
      isCompactionSemanticRepairFinding({
        id: "three",
        relation: "missing",
        sourceText: "Keep production untouched.",
        sourceTruncated: true,
        probabilities: { missing: 0.99 },
      }),
    ).toBe(false);
    expect(
      isCompactionSemanticRepairFinding({
        id: "four",
        relation: "uncertain",
        sourceText: "Keep production untouched.",
        sourceTruncated: false,
        probabilities: { uncertain: 0.99 },
      }),
    ).toBe(false);
  });

  it("checks omitted tool evidence alongside user requirements", async () => {
    const outcome: DecisionOutcome = {
      status: "ok",
      result: {
        model: "fixture",
        answers: {
          "curated-tool-result-1": {
            type: "choice",
            choice: "missing",
            probabilities: {
              preserved: 0.01,
              missing: 0.94,
              contradicted: 0.01,
              inactive_or_completed: 0.01,
              uncertain: 0.03,
            },
          },
        },
      },
      provenance: {
        providerId: "fixture",
        rubricVersion: "1",
        runtimeGeneration: "generation",
      },
    };
    const evaluate = vi.fn(async () => outcome);

    const result = await observeCompactionSemanticFidelity(
      {
        sourceMessages: [],
        retainedContext: "The build completed.",
        additionalSourceItems: [
          {
            id: "curated-tool-result-1",
            text: "Tool result (exec):\nCritical artifact path: /tmp/report.json",
          },
        ],
        signal: new AbortController().signal,
      },
      evaluate,
    );

    expect(result).toMatchObject({
      status: "ok",
      findings: [
        {
          id: "curated-tool-result-1",
          relation: "missing",
          sourceTruncated: false,
        },
      ],
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("returns provider unavailability without inventing a semantic result", async () => {
    const evaluate = vi.fn(
      async () =>
        ({
          status: "unavailable",
          reason: "circuit-open",
        }) satisfies DecisionOutcome,
    );

    const result = await observeCompactionSemanticFidelity(
      {
        sourceMessages: [user("Keep production untouched.")],
        retainedContext: "Deployment notes.",
        signal: new AbortController().signal,
      },
      evaluate,
    );

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "circuit-open",
      checked: 1,
    });
  });
});
