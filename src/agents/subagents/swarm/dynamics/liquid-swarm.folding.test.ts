import { describe, expect, it } from "vitest";
import { candidateIdentity, type CandidateManifest } from "./candidate-evidence.js";
import { prepareDynamicsSpawn } from "./dynamics-spawn.js";
import { assessPopulation, buildPopulationSnapshot } from "./population-controller.js";
import type { LocalDynamicsObservation } from "./population-types.js";

function observation(
  replicaId: string,
  overrides: Partial<LocalDynamicsObservation> = {},
): LocalDynamicsObservation {
  return {
    replicaId,
    candidateEntropy: 0.9,
    coherence: 0.2,
    mobility: 0.8,
    evidenceCompleteness: 0.1,
    acceptanceProgress: null,
    verifierDisagreement: 0.05,
    resourcePressure: 0.1,
    contextPressure: 0.1,
    debtPressure: 0.1,
    branchingRatio: 0.8,
    progressRate: 0.7,
    ...overrides,
  };
}

function decide(
  observations: readonly LocalDynamicsObservation[],
  meanCorrelation: number | null = null,
) {
  const snapshot = buildPopulationSnapshot({
    campaignId: "folding",
    groupId: "swarm:folding",
    replicas: [],
    observations,
    meanCorrelation,
  });
  return { snapshot, decision: assessPopulation(snapshot) };
}

describe("adaptive test-time compute folding regression", () => {
  it("moves from broad exploration to productive mixed regimes", () => {
    const gas = decide([observation("hot-a"), observation("hot-b")]);
    expect(gas.snapshot.phaseMixture.gas).toBe(1);
    expect(gas.decision.authority).toBe("search-only");
    expect(gas.decision.actions).toContainEqual(
      expect.objectContaining({ kind: "spawn", purpose: "coordinate" }),
    );

    const mixed = decide([
      observation("hot", { candidateEntropy: 0.85, coherence: 0.2 }),
      observation("liquid", {
        candidateEntropy: 0.35,
        coherence: 0.65,
        mobility: 0.7,
        evidenceCompleteness: 0.45,
      }),
    ]);
    expect(mixed.snapshot.phaseMixture.gas).toBe(0.5);
    expect(mixed.snapshot.phaseMixture.liquid).toBe(0.5);
    expect(mixed.decision.authority).toBe("search-only");
  });

  it("measures conflict before assigning scarce high-thinking depth", () => {
    const { snapshot, decision } = decide([
      observation("disagree", {
        candidateEntropy: 0.15,
        coherence: 0.9,
        mobility: 0.05,
        progressRate: 0.05,
        evidenceCompleteness: 0.4,
        verifierDisagreement: 0.9,
      }),
    ]);
    expect(snapshot.phaseMixture.critical).toBe(1);
    expect(snapshot.phaseMixture.glass).toBe(0);
    expect(decision.actions[0]).toMatchObject({
      kind: "measure",
      targetReplicaIds: ["disagree"],
    });
    expect(decision.actions[1]).toMatchObject({
      kind: "deepen",
      targetReplicaIds: ["disagree"],
      suggestedThinking: "high",
    });
  });

  it("decorrelates redundant exploration instead of buying more copies", () => {
    const { diagnosticDecision } = (() => {
      const { decision } = decide(
        [
          observation("copy-a"),
          observation("copy-b"),
          observation("copy-c"),
          observation("copy-d"),
        ],
        0.9,
      );
      return { diagnosticDecision: decision };
    })();
    expect(diagnosticDecision.actions).toContainEqual(
      expect.objectContaining({ kind: "perturb", purpose: "decorrelate" }),
    );
    expect(diagnosticDecision.actions.some((action) => action.kind === "spawn")).toBe(false);
  });

  it("freezes a local candidate without stopping unrelated exploration", () => {
    const { snapshot, decision } = decide([
      observation("hot"),
      observation("candidate", {
        candidateEntropy: 0.05,
        coherence: 0.95,
        mobility: 0.15,
        evidenceCompleteness: 0.95,
        acceptanceProgress: 0.95,
        verifierDisagreement: 0.05,
        progressRate: 0.6,
      }),
    ]);
    expect(snapshot.phaseMixture.gas).toBe(0.5);
    expect(snapshot.phaseMixture.crystal).toBe(0.5);
    expect(decision.actions).toContainEqual({
      kind: "freeze",
      targetReplicaIds: ["candidate"],
      reason: "low-entropy candidates with substantial evidence should be frozen for verification",
    });
    expect(decision.authority).toBe("search-only");
  });

  it("folds a frozen candidate into an exact sandbox-required verifier launch", () => {
    const candidate: CandidateManifest = {
      version: 1,
      candidateDigest: "candidate:a",
      sourceDigest: "source:a",
      recipeDigest: "recipe:a",
      policyDigest: "policy:a",
    };
    const identity = candidateIdentity(candidate);
    const dynamics = {
      boundary: "artifact-only",
      requirements: {
        sandbox: "require",
        candidateDigest: "required",
        artifactRefs: "required",
      },
      candidate,
      handoff: {
        artifactRefs: ["artifact:candidate-a"],
      },
    } as const;

    const prepared = prepareDynamicsSpawn({
      task: "Verify the frozen candidate against the acceptance criteria.",
      dynamics,
      sourceReplicaId: "swarm:folding",
      targetReplicaId: "verifier:1",
    });
    const replay = prepareDynamicsSpawn({
      task: "Verify the frozen candidate against the acceptance criteria.",
      dynamics,
      sourceReplicaId: "swarm:folding",
      targetReplicaId: "verifier:1",
    });

    expect(prepared).toEqual(replay);
    expect(prepared.context).toBe("isolated");
    expect(prepared.sandbox).toBe("require");
    expect(prepared.task).toContain(identity);

    const changedPolicy = prepareDynamicsSpawn({
      task: "Verify the frozen candidate against the acceptance criteria.",
      dynamics: {
        ...dynamics,
        candidate: { ...candidate, policyDigest: "policy:changed" },
      },
      sourceReplicaId: "swarm:folding",
      targetReplicaId: "verifier:1",
    });
    expect(changedPolicy.task).not.toBe(prepared.task);
  });

  it("lets jam pressure outrank further spawning", () => {
    const { snapshot, decision } = decide([
      observation("saturated", { resourcePressure: 0.95 }),
      observation("hot"),
    ]);
    expect(snapshot.phaseMixture.jammed).toBe(0.5);
    expect(decision.actions).toEqual([
      {
        kind: "drain",
        reason: "resource/context/debt pressure is too high for further expansion",
      },
    ]);
  });

  it("invalidates exact candidate identity when source, recipe, or policy changes", () => {
    const candidate: CandidateManifest = {
      version: 1,
      candidateDigest: "candidate:a",
      sourceDigest: "source:a",
      recipeDigest: "recipe:a",
      policyDigest: "policy:a",
    };
    const identity = candidateIdentity(candidate);
    for (const field of ["sourceDigest", "recipeDigest", "policyDigest"] as const) {
      expect(candidateIdentity({ ...candidate, [field]: field + ":changed" })).not.toBe(identity);
    }
  });
});
