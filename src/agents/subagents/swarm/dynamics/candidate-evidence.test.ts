import { describe, expect, it } from "vitest";
import {
  buildEffectRequest,
  verifyCandidate,
  verificationContractDigest,
  type CandidateManifest,
  type MeasurementReceipt,
  type VerificationContract,
} from "./candidate-evidence.js";

const candidate: CandidateManifest = {
  version: 1,
  candidateDigest: "candidate:a",
  sourceDigest: "source:a",
  recipeDigest: "recipe:a",
  policyDigest: "policy:a",
};

const contract: VerificationContract = {
  version: 1,
  requirements: [
    { id: "tests", kind: "test", minIndependentConfirmations: 1 },
    { id: "review", kind: "security", minIndependentConfirmations: 2 },
  ],
};

function measurement(
  overrides: Partial<MeasurementReceipt> & Pick<MeasurementReceipt, "measurementId" | "kind" | "independenceKey">,
): MeasurementReceipt {
  return {
    version: 1,
    candidateDigest: candidate.candidateDigest,
    contractDigest: verificationContractDigest(contract),
    producerRunId: `run:${overrides.measurementId}`,
    producerReplicaId: `replica:${overrides.measurementId}`,
    resultDigest: `result:${overrides.measurementId}`,
    evidenceDigest: `evidence:${overrides.measurementId}`,
    passed: true,
    ...overrides,
  };
}

describe("evidence-bound convergence", () => {
  it("requires every declared verification requirement", () => {
    const result = verifyCandidate({
      candidate,
      contract,
      measurements: [measurement({ measurementId: "t1", kind: "test", independenceKey: "test-a" })],
    });
    expect(result).toMatchObject({
      status: "incomplete",
      missingRequirementIds: ["review"],
    });
  });

  it("does not double count duplicate independence keys", () => {
    const result = verifyCandidate({
      candidate,
      contract,
      measurements: [
        measurement({ measurementId: "t1", kind: "test", independenceKey: "test-a" }),
        measurement({ measurementId: "s1", kind: "security", independenceKey: "same-reviewer" }),
        measurement({ measurementId: "s2", kind: "security", independenceKey: "same-reviewer" }),
      ],
    });
    expect(result).toMatchObject({
      status: "incomplete",
      missingRequirementIds: ["review"],
    });
  });

  it("rejects an exact-candidate failure instead of averaging it away", () => {
    const result = verifyCandidate({
      candidate,
      contract,
      measurements: [
        measurement({ measurementId: "t1", kind: "test", independenceKey: "test-a" }),
        measurement({
          measurementId: "s1",
          kind: "security",
          independenceKey: "sec-a",
          passed: false,
        }),
      ],
    });
    expect(result).toMatchObject({ status: "rejected", failedMeasurementIds: ["s1"] });
  });

  it("builds request-only effects only after complete independent evidence", () => {
    const verification = verifyCandidate({
      candidate,
      contract,
      measurements: [
        measurement({ measurementId: "t1", kind: "test", independenceKey: "test-a" }),
        measurement({ measurementId: "s1", kind: "security", independenceKey: "sec-a" }),
        measurement({ measurementId: "s2", kind: "security", independenceKey: "sec-b" }),
      ],
    });
    expect(verification.status).toBe("verified");
    if (verification.status !== "verified") {
      throw new Error("expected verified");
    }
    expect(
      buildEffectRequest({ verification, requestedEffect: "publish exact candidate" }),
    ).toMatchObject({
      candidateDigest: "candidate:a",
      authority: "request-only",
      requestedEffect: "publish exact candidate",
    });
  });
});
