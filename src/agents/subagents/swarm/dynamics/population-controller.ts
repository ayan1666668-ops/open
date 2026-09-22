import { PHASE_HEURISTICS, assessLocalPhase, phaseMixture } from "./phase-assessment.js";
import { applyDynamicsMeasurements } from "./population-measurements.js";
import type {
  DynamicsAction,
  DynamicsMeasurement,
  DynamicsMeasurementSource,
  LocalDynamicsObservation,
  LocalPhaseAssessment,
  PopulationDecision,
  PopulationSnapshot,
} from "./population-types.js";

const CONTROL_HEURISTICS = {
  drainPressure: 0.8,
  jammedMixture: 0.25,
  criticalMixture: 0.2,
  glassMixture: 0.15,
  gasMixture: 0.4,
  spawnPressureMax: 0.6,
  correlationEffectiveRatioMin: 0.5,
  maxDeepTargets: 8,
} as const;

function mean(values: readonly (number | null | undefined)[]): number | null {
  const known = values.filter((value): value is number => value !== null && value !== undefined);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0) / known.length;
}

function maximum(values: readonly (number | null | undefined)[]): number | null {
  const known = values.filter((value): value is number => value !== null && value !== undefined);
  return known.length === 0 ? null : Math.max(...known);
}

function uniqueReplicaCount(snapshot: PopulationSnapshot): number {
  return new Set([
    ...snapshot.replicas.map((replica) => replica.replicaId),
    ...snapshot.observations.map((observation) => observation.replicaId),
  ]).size;
}

export function estimateEffectiveIndependentPopulation(
  replicaCount: number,
  meanCorrelation: number | null,
): number | null {
  if (!Number.isSafeInteger(replicaCount) || replicaCount < 0) {
    throw new Error("replicaCount must be a non-negative safe integer");
  }
  if (meanCorrelation === null) {
    return null;
  }
  if (!Number.isFinite(meanCorrelation) || meanCorrelation < 0 || meanCorrelation > 1) {
    throw new Error("meanCorrelation must be unknown or finite and in [0, 1]");
  }
  if (replicaCount === 0) {
    return 0;
  }
  return replicaCount / (1 + (replicaCount - 1) * meanCorrelation);
}

function criticalPriority(observation: LocalDynamicsObservation): number {
  const disagreement = observation.verifierDisagreement ?? 0;
  const ambiguityMidpoint =
    (PHASE_HEURISTICS.ambiguityEntropyMin + PHASE_HEURISTICS.ambiguityEntropyMax) / 2;
  const ambiguityHalfWidth =
    (PHASE_HEURISTICS.ambiguityEntropyMax - PHASE_HEURISTICS.ambiguityEntropyMin) / 2;
  const entropySignal =
    observation.candidateEntropy === null
      ? 0
      : Math.max(
          0,
          1 - Math.abs(observation.candidateEntropy - ambiguityMidpoint) / ambiguityHalfWidth,
        );
  return Math.max(disagreement, entropySignal);
}

function deepReasoningTargetCount(criticalCount: number): number {
  if (criticalCount <= 0) {
    return 0;
  }
  return Math.min(CONTROL_HEURISTICS.maxDeepTargets, Math.ceil(Math.sqrt(criticalCount)));
}

export function buildPopulationSnapshot(params: {
  campaignId: string;
  groupId: string;
  replicas: PopulationSnapshot["replicas"];
  observations: readonly LocalDynamicsObservation[];
  measurements?: readonly DynamicsMeasurement[];
  meanCorrelation?: number | null;
  meanCorrelationSource?: DynamicsMeasurementSource | null;
}): PopulationSnapshot {
  if (!params.campaignId.trim() || !params.groupId.trim()) {
    throw new Error("population campaign and group must be non-empty");
  }

  const correlation = params.meanCorrelation ?? null;
  if (
    correlation !== null &&
    (!Number.isFinite(correlation) || correlation < 0 || correlation > 1)
  ) {
    throw new Error("population correlation must be unknown or finite and in [0, 1]");
  }
  const correlationSource =
    correlation === null ? null : (params.meanCorrelationSource ?? "external");
  if (
    correlationSource !== null &&
    correlationSource !== "host" &&
    correlationSource !== "external"
  ) {
    throw new Error("meanCorrelationSource must be host, external, or null");
  }
  if (correlation === null && params.meanCorrelationSource != null) {
    throw new Error("meanCorrelationSource requires a measured meanCorrelation");
  }

  const replicaIds = new Set<string>();
  for (const replica of params.replicas) {
    if (
      !replica.replicaId.trim() ||
      replicaIds.has(replica.replicaId) ||
      replica.campaignId !== params.campaignId ||
      replica.groupId !== params.groupId
    ) {
      throw new Error(
        "population replicas must have unique identities in the same campaign and group",
      );
    }
    replicaIds.add(replica.replicaId);
  }

  const rawObservations = params.observations.map((item) => ({ ...item }));
  const observations = applyDynamicsMeasurements({
    observations: rawObservations,
    measurements: params.measurements,
    declaredReplicaIds: replicaIds,
  });
  const assessments: LocalPhaseAssessment[] = observations.map(assessLocalPhase);
  const observedIds = new Set<string>();
  for (const assessment of assessments) {
    if (
      observedIds.has(assessment.replicaId) ||
      (replicaIds.size > 0 && !replicaIds.has(assessment.replicaId))
    ) {
      throw new Error("population observations must identify unique declared replicas");
    }
    observedIds.add(assessment.replicaId);
  }
  for (const replicaId of replicaIds) {
    if (!observedIds.has(replicaId)) {
      assessments.push({
        replicaId,
        phase: "unknown",
        score: 0,
        trigger: "insufficient-data",
        reason: "no observation",
      });
    }
  }

  return {
    campaignId: params.campaignId,
    groupId: params.groupId,
    replicas: params.replicas.map((replica) => ({ ...replica })),
    observations,
    measurements: (params.measurements ?? []).map((measurement) => ({ ...measurement })),
    phaseMixture: phaseMixture(assessments),
    meanCorrelation: correlation,
    meanCorrelationSource: correlationSource,
    candidateEntropy: mean(observations.map((item) => item.candidateEntropy)),
    evidenceCompleteness: mean(observations.map((item) => item.evidenceCompleteness)),
    acceptanceProgress: mean(observations.map((item) => item.acceptanceProgress ?? null)),
    // Conservative pressure bounds: averaging must not hide one saturated lane.
    resourcePressure: maximum(observations.map((item) => item.resourcePressure)),
    contextPressure: maximum(observations.map((item) => item.contextPressure)),
    debtPressure: maximum(observations.map((item) => item.debtPressure)),
  };
}

export function assessPopulation(input: PopulationSnapshot): PopulationDecision {
  // Recompute projections rather than accepting caller-edited derived phase or pressure fields.
  const snapshot = buildPopulationSnapshot(input);
  const actions: DynamicsAction[] = [];
  const rationale: string[] = [];
  const mix = snapshot.phaseMixture;
  const systemPressure = Math.max(
    snapshot.resourcePressure ?? 0,
    snapshot.contextPressure ?? 0,
    snapshot.debtPressure ?? 0,
  );

  if (
    systemPressure >= CONTROL_HEURISTICS.drainPressure ||
    mix.jammed >= CONTROL_HEURISTICS.jammedMixture
  ) {
    actions.push({
      kind: "drain",
      reason: "resource/context/debt pressure is too high for further expansion",
    });
    rationale.push("jammed pressure takes precedence over exploratory expansion");
    return { authority: "search-only", actions, rationale };
  }

  const criticalObservations = snapshot.observations
    .filter((item) => assessLocalPhase(item).phase === "critical")
    .toSorted(
      (left, right) =>
        criticalPriority(right) - criticalPriority(left) ||
        left.replicaId.localeCompare(right.replicaId),
    );
  if (mix.critical >= CONTROL_HEURISTICS.criticalMixture) {
    const targets = criticalObservations.map((item) => item.replicaId);
    actions.push({
      kind: "measure",
      targetReplicaIds: targets,
      reason: "critical replicas require discriminating measurements before widening search",
    });
    const deepTargets = criticalObservations
      .slice(0, deepReasoningTargetCount(criticalObservations.length))
      .map((item) => item.replicaId);
    if (deepTargets.length > 0) {
      actions.push({
        kind: "deepen",
        targetReplicaIds: deepTargets,
        suggestedThinking: "high",
        reason: "scarce deep reasoning is reserved for the highest-uncertainty critical lanes",
      });
    }
    rationale.push(
      "critical behavior shifts budget from blind expansion to measurement and selective depth",
    );
  }

  const replicaCount = uniqueReplicaCount(snapshot);
  const effectivePopulation = estimateEffectiveIndependentPopulation(
    replicaCount,
    snapshot.meanCorrelation,
  );
  const correlationWaste =
    replicaCount >= 2 &&
    effectivePopulation !== null &&
    effectivePopulation / replicaCount <= CONTROL_HEURISTICS.correlationEffectiveRatioMin;
  let decorrelationRequested = false;
  if (correlationWaste) {
    actions.push({
      kind: "perturb",
      purpose: "decorrelate",
      count: 1,
      reason: "measured trajectory correlation is wasting parallel search capacity",
    });
    rationale.push("effective independent search is low relative to raw replica count");
    decorrelationRequested = true;
  }

  if (mix.glass >= CONTROL_HEURISTICS.glassMixture && !decorrelationRequested) {
    actions.push({
      kind: "perturb",
      purpose: "decorrelate",
      count: 1,
      reason: "bounded fresh-context perturbation for stalled low-mobility search",
    });
    rationale.push("glassy lanes get one bounded decorrelated perturbation");
  }

  const frozenTargets = snapshot.observations
    .filter((item) => assessLocalPhase(item).phase === "crystal")
    .map((item) => item.replicaId);
  if (frozenTargets.length > 0) {
    actions.push({
      kind: "freeze",
      targetReplicaIds: frozenTargets,
      reason: "low-entropy candidates with substantial evidence should be frozen for verification",
    });
    rationale.push("crystal-like candidates stop mutating; authority remains unchanged");
  }

  if (
    mix.gas >= CONTROL_HEURISTICS.gasMixture &&
    mix.critical === 0 &&
    systemPressure < CONTROL_HEURISTICS.spawnPressureMax &&
    !correlationWaste
  ) {
    actions.push({
      kind: "spawn",
      purpose: "coordinate",
      count: 1,
      reason: "broad exploration has enough diversity to justify one coordinating builder",
    });
    rationale.push("gas-heavy populations get a bounded coordinating lane, not unlimited fan-out");
  }

  if (actions.length === 0) {
    actions.push({ kind: "hold", reason: "current population does not justify a control change" });
    rationale.push("absence of a distinctive signal preserves current search posture");
  }
  return { authority: "search-only", actions, rationale };
}
