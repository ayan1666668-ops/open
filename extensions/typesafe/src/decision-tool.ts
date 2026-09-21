import { createHash } from "node:crypto";
import type {
  DecisionBatch,
  DecisionInspection,
  DecisionOutcome,
  DecisionProviderCapabilities,
} from "openclaw/plugin-sdk/decisions";
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
    guidance: { type: "string" },
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
  const canonical = JSON.stringify(canonicalize(batch.questions));
  return `decision-v1-${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function capabilityGuidance(capabilities: DecisionProviderCapabilities): string {
  const limits = [
    capabilities.maxQuestions === undefined
      ? undefined
      : `at most ${capabilities.maxQuestions} questions`,
    capabilities.maxChoiceAlternatives === undefined
      ? undefined
      : `at most ${capabilities.maxChoiceAlternatives} Choice alternatives`,
    capabilities.maxScoreLevels === undefined
      ? undefined
      : `at most ${capabilities.maxScoreLevels} Score levels`,
  ].filter((value): value is string => value !== undefined);
  const boolean = capabilities.requiresBooleanCriteria
    ? " Boolean questions require both criteria.true and criteria.false descriptions."
    : "";
  return `The selected provider supports ${capabilities.questionTypes.join(", ")} questions.${limits.length ? ` Limits: ${limits.join(", ")}.` : ""}${boolean}`;
}

export function decisionToolResult(outcome: DecisionOutcome, inspection?: DecisionInspection) {
  const guidance =
    outcome.status === "unavailable" &&
    outcome.reason === "unsupported-input" &&
    inspection?.provider?.capabilities
      ? capabilityGuidance(inspection.provider.capabilities)
      : undefined;
  const details = guidance ? { ...outcome, guidance } : outcome;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}
