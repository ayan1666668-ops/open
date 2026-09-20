import type { PopulationDecision, PopulationSnapshot } from "./population-types.js";

export type DynamicsDiagnostic = {
  campaignId: string;
  groupId: string;
  activeReplicas: number;
  phaseMixture: PopulationSnapshot["phaseMixture"];
  evidenceCompleteness: number | null;
  candidateEntropy: number | null;
  systemPressure: number | null;
  decisionKinds: readonly string[];
  unresolved: readonly string[];
};

export function buildDynamicsDiagnostic(
  snapshot: PopulationSnapshot,
  decision: PopulationDecision,
): DynamicsDiagnostic {
  const pressures = [
    snapshot.resourcePressure,
    snapshot.contextPressure,
    snapshot.debtPressure,
  ].filter((value): value is number => value !== null);

  const unresolved: string[] = [];
  if ((snapshot.evidenceCompleteness ?? 0) < 0.8) {
    unresolved.push("evidence-incomplete");
  }
  if ((snapshot.phaseMixture.critical ?? 0) > 0) {
    unresolved.push("critical-disagreement");
  }
  if ((snapshot.phaseMixture.jammed ?? 0) > 0) {
    unresolved.push("jammed-pressure");
  }
  if ((snapshot.phaseMixture.unknown ?? 0) > 0) {
    unresolved.push("unknown-phase");
  }

  return {
    campaignId: snapshot.campaignId,
    groupId: snapshot.groupId,
    activeReplicas: snapshot.replicas.length,
    phaseMixture: snapshot.phaseMixture,
    evidenceCompleteness: snapshot.evidenceCompleteness,
    candidateEntropy: snapshot.candidateEntropy,
    systemPressure: pressures.length > 0 ? Math.max(...pressures) : null,
    decisionKinds: decision.actions.map((action) => action.kind),
    unresolved,
  };
}
