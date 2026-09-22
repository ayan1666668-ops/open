import {
  COGNITIVE_PHASES,
  type CognitivePhase,
  type DynamicsMetric,
  type LocalDynamicsObservation,
  type LocalPhaseAssessment,
  type LocalPhaseTrigger,
  type PhaseMixture,
} from "./population-types.js";

const PHASES = new Set<CognitivePhase>(COGNITIVE_PHASES);

/**
 * Explicit experimental heuristics. These are policy constants, not calibrated
 * physical phase-transition estimates.
 */
export const PHASE_HEURISTICS = {
  jamPressure: 0.85,
  verifierConflict: 0.55,
  glassMobilityMax: 0.2,
  glassProgressMax: 0.2,
  glassEvidenceMax: 0.75,
  ambiguityEntropyMin: 0.45,
  ambiguityEntropyMax: 0.65,
  frozenEntropyMax: 0.2,
  frozenCoherenceMin: 0.8,
  frozenEvidenceMin: 0.8,
  frozenAcceptanceMin: 0.8,
  frozenDisagreementMax: 0.15,
  gasEntropyMin: 0.7,
  gasCoherenceMax: 0.45,
  liquidMobilityMin: 0.35,
  liquidCoherenceMin: 0.45,
} as const;

function validateUnitMetric(value: DynamicsMetric | undefined, name: string): void {
  if (value === null || value === undefined) {
    return;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(name + " must be unknown or finite and in [0, 1]");
  }
}

function validateDynamicsObservation(observation: LocalDynamicsObservation): void {
  if (typeof observation.replicaId !== "string" || !observation.replicaId.trim()) {
    throw new Error("replicaId must be non-empty");
  }
  for (const key of [
    "candidateEntropy",
    "coherence",
    "mobility",
    "evidenceCompleteness",
    "acceptanceProgress",
    "verifierDisagreement",
    "resourcePressure",
    "contextPressure",
    "debtPressure",
    "progressRate",
  ] as const) {
    validateUnitMetric(observation[key], key);
  }
  if (
    observation.branchingRatio !== null &&
    (!Number.isFinite(observation.branchingRatio) || observation.branchingRatio < 0)
  ) {
    throw new Error("branchingRatio must be unknown or finite and non-negative");
  }
}

function maximumKnown(values: readonly (DynamicsMetric | undefined)[]): number | null {
  const known = values.filter((value): value is number => value !== null && value !== undefined);
  return known.length === 0 ? null : Math.max(...known);
}

export function assessLocalPhase(observation: LocalDynamicsObservation): LocalPhaseAssessment {
  validateDynamicsObservation(observation);
  const {
    candidateEntropy,
    coherence,
    mobility,
    evidenceCompleteness,
    verifierDisagreement,
    resourcePressure,
    contextPressure,
    debtPressure,
    progressRate,
  } = observation;
  const acceptanceProgress = observation.acceptanceProgress ?? null;
  const pressure = maximumKnown([resourcePressure, contextPressure, debtPressure]);

  let phase: CognitivePhase = "unknown";
  let score = 0;
  let trigger: LocalPhaseTrigger = "insufficient-data";
  let reason = "insufficient measured telemetry";

  if (pressure !== null && pressure >= PHASE_HEURISTICS.jamPressure) {
    phase = "jammed";
    score = pressure;
    trigger = "pressure";
    reason = "resource/context/debt pressure dominates";
  } else if (
    verifierDisagreement !== null &&
    verifierDisagreement >= PHASE_HEURISTICS.verifierConflict
  ) {
    phase = "critical";
    score = verifierDisagreement;
    trigger = "verifier-conflict";
    reason = "verifier conflict requires a discriminating measurement before amplification";
  } else if (
    mobility !== null &&
    evidenceCompleteness !== null &&
    progressRate !== null &&
    mobility <= PHASE_HEURISTICS.glassMobilityMax &&
    evidenceCompleteness < PHASE_HEURISTICS.glassEvidenceMax &&
    progressRate <= PHASE_HEURISTICS.glassProgressMax
  ) {
    phase = "glass";
    score = (1 - mobility + (1 - progressRate)) / 2;
    trigger = "low-mobility";
    reason = "low mobility and low progress without sufficient evidence";
  } else if (
    candidateEntropy !== null &&
    candidateEntropy >= PHASE_HEURISTICS.ambiguityEntropyMin &&
    candidateEntropy <= PHASE_HEURISTICS.ambiguityEntropyMax
  ) {
    const midpoint =
      (PHASE_HEURISTICS.ambiguityEntropyMin + PHASE_HEURISTICS.ambiguityEntropyMax) / 2;
    const halfWidth =
      (PHASE_HEURISTICS.ambiguityEntropyMax - PHASE_HEURISTICS.ambiguityEntropyMin) / 2;
    phase = "critical";
    score = 1 - Math.abs(candidateEntropy - midpoint) / halfWidth;
    trigger = "entropy-ambiguity";
    reason = "candidate entropy is in the explicit ambiguity band";
  } else if (
    candidateEntropy !== null &&
    coherence !== null &&
    evidenceCompleteness !== null &&
    verifierDisagreement !== null &&
    candidateEntropy <= PHASE_HEURISTICS.frozenEntropyMax &&
    coherence >= PHASE_HEURISTICS.frozenCoherenceMin &&
    evidenceCompleteness >= PHASE_HEURISTICS.frozenEvidenceMin &&
    (acceptanceProgress === null || acceptanceProgress >= PHASE_HEURISTICS.frozenAcceptanceMin) &&
    verifierDisagreement <= PHASE_HEURISTICS.frozenDisagreementMax
  ) {
    phase = "crystal";
    score = (coherence + evidenceCompleteness + (1 - candidateEntropy)) / 3;
    trigger = "frozen-candidate";
    reason =
      acceptanceProgress === null
        ? "low entropy with high coherence/evidence; acceptance progress is still unknown"
        : "low entropy with high coherence/evidence and strong acceptance progress";
  } else if (
    candidateEntropy !== null &&
    coherence !== null &&
    candidateEntropy >= PHASE_HEURISTICS.gasEntropyMin &&
    coherence <= PHASE_HEURISTICS.gasCoherenceMax
  ) {
    phase = "gas";
    score = (candidateEntropy + (1 - coherence)) / 2;
    trigger = "high-entropy";
    reason = "high candidate entropy with low coherence";
  } else if (
    mobility !== null &&
    coherence !== null &&
    mobility >= PHASE_HEURISTICS.liquidMobilityMin &&
    coherence >= PHASE_HEURISTICS.liquidCoherenceMin
  ) {
    phase = "liquid";
    score = (mobility + coherence) / 2;
    trigger = "productive-motion";
    reason = "productive mobility with moderate coherence";
  }

  return { replicaId: observation.replicaId, phase, score, trigger, reason };
}

export function phaseMixture(assessments: readonly LocalPhaseAssessment[]): PhaseMixture {
  const counts: PhaseMixture = {
    gas: 0,
    liquid: 0,
    critical: 0,
    crystal: 0,
    glass: 0,
    jammed: 0,
    unknown: 0,
  };
  if (assessments.length === 0) {
    counts.unknown = 1;
    return counts;
  }
  const seen = new Set<string>();
  for (const assessment of assessments) {
    if (!PHASES.has(assessment.phase) || seen.has(assessment.replicaId)) {
      throw new Error("phase mixture requires one valid assessment per replica");
    }
    seen.add(assessment.replicaId);
    counts[assessment.phase] += 1;
  }
  for (const phaseName of COGNITIVE_PHASES) {
    counts[phaseName] /= assessments.length;
  }
  return counts;
}
