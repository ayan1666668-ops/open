import { describe, expect, it } from "vitest";
import { applyDynamicsMeasurements } from "./population-measurements.js";
import type { LocalDynamicsObservation } from "./population-types.js";

function empty(replicaId: string): LocalDynamicsObservation {
  return {
    replicaId,
    candidateEntropy: null,
    coherence: null,
    mobility: null,
    evidenceCompleteness: null,
    acceptanceProgress: null,
    verifierDisagreement: null,
    resourcePressure: null,
    contextPressure: null,
    debtPressure: null,
    branchingRatio: null,
    progressRate: null,
  };
}

describe("typed dynamics measurements", () => {
  it("updates declared observations while preserving provenance outside the value", () => {
    const observations = applyDynamicsMeasurements({
      observations: [empty("r1")],
      measurements: [
        {
          version: 1,
          replicaId: "r1",
          metric: "acceptanceProgress",
          value: 0.75,
          source: "external",
          evidenceRef: "check-suite:42",
        },
      ],
    });
    expect(observations[0]?.acceptanceProgress).toBe(0.75);
  });

  it("can materialize a declared replica but not invent an undeclared one", () => {
    expect(
      applyDynamicsMeasurements({
        observations: [],
        declaredReplicaIds: new Set(["r1"]),
        measurements: [
          {
            version: 1,
            replicaId: "r1",
            metric: "coherence",
            value: 0.8,
            source: "external",
          },
        ],
      })[0],
    ).toMatchObject({ replicaId: "r1", coherence: 0.8 });

    expect(() =>
      applyDynamicsMeasurements({
        observations: [],
        measurements: [
          {
            version: 1,
            replicaId: "phantom",
            metric: "coherence",
            value: 0.8,
            source: "external",
          },
        ],
      }),
    ).toThrow("observed or declared replica");
  });

  it("rejects conflicting or duplicate claims for the same metric", () => {
    expect(() =>
      applyDynamicsMeasurements({
        observations: [{ ...empty("r1"), coherence: 0.2 }],
        measurements: [
          {
            version: 1,
            replicaId: "r1",
            metric: "coherence",
            value: 0.8,
            source: "external",
          },
        ],
      }),
    ).toThrow("conflicts");

    expect(() =>
      applyDynamicsMeasurements({
        observations: [empty("r1")],
        measurements: [
          { version: 1, replicaId: "r1", metric: "coherence", value: 0.8, source: "host" },
          { version: 1, replicaId: "r1", metric: "coherence", value: 0.8, source: "external" },
        ],
      }),
    ).toThrow("at most one value");
  });
});
