import type {
  CognitivePhase,
  LocalDynamicsObservation,
  LocalPhaseAssessment,
  PhaseMixture,
} from "./population-types.js";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

export function assessLocalPhase(observation: LocalDynamicsObservation): LocalPhaseAssessment {
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

  const pressure = Math.max(resourcePressure, contextPressure, debtPressure);
  let phase: CognitivePhase = "unknown";
  let confidence = 0.5;
  let reason = "insufficiently distinctive observation";

  if (pressure >= 0.85) {
    phase = "jammed";
    confidence = pressure;
    reason = "resource/context/debt pressure dominates";
  } else if (mobility <= 0.2 && evidenceCompleteness < 0.75 && progressRate <= 0.2) {
    phase = "glass";
    confidence = clamp01((1 - mobility + (1 - progressRate)) / 2);
    reason = "low mobility and low progress without sufficient evidence";
  } else if (verifierDisagreement >= 0.55 || (candidateEntropy >= 0.45 && candidateEntropy <= 0.65)) {
    phase = "critical";
    confidence = Math.max(verifierDisagreement, 1 - Math.abs(candidateEntropy - 0.55));
    reason = "high disagreement or unstable candidate entropy";
  } else if (candidateEntropy <= 0.2 && coherence >= 0.8 && evidenceCompleteness >= 0.8) {
    phase = "crystal";
    confidence = clamp01((coherence + evidenceCompleteness + (1 - candidateEntropy)) / 3);
    reason = "low candidate entropy with high coherence and evidence completeness";
  } else if (candidateEntropy >= 0.7 && coherence <= 0.45) {
    phase = "gas";
    confidence = clamp01((candidateEntropy + (1 - coherence)) / 2);
    reason = "high candidate entropy with low coherence";
  } else if (mobility >= 0.35 && coherence >= 0.45) {
    phase = "liquid";
    confidence = clamp01((mobility + coherence) / 2);
    reason = "productive mobility with moderate coherence";
  }

  return {
    replicaId: observation.replicaId,
    phase,
    confidence: clamp01(confidence),
    reason,
  };
}

export function phaseMixture(
  assessments: readonly LocalPhaseAssessment[],
): PhaseMixture {
  const phases: CognitivePhase[] = [
    "gas",
    "liquid",
    "critical",
    "crystal",
    "glass",
    "jammed",
    "unknown",
  ];
  const counts = Object.fromEntries(phases.map((phase) => [phase, 0])) as PhaseMixture;
  if (assessments.length === 0) {
    counts.unknown = 1;
    return counts;
  }
  for (const assessment of assessments) {
    counts[assessment.phase] += 1 / assessments.length;
  }
  return counts;
}
