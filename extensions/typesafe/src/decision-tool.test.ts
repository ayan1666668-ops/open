import { expect, it } from "vitest";
import { parseDecisionEvaluateInput, rubricVersion } from "./decision-tool.js";

it("accepts the provider-neutral boolean vocabulary", () => {
  const batch = parseDecisionEvaluateInput({
    state: "Please refund my order",
    questions: {
      refund_requested: {
        type: "boolean",
        instructions: "Does the customer request money back?",
        criteria: { true: "Money back is requested", false: "No money back is requested" },
      },
      route: { type: "choice", criteria: { billing: "Payments", other: "Everything else" } },
    },
  });
  expect(batch.questions.refund_requested).toMatchObject({ type: "boolean" });
  expect(rubricVersion(batch)).toMatch(/^decision-v1-[0-9a-f]{24}$/);
});

it("rejects malformed input without echoing evidence", () => {
  expect(() =>
    parseDecisionEvaluateInput({
      state: "private evidence that must not appear",
      questions: { q: { type: "boolean", criteria: { maybe: "not allowed" } } },
    }),
  ).toThrow("provide state and a nonempty questions map");
});

it("preserves valid resource-limit input for runtime handling", () => {
  const batch = parseDecisionEvaluateInput({
    state: "x".repeat(1_048_577),
    questions: { q: { type: "boolean" } },
  });
  expect(batch.questions.q).toMatchObject({ type: "boolean" });
});

it("changes the rubric version when nested instructions or criteria change", () => {
  const base = parseDecisionEvaluateInput({
    state: null,
    questions: {
      q: { type: "choice", instructions: { prompt: "Choose" }, criteria: { yes: "Yes", no: "No" } },
    },
  });
  const changed = parseDecisionEvaluateInput({
    state: null,
    questions: {
      q: {
        type: "choice",
        instructions: { prompt: "Choose carefully" },
        criteria: { yes: "Yes", no: "No" },
      },
    },
  });
  const changedCriteria = parseDecisionEvaluateInput({
    state: null,
    questions: {
      q: {
        type: "choice",
        instructions: { prompt: "Choose" },
        criteria: { yes: "Keep", no: "No" },
      },
    },
  });
  expect(rubricVersion(base)).not.toBe(rubricVersion(changed));
  expect(rubricVersion(base)).not.toBe(rubricVersion(changedCriteria));
});
