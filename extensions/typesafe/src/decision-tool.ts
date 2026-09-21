import { createHash } from "node:crypto";
import type { DecisionBatch, DecisionOutcome } from "openclaw/plugin-sdk/decisions";
import { DecisionContractError, validateDecisionBatch } from "openclaw/plugin-sdk/decisions";
import { Type } from "typebox";

const entry = {
  anyOf: [
    { type: "string" },
    { type: "object", additionalProperties: true },
    { type: "array", items: {} },
    { type: "null" },
  ],
} as const;

/** Provider-neutral request contract. Provider-specific translation stays in the provider plugin. */
export const DecisionEvaluateInput = Type.Unsafe({
  type: "object",
  additionalProperties: false,
  required: ["state", "questions"],
  properties: {
    state: entry,
    questions: {
      type: "object",
      minProperties: 1,
      additionalProperties: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type"],
            properties: {
              type: { const: "boolean" },
              instructions: entry,
              criteria: {
                type: ["object", "null"],
                additionalProperties: entry,
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "criteria"],
            properties: {
              type: { const: "choice" },
              instructions: entry,
              criteria: { type: "object", minProperties: 2, additionalProperties: entry },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "criteria"],
            properties: {
              type: { const: "score" },
              instructions: entry,
              criteria: { type: "array", minItems: 2, items: entry },
            },
          },
        ],
      },
    },
  },
});

export const DecisionEvaluateOutput = Type.Unsafe({
  type: "object",
  required: ["status"],
  properties: {
    status: { enum: ["ok", "unavailable"] },
    result: { type: "object" },
    reason: { type: "string" },
  },
});

export function parseDecisionEvaluateInput(value: unknown): DecisionBatch {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new DecisionContractError();
    }
    const batch = value as Record<string, unknown>;
    const questions = batch.questions;
    if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
      throw new DecisionContractError();
    }
    const normalized: DecisionBatch = {
      state: batch.state as DecisionBatch["state"],
      questions: Object.fromEntries(
        Object.entries(questions).map(([id, question]) => {
          if (
            question &&
            typeof question === "object" &&
            !Array.isArray(question) &&
            (question as { type?: unknown }).type === "boolean"
          ) {
            return [id, { ...(question as object), type: "boolean" }];
          }
          return [id, question];
        }),
      ) as DecisionBatch["questions"],
    };
    if (!validateDecisionBatch(normalized)) {
      throw new DecisionContractError();
    }
    return normalized;
  } catch {
    throw new Error(
      "Invalid decision_evaluate input: provide state and a nonempty questions map with boolean, choice, or score questions; no evidence was sent.",
    );
  }
}

export function rubricVersion(batch: DecisionBatch): string {
  const canonical = JSON.stringify(batch.questions, Object.keys(batch.questions).toSorted());
  return `decision-v1-${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
}

export function decisionToolResult(outcome: DecisionOutcome) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
    details: outcome,
  };
}
