import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionRowSchema } from "./sessions-row.js";

const legacySessionRow = {
  key: "agent:main:legacy-session",
  kind: "global",
  sessionId: "legacy-session",
  modelProvider: "openai",
  model: "gpt-4.1",
  updatedAt: 1,
};

const projectedSessionRow = {
  ...legacySessionRow,
  modelSelection: {
    mode: "auto",
    recoveryHint: "Retry with the configured fallback.",
    lastDecision: {
      model: "openai/gpt-4.1-mini",
      reason: "latency",
      at: 1_725_000_000_000,
    },
  },
  modelOverrideSource: "auto",
};

describe("SessionRow model-selection compatibility", () => {
  it("accepts legacy rows without selector fields after a JSON round-trip", () => {
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Verify persisted JSON wire compatibility.
    const wireRow = JSON.parse(JSON.stringify(legacySessionRow)) as unknown;

    expect(Value.Check(SessionRowSchema, wireRow)).toBe(true);
    expect(wireRow).toEqual(legacySessionRow);
    expect(wireRow).not.toHaveProperty("modelSelection");
    expect(wireRow).not.toHaveProperty("modelOverrideSource");
  });

  it("round-trips the additive selector projection through the protocol schema", () => {
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Verify persisted JSON wire compatibility.
    const wireRow = JSON.parse(JSON.stringify(projectedSessionRow)) as unknown;

    expect(Value.Check(SessionRowSchema, wireRow)).toBe(true);
    expect(wireRow).toEqual(projectedSessionRow);
    expect(wireRow).toMatchObject({
      modelSelection: {
        mode: "auto",
        recoveryHint: "Retry with the configured fallback.",
        lastDecision: {
          model: "openai/gpt-4.1-mini",
          reason: "latency",
          at: 1_725_000_000_000,
        },
      },
      modelOverrideSource: "auto",
    });
  });
});
