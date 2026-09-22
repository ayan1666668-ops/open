import {
  buildPopulationSnapshot,
  estimateEffectiveIndependentPopulation,
} from "./population-controller.js";
import type { PopulationDecision, PopulationSnapshot } from "./population-types.js";

type DynamicsDiagnostic = {
  campaignId: string;
  groupId: string;
  /** Declared or observed replicas, not a claim about which runs are still active. */
  replicaCount: number;
  meanCorrelation: number | null;
  meanCorrelationSource: PopulationSnapshot["meanCorrelationSource"];
  effectiveIndependentReplicas: number | null;
  phaseMixture: PopulationSnapshot["phaseMixture"];
  evidenceCompleteness: number | null;
  acceptanceProgress: number | null;
  candidateEntropy: number | null;
  systemPressure: number | null;
  hostMeasurementCount: number;
  externalMeasurementCount: number;
  decisionKinds: readonly string[];
  unresolved: readonly string[];
};

export function buildDynamicsDiagnostic(
  input: PopulationSnapshot,
  decision: PopulationDecision,
): DynamicsDiagnostic {
  const snapshot = buildPopulationSnapshot(input);
  const pressures = [
    snapshot.resourcePressure,
    snapshot.contextPressure,
    snapshot.debtPressure,
  ].filter((value): value is number => value !== null);
  const unresolved: string[] = [];
  if (snapshot.evidenceCompleteness === null) {
    unresolved.push("evidence-unknown");
  } else if (snapshot.evidenceCompleteness < 1) {
    unresolved.push("evidence-incomplete");
  }
  if (snapshot.acceptanceProgress === null) {
    unresolved.push("acceptance-progress-unknown");
  }
  if (snapshot.phaseMixture.critical > 0) {
    unresolved.push("critical-disagreement-or-ambiguity");
  }
  if (snapshot.phaseMixture.jammed > 0) {
    unresolved.push("jammed-pressure");
  }
  if (snapshot.phaseMixture.unknown > 0) {
    unresolved.push("unknown-phase");
  }
  const replicaIds = new Set([
    ...snapshot.replicas.map((replica) => replica.replicaId),
    ...snapshot.observations.map((observation) => observation.replicaId),
  ]);
  const replicaCount = replicaIds.size;
  return {
    campaignId: snapshot.campaignId,
    groupId: snapshot.groupId,
    replicaCount,
    meanCorrelation: snapshot.meanCorrelation,
    meanCorrelationSource: snapshot.meanCorrelationSource,
    effectiveIndependentReplicas: estimateEffectiveIndependentPopulation(
      replicaCount,
      snapshot.meanCorrelation,
    ),
    phaseMixture: snapshot.phaseMixture,
    evidenceCompleteness: snapshot.evidenceCompleteness,
    acceptanceProgress: snapshot.acceptanceProgress,
    candidateEntropy: snapshot.candidateEntropy,
    systemPressure: pressures.length > 0 ? Math.max(...pressures) : null,
    hostMeasurementCount: snapshot.measurements.filter((item) => item.source === "host").length,
    externalMeasurementCount: snapshot.measurements.filter(
      (item) => item.source === "external",
    ).length,
    decisionKinds: decision.actions.map((action) => action.kind),
    unresolved,
  };
}
