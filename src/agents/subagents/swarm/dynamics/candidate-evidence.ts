import { createHash } from "node:crypto";

export type CandidateManifest = {
  version: 1;
  candidateDigest: string;
  sourceDigest: string;
  recipeDigest: string;
  policyDigest: string;
};

export type MeasurementKind =
  | "test"
  | "static-analysis"
  | "replay"
  | "performance"
  | "security"
  | "formal"
  | "human";

export type MeasurementReceipt = {
  version: 1;
  measurementId: string;
  candidateDigest: string;
  contractDigest: string;
  producerRunId: string;
  producerReplicaId: string;
  kind: MeasurementKind;
  resultDigest: string;
  evidenceDigest: string;
  passed: boolean;
  independenceKey: string;
};

export type VerificationRequirement = {
  id: string;
  kind: MeasurementKind;
  minIndependentConfirmations: number;
};

export type VerificationContract = {
  version: 1;
  requirements: readonly VerificationRequirement[];
};

export type VerificationResult =
  | {
      status: "verified";
      candidateDigest: string;
      contractDigest: string;
      evidenceDigest: string;
      satisfiedRequirementIds: readonly string[];
    }
  | {
      status: "incomplete" | "rejected";
      candidateDigest: string;
      contractDigest: string;
      missingRequirementIds: readonly string[];
      failedMeasurementIds: readonly string[];
    };

export type EffectRequest = {
  version: 1;
  candidateDigest: string;
  contractDigest: string;
  evidenceDigest: string;
  requestedEffect: string;
  authority: "request-only";
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function stableDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

export function verificationContractDigest(contract: VerificationContract): string {
  return stableDigest(contract);
}

export function candidateIdentity(manifest: CandidateManifest): string {
  return stableDigest({
    candidateDigest: manifest.candidateDigest,
    sourceDigest: manifest.sourceDigest,
    recipeDigest: manifest.recipeDigest,
    policyDigest: manifest.policyDigest,
    version: manifest.version,
  });
}

export function verifyCandidate(params: {
  candidate: CandidateManifest;
  contract: VerificationContract;
  measurements: readonly MeasurementReceipt[];
}): VerificationResult {
  const contractDigest = verificationContractDigest(params.contract);
  const relevant = params.measurements.filter(
    (measurement) =>
      measurement.candidateDigest === params.candidate.candidateDigest &&
      measurement.contractDigest === contractDigest,
  );
  const failedMeasurementIds = relevant
    .filter((measurement) => !measurement.passed)
    .map((measurement) => measurement.measurementId);

  if (failedMeasurementIds.length > 0) {
    return {
      status: "rejected",
      candidateDigest: params.candidate.candidateDigest,
      contractDigest,
      missingRequirementIds: [],
      failedMeasurementIds,
    };
  }

  const satisfiedRequirementIds: string[] = [];
  const missingRequirementIds: string[] = [];

  for (const requirement of params.contract.requirements) {
    const keys = new Set(
      relevant
        .filter((measurement) => measurement.passed && measurement.kind === requirement.kind)
        .map((measurement) => measurement.independenceKey),
    );
    if (keys.size >= requirement.minIndependentConfirmations) {
      satisfiedRequirementIds.push(requirement.id);
    } else {
      missingRequirementIds.push(requirement.id);
    }
  }

  if (missingRequirementIds.length > 0) {
    return {
      status: "incomplete",
      candidateDigest: params.candidate.candidateDigest,
      contractDigest,
      missingRequirementIds,
      failedMeasurementIds: [],
    };
  }

  const evidenceDigest = stableDigest(
    relevant
      .filter((measurement) => measurement.passed)
      .map((measurement) => measurement.evidenceDigest)
      .sort(),
  );
  return {
    status: "verified",
    candidateDigest: params.candidate.candidateDigest,
    contractDigest,
    evidenceDigest,
    satisfiedRequirementIds,
  };
}

export function buildEffectRequest(params: {
  verification: Extract<VerificationResult, { status: "verified" }>;
  requestedEffect: string;
}): EffectRequest {
  if (!params.requestedEffect.trim()) {
    throw new Error("requested effect must be non-empty");
  }
  return {
    version: 1,
    candidateDigest: params.verification.candidateDigest,
    contractDigest: params.verification.contractDigest,
    evidenceDigest: params.verification.evidenceDigest,
    requestedEffect: params.requestedEffect.trim(),
    authority: "request-only",
  };
}
