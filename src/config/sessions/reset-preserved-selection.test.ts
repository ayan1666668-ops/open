import { describe, expect, it } from "vitest";
import { getSessionExecutionSelection } from "../../model-picker/execution-selection-state.js";
import { resolveResetPreservedSelection } from "./reset-preserved-selection.js";

describe("resolveResetPreservedSelection", () => {
  it("preserves the accepted model and executor as one reset selection", () => {
    const preserved = resolveResetPreservedSelection({
      entry: {
        sessionId: "canonical",
        updatedAt: 1,
        providerOverride: "qa-route",
        modelOverride: "qa-route/family/qa-selected",
        agentRuntimeOverride: "openclaw",
        modelOverrideRouteResolution: "resolved",
      },
    });
    expect(getSessionExecutionSelection(preserved)).toEqual({
      model: { provider: "qa-route", id: "qa-route/family/qa-selected" },
      executor: { kind: "harness", id: "openclaw" },
    });
  });

  it("does not resurrect an incomplete or cleared executor selection during reset", () => {
    const preserved = resolveResetPreservedSelection({
      entry: { sessionId: "legacy", updatedAt: 1, modelOverride: "qa-uninitialized" },
    });
    expect(getSessionExecutionSelection(preserved)).toBeUndefined();
  });

  it("preserves legacy user auth pins while dropping legacy automatic pins", () => {
    expect(
      resolveResetPreservedSelection({
        entry: {
          sessionId: "legacy-user",
          updatedAt: 1,
          authProfileOverride: "openai:work",
        },
      }),
    ).toEqual({
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
    });

    expect(
      resolveResetPreservedSelection({
        entry: {
          sessionId: "legacy-auto",
          updatedAt: 1,
          authProfileOverride: "openai:fallback",
          authProfileOverrideCompactionCount: 0,
        },
      }),
    ).toEqual({});
  });
});
