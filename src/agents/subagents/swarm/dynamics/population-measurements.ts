import {
  DYNAMICS_METRIC_NAMES,
  type DynamicsMeasurement,
  type DynamicsMetricName,
  type LocalDynamicsObservation,
} from "./population-types.js";

const METRICS = new Set<DynamicsMetricName>(DYNAMICS_METRIC_NAMES);
const UNIT_METRICS = new Set<DynamicsMetricName>(
  DYNAMICS_METRIC_NAMES.filter((metric) => metric !== "branchingRatio"),
);

function emptyObservation(replicaId: string): LocalDynamicsObservation {
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

function validateMeasurement(measurement: DynamicsMeasurement): void {
  if (measurement.version !== 1) {
    throw new Error("unsupported dynamics measurement version");
  }
  if (!measurement.replicaId.trim()) {
    throw new Error("dynamics measurement replicaId must be non-empty");
  }
  if (!METRICS.has(measurement.metric)) {
    throw new Error("unsupported dynamics measurement metric");
  }
  if (measurement.source !== "host" && measurement.source !== "external") {
    throw new Error("dynamics measurement source must be host or external");
  }
  if (!Number.isFinite(measurement.value)) {
    throw new Error("dynamics measurement value must be finite");
  }
  if (UNIT_METRICS.has(measurement.metric)) {
    if (measurement.value < 0 || measurement.value > 1) {
      throw new Error("normalized dynamics measurement must be in [0, 1]");
    }
  } else if (measurement.value < 0) {
    throw new Error("branchingRatio measurement must be non-negative");
  }
  for (const [name, value] of [
    ["candidateIdentity", measurement.candidateIdentity],
    ["evidenceRef", measurement.evidenceRef],
  ] as const) {
    if (value !== undefined && !value.trim()) {
      throw new Error("dynamics measurement " + name + " must be non-empty when supplied");
    }
  }
}

/**
 * Apply typed measurements without silently inventing replicas or overwriting
 * conflicting values. External is provenance only; it is not an authenticated receipt.
 */
export function applyDynamicsMeasurements(params: {
  observations: readonly LocalDynamicsObservation[];
  measurements?: readonly DynamicsMeasurement[];
  declaredReplicaIds?: ReadonlySet<string>;
}): LocalDynamicsObservation[] {
  const byReplica = new Map<string, LocalDynamicsObservation>();
  for (const observation of params.observations) {
    if (!observation.replicaId.trim()) {
      throw new Error("dynamics observation replicaId must be non-empty");
    }
    if (byReplica.has(observation.replicaId)) {
      throw new Error("dynamics observations require unique replica ids");
    }
    byReplica.set(observation.replicaId, {
      ...observation,
      acceptanceProgress: observation.acceptanceProgress ?? null,
    });
  }
  const seen = new Set<string>();

  for (const measurement of params.measurements ?? []) {
    validateMeasurement(measurement);
    const key = measurement.replicaId + "\0" + measurement.metric;
    if (seen.has(key)) {
      throw new Error("dynamics measurements require at most one value per replica and metric");
    }
    seen.add(key);

    let observation = byReplica.get(measurement.replicaId);
    if (!observation) {
      if (!params.declaredReplicaIds?.has(measurement.replicaId)) {
        throw new Error("dynamics measurement must target an observed or declared replica");
      }
      observation = emptyObservation(measurement.replicaId);
      byReplica.set(measurement.replicaId, observation);
    }

    const current = observation[measurement.metric];
    if (current !== null && current !== undefined && current !== measurement.value) {
      throw new Error("dynamics measurement conflicts with an existing observation");
    }
    observation[measurement.metric] = measurement.value;
  }

  return [...byReplica.values()];
}
