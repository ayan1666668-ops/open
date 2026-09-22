import { describe, expect, it } from "vitest";
import { assessPopulation, buildPopulationSnapshot } from "./population-controller.js";

function observation(
  overrides: Partial<{
    replicaId: string;
    candidateEntropy: number;
    coherence: number;
    mobility: number;
    evidenceCompleteness: number;
    acceptanceProgress: number;
    verifierDisagreement: number;
    resourcePressure: number;
    contextPressure: number;
    debtPressure: number;
    branchingRatio: number;
    progressRate: number;
  }> = {},
) {
  return {
    replicaId: "r1",
    candidateEntropy: 0.5,
    coherence: 0.5,
    mobility: 0.5,
    evidenceCompleteness: 0.5,
    verifierDisagreement: 0.1,
    resourcePressure: 0.1,
    contextPressure: 0.1,
    debtPressure: 0.1,
    branchingRatio: 0.5,
    progressRate: 0.5,
    ...overrides,
  };
}

describe("mixed-phase population controller", () => {
  it("drains before expanding when pressure is jammed", () => {
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [],
      observations: [observation({ resourcePressure: 0.95 })],
    });
    expect(assessPopulation(snapshot).actions).toEqual([
      {
        kind: "drain",
        reason: "resource/context/debt pressure is too high for further expansion",
      },
    ]);
  });

  it("requests measurement and selective depth for critical disagreement", () => {
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [],
      observations: [observation({ verifierDisagreement: 0.9 })],
    });
    expect(assessPopulation(snapshot).actions.slice(0, 2)).toEqual([
      {
        kind: "measure",
        targetReplicaIds: ["r1"],
        reason: "critical replicas require discriminating measurements before widening search",
      },
      {
        kind: "deepen",
        targetReplicaIds: ["r1"],
        suggestedThinking: "high",
        reason: "scarce deep reasoning is reserved for the highest-uncertainty critical lanes",
      },
    ]);
  });

  it("deepens only a bounded subset of large critical populations", () => {
    const observations = Array.from({ length: 25 }, (_, index) =>
      observation({
        replicaId: `r${index.toString().padStart(2, "0")}`,
        verifierDisagreement: 0.6 + index / 100,
      }),
    );
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [],
      observations,
    });
    const deepen = assessPopulation(snapshot).actions.find((action) => action.kind === "deepen");
    expect(deepen).toMatchObject({ kind: "deepen" });
    if (deepen?.kind === "deepen") {
      expect(deepen.targetReplicaIds).toHaveLength(5);
      expect(deepen.targetReplicaIds[0]).toBe("r24");
      expect(deepen.suggestedThinking).toBe("high");
    }
  });

  it("decorrelates highly redundant populations instead of spawning more work", () => {
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [],
      observations: [
        observation({ replicaId: "a", candidateEntropy: 0.9, coherence: 0.2 }),
        observation({ replicaId: "b", candidateEntropy: 0.9, coherence: 0.2 }),
        observation({ replicaId: "c", candidateEntropy: 0.9, coherence: 0.2 }),
        observation({ replicaId: "d", candidateEntropy: 0.9, coherence: 0.2 }),
      ],
      meanCorrelation: 0.8,
    });
    const decision = assessPopulation(snapshot);
    expect(decision.actions).toContainEqual({
      kind: "perturb",
      purpose: "decorrelate",
      count: 1,
      reason: "measured trajectory correlation is wasting parallel search capacity",
    });
    expect(decision.actions.some((action) => action.kind === "spawn")).toBe(false);
  });

  it("uses a bounded decorrelating perturbation rather than unbounded respawn", () => {
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [],
      observations: [
        observation({ mobility: 0.05, progressRate: 0.05, evidenceCompleteness: 0.2 }),
      ],
    });
    expect(assessPopulation(snapshot).actions).toContainEqual({
      kind: "perturb",
      purpose: "decorrelate",
      count: 1,
      reason: "bounded fresh-context perturbation for stalled low-mobility search",
    });
  });

  it("keeps low-acceptance candidates out of the frozen basin", () => {
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [],
      observations: [
        observation({
          candidateEntropy: 0.05,
          coherence: 0.95,
          evidenceCompleteness: 0.95,
          acceptanceProgress: 0.2,
          verifierDisagreement: 0.05,
        }),
      ],
    });
    expect(snapshot.phaseMixture.crystal).toBe(0);
    expect(
      assessPopulation(snapshot).actions.some((action) => action.kind === "freeze"),
    ).toBe(false);
  });

  it("freezes a well-evidenced low-entropy candidate without granting authority", () => {
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [],
      observations: [
        observation({
          candidateEntropy: 0.05,
          coherence: 0.95,
          evidenceCompleteness: 0.95,
          mobility: 0.1,
          progressRate: 0.4,
        }),
      ],
    });
    const decision = assessPopulation(snapshot);
    expect(decision.authority).toBe("search-only");
    expect(decision.actions).toContainEqual({
      kind: "freeze",
      targetReplicaIds: ["r1"],
      reason: "low-entropy candidates with substantial evidence should be frozen for verification",
    });
  });
});
