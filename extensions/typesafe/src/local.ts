import { parseResult, type Evaluation, type EvaluationInput } from "./schema.js";

export function localInput(input: EvaluationInput): EvaluationInput {
  return {
    ...input,
    questions: Object.fromEntries(
      Object.entries(input.questions).map(([id, question]) => [
        id,
        {
          ...question,
          instructions: question.instructions ?? null,
          ...(question.type === "score"
            ? {
                // Send explicit text so the returned legend can be verified without reproducing Kev's renderer.
                criteria: question.criteria.map((level) =>
                  typeof level === "string" ? level : level === null ? "" : JSON.stringify(level),
                ),
              }
            : {}),
        },
      ]),
    ),
  };
}

export function parseLocalResult(
  value: unknown,
  wireInput: EvaluationInput,
  originalInput: EvaluationInput,
): Evaluation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid local System One response.");
  }
  const { latency_ms, ...result } = value as Record<string, unknown>;
  if (
    Object.hasOwn(value, "latency_ms") &&
    (typeof latency_ms !== "number" || !Number.isFinite(latency_ms) || latency_ms < 0)
  ) {
    throw new Error("Invalid local System One latency metadata.");
  }
  const evaluation = parseResult(result, wireInput);
  for (const [id, question] of Object.entries(originalInput.questions)) {
    const answer = evaluation.answers[id];
    if (question.type === "score" && answer?.type === "score") {
      answer.legend = Object.fromEntries(
        question.criteria.map((level, index) => [String(index), level]),
      );
    }
  }
  return evaluation;
}
