import { describe, expect, it, vi } from "vitest";
import type { JudgmentRuntimeV1 } from "../../judgments/types.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  evaluateCompactionFidelity,
  evaluateCompactionShadowCuration,
} from "./compaction-safeguard-semantic-judgments.js";
import {
  buildCompactionSemanticSnapshot,
  projectCompactionSemanticSelection,
} from "./compaction-safeguard-semantic.js";

function message(value: unknown): AgentMessage {
  return value as AgentMessage;
}

function runtimeWithChoices(
  choices: Record<string, string>,
): JudgmentRuntimeV1 {
  return {
    recordOutcome: vi.fn(async () => {}),
    evaluate: vi.fn(async (batch, options) => {
      options.signal.throwIfAborted();
      const answers = Object.fromEntries(
        Object.entries(batch.questions).map(([id, question]) => {
          if (question.type !== "choice") {
            throw new Error("expected choice question");
          }
          const labels = Object.keys(question.criteria);
          const selected = choices[id] ?? labels[0];
          return [
            id,
            {
              type: "choice" as const,
              choice: selected,
              probabilities: Object.fromEntries(
                labels.map((label) => [label, label === selected ? 1 : 0]),
              ),
            },
          ];
        }),
      );
      return {
        status: "ok" as const,
        result: {
          model: "test-judgment",
          answers,
          usage: { inputTokens: 10, outputTokens: 2 },
        },
        provenance: {
          providerId: "test",
          rubricVersion: "test",
          runtimeGeneration: "generation-1",
        },
      };
    }),
  };
}

describe("compaction semantic snapshot", () => {
  it("keeps tool calls and their results in one source segment", () => {
    const user = message({
      role: "user",
      content: [{ type: "text", text: "Update the deployment but keep port 18789." }],
    });
    const assistant = message({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "exec", input: { cmd: "deploy" } }],
    });
    const toolResult = message({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "exec",
      content: [{ type: "text", text: "deployment complete" }],
    });
    const tail = message({
      role: "assistant",
      content: [{ type: "text", text: "Deployment is complete." }],
    });

    const snapshot = buildCompactionSemanticSnapshot({
      messages: [user, assistant, toolResult, tail],
      protectedMessages: new Set([user]),
      identifiers: ["18789"],
      latestUserAsk: "Update the deployment but keep port 18789.",
    });

    expect(snapshot.segments).toHaveLength(3);
    expect(snapshot.segments[1]?.sourceIndexes).toEqual([1, 2]);
    expect(snapshot.segments[0]?.protected).toBe(true);
    expect(snapshot.obligations[0]?.sourceSegmentId).toBe(snapshot.segments[0]?.id);
  });

  it("treats oversized source conservatively instead of making it droppable", () => {
    const oversized = message({
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(7_000) }],
    });
    const snapshot = buildCompactionSemanticSnapshot({
      messages: [oversized],
      latestUserAsk: "keep going",
    });

    expect(snapshot.segments[0]?.protected).toBe(true);
    expect(snapshot.segments[0]?.protectionReasons).toContain("oversized-segment");
    expect(snapshot.complete).toBe(false);
  });

  it("protects unsupported non-text source and marks coverage incomplete", () => {
    const image = message({
      role: "user",
      content: [{ type: "image", mimeType: "image/png", data: "synthetic" }],
    });
    const snapshot = buildCompactionSemanticSnapshot({ messages: [image] });

    expect(snapshot.segments[0]?.protected).toBe(true);
    expect(snapshot.segments[0]?.protectionReasons).toContain("unsupported-content");
    expect(snapshot.complete).toBe(false);
  });

});

describe("compaction semantic judgments", () => {
  it("projects only a complete validated selection and preserves source order", async () => {
    const user = message({
      role: "user",
      content: [{ type: "text", text: "Deploy production." }],
    });
    const oldFact = message({
      role: "assistant",
      content: [{ type: "text", text: "Old unrelated weather." }],
    });
    const usefulFact = message({
      role: "assistant",
      content: [{ type: "text", text: "Production uses the current release." }],
    });
    const messages = [user, oldFact, usefulFact];
    const snapshot = buildCompactionSemanticSnapshot({
      messages,
      latestUserAsk: "Deploy production.",
    });
    const discretionary = snapshot.segments.filter((segment) => !segment.protected);
    const runtime = runtimeWithChoices({
      [discretionary[0]!.id]: "drop",
      [discretionary[1]!.id]: "keep",
    });
    const selection = await evaluateCompactionShadowCuration({
      runtime,
      snapshot,
      signal: new AbortController().signal,
    });

    const projected = projectCompactionSemanticSelection({
      messages,
      snapshot,
      selection,
    });

    expect(projected).toEqual([user, usefulFact]);
  });

  it("refuses an incomplete semantic selection", () => {
    const user = message({
      role: "user",
      content: [{ type: "text", text: "Keep this request." }],
    });
    const fact = message({
      role: "assistant",
      content: [{ type: "text", text: "Optional detail." }],
    });
    const messages = [user, fact];
    const snapshot = buildCompactionSemanticSnapshot({
      messages,
      latestUserAsk: "Keep this request.",
    });

    expect(
      projectCompactionSemanticSelection({
        messages,
        snapshot,
        selection: {
          status: "skipped",
          sourceFingerprint: snapshot.sourceFingerprint,
          reason: "test",
          selectedSegmentIds: snapshot.segments.map((segment) => segment.id),
          excludedSegmentIds: [],
          uncertainSegmentIds: [],
          evaluatedSegmentIds: [],
          originalChars: snapshot.originalChars,
          selectedChars: snapshot.originalChars,
          reductionRatio: 0,
          complete: false,
        },
      }),
    ).toBeNull();
  });

  it("produces a conservative shadow selection without mutating source", async () => {
    const user = message({
      role: "user",
      content: [{ type: "text", text: "Finish the current deployment." }],
    });
    const oldFact = message({
      role: "assistant",
      content: [{ type: "text", text: "Old unrelated weather discussion." }],
    });
    const usefulFact = message({
      role: "assistant",
      content: [{ type: "text", text: "Deployment target is production." }],
    });
    const snapshot = buildCompactionSemanticSnapshot({
      messages: [user, oldFact, usefulFact],
      latestUserAsk: "Finish the current deployment.",
    });
    const discretionary = snapshot.segments.filter((segment) => !segment.protected);
    expect(discretionary).toHaveLength(2);

    const runtime = runtimeWithChoices({
      [discretionary[0]!.id]: "drop",
      [discretionary[1]!.id]: "uncertain",
    });
    const controller = new AbortController();
    const result = await evaluateCompactionShadowCuration({
      runtime,
      snapshot,
      signal: controller.signal,
      timeoutMs: 500,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    expect(result.excludedSegmentIds).toEqual([discretionary[0]!.id]);
    expect(result.uncertainSegmentIds).toEqual([discretionary[1]!.id]);
    expect(result.selectedSegmentIds).toContain(discretionary[1]!.id);
    expect(snapshot.segments).toHaveLength(3);
  });

  it("refuses to project a selection onto a different source revision", async () => {
    const user = message({
      role: "user",
      content: [{ type: "text", text: "Deploy production." }],
    });
    const fact = message({
      role: "assistant",
      content: [{ type: "text", text: "Production uses release A." }],
    });
    const snapshot = buildCompactionSemanticSnapshot({
      messages: [user, fact],
      latestUserAsk: "Deploy production.",
    });
    const discretionary = snapshot.segments.filter((segment) => !segment.protected);
    const selection = await evaluateCompactionShadowCuration({
      runtime: runtimeWithChoices({ [discretionary[0]!.id]: "keep" }),
      snapshot,
      signal: new AbortController().signal,
    });
    const changedFact = message({
      role: "assistant",
      content: [{ type: "text", text: "Production uses release B." }],
    });

    expect(
      projectCompactionSemanticSelection({
        messages: [user, changedFact],
        snapshot,
        selection,
      }),
    ).toBeNull();
  });

  it("classifies finalized context against source-backed obligations", async () => {
    const user = message({
      role: "user",
      content: [{ type: "text", text: "Keep the production port at 18789." }],
    });
    const snapshot = buildCompactionSemanticSnapshot({
      messages: [user],
      latestUnresolvedUserRequest: "Keep the production port at 18789.",
    });
    const obligationId = snapshot.obligations[0]!.id;
    const runtime = runtimeWithChoices({ [obligationId]: "preserved" });
    const controller = new AbortController();

    const result = await evaluateCompactionFidelity({
      runtime,
      snapshot,
      candidateSummary: "## Constraints/Rules\nKeep production port 18789.",
      signal: controller.signal,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    expect(result.assessments).toEqual([
      expect.objectContaining({
        obligationId,
        classification: "preserved",
      }),
    ]);
  });
});
