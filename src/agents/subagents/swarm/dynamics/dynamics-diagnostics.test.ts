import { describe, expect, it } from "vitest";
import { buildDynamicsDiagnostic } from "./dynamics-diagnostics.js";
import { assessPopulation, buildPopulationSnapshot } from "./population-controller.js";

describe("diagnostic projection", () => {
  it("does not turn missing evidence into a measured zero", () => {
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [],
      observations: [],
    });
    const diagnostic = buildDynamicsDiagnostic(snapshot, assessPopulation(snapshot));
    expect(diagnostic.evidenceCompleteness).toBeNull();
    expect(diagnostic.systemPressure).toBeNull();
    expect(diagnostic.unresolved).toContain("evidence-unknown");
    expect(diagnostic.replicaCount).toBe(0);
    expect(diagnostic).not.toHaveProperty("activeReplicas");
  });
  it("recomputes pressure and counts observed replicas without claiming they are active", () => {
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [],
      observations: [
        {
          replicaId: "a",
          candidateEntropy: 0.9,
          coherence: 0.2,
          mobility: 0.7,
          evidenceCompleteness: 0.5,
          verifierDisagreement: 0,
          resourcePressure: 0.95,
          contextPressure: 0.1,
          debtPressure: 0.1,
          branchingRatio: 0,
          progressRate: 0.5,
        },
      ],
    });
    snapshot.resourcePressure = 0;
    snapshot.phaseMixture.jammed = 0;
    const diagnostic = buildDynamicsDiagnostic(snapshot, assessPopulation(snapshot));
    expect(diagnostic.systemPressure).toBe(0.95);
    expect(diagnostic.replicaCount).toBe(1);
    expect(diagnostic.meanCorrelation).toBeNull();
    expect(diagnostic.meanCorrelationSource).toBeNull();
    expect(diagnostic.effectiveIndependentReplicas).toBeNull();
    expect(diagnostic.acceptanceProgress).toBeNull();
    expect(diagnostic.hostMeasurementCount).toBe(0);
    expect(diagnostic.externalMeasurementCount).toBe(0);
    expect(diagnostic.unresolved).toContain("jammed-pressure");
  });

  it("reports effective independent search capacity from measured correlation", () => {
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [],
      observations: [
        {
          replicaId: "a",
          candidateEntropy: 0.9,
          coherence: 0.2,
          mobility: 0.7,
          evidenceCompleteness: 0.2,
          verifierDisagreement: 0,
          resourcePressure: 0.1,
          contextPressure: 0.1,
          debtPressure: 0.1,
          branchingRatio: 0.5,
          progressRate: 0.5,
        },
        {
          replicaId: "b",
          candidateEntropy: 0.9,
          coherence: 0.2,
          mobility: 0.7,
          evidenceCompleteness: 0.2,
          verifierDisagreement: 0,
          resourcePressure: 0.1,
          contextPressure: 0.1,
          debtPressure: 0.1,
          branchingRatio: 0.5,
          progressRate: 0.5,
        },
      ],
      meanCorrelation: 0.75,
    });
    const diagnostic = buildDynamicsDiagnostic(snapshot, assessPopulation(snapshot));
    expect(diagnostic.meanCorrelation).toBe(0.75);
    expect(diagnostic.meanCorrelationSource).toBe("external");
    expect(diagnostic.effectiveIndependentReplicas).toBeCloseTo(2 / 1.75);
  });

  it("retains external measurement provenance in operator diagnostics", () => {
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [],
      observations: [
        {
          replicaId: "a",
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
        },
      ],
      measurements: [
        {
          version: 1,
          replicaId: "a",
          metric: "acceptanceProgress",
          value: 0.9,
          source: "external",
          evidenceRef: "checks:green",
        },
      ],
    });
    const diagnostic = buildDynamicsDiagnostic(snapshot, assessPopulation(snapshot));
    expect(diagnostic.acceptanceProgress).toBe(0.9);
    expect(diagnostic.externalMeasurementCount).toBe(1);
    expect(diagnostic.hostMeasurementCount).toBe(0);
  });
});
