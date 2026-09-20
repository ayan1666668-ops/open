export type ShadowMetric = {
  name: string;
  baseline: number;
  candidate: number;
  higherIsBetter: boolean;
  weight: number;
};

export type ShadowEvaluation = {
  experimentId: string;
  baselinePolicyDigest: string;
  candidatePolicyDigest: string;
  metrics: readonly ShadowMetric[];
  weightedDelta: number;
  disposition: "insufficient-evidence" | "candidate-improvement" | "candidate-regression";
  authority: "proposal-only";
};

export function evaluateShadowPolicy(params: {
  experimentId: string;
  baselinePolicyDigest: string;
  candidatePolicyDigest: string;
  metrics: readonly ShadowMetric[];
}): ShadowEvaluation {
  if (!params.experimentId.trim()) {
    throw new Error("shadow experiment id must be non-empty");
  }
  if (params.metrics.length === 0) {
    return {
      ...params,
      weightedDelta: 0,
      disposition: "insufficient-evidence",
      authority: "proposal-only",
    };
  }

  let totalWeight = 0;
  let weightedDelta = 0;
  for (const metric of params.metrics) {
    if (
      !Number.isFinite(metric.baseline) ||
      !Number.isFinite(metric.candidate) ||
      !Number.isFinite(metric.weight) ||
      metric.weight <= 0
    ) {
      throw new Error("shadow metrics must be finite and have positive weight");
    }
    const raw = metric.candidate - metric.baseline;
    const signed = metric.higherIsBetter ? raw : -raw;
    weightedDelta += signed * metric.weight;
    totalWeight += metric.weight;
  }
  weightedDelta /= totalWeight;

  return {
    ...params,
    weightedDelta,
    disposition: weightedDelta > 0
      ? "candidate-improvement"
      : weightedDelta < 0
        ? "candidate-regression"
        : "insufficient-evidence",
    authority: "proposal-only",
  };
}
