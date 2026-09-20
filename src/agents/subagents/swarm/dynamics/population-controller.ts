import { assessLocalPhase, phaseMixture } from "./phase-assessment.js";
import type {
  DynamicsAction,
  LocalDynamicsObservation,
  PopulationDecision,
  PopulationSnapshot,
} from "./population-types.js";

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function buildPopulationSnapshot(params: {
  campaignId: string;
  groupId: string;
  replicas: PopulationSnapshot["replicas"];
  observations: readonly LocalDynamicsObservation[];
  meanCorrelation?: number | null;
}): PopulationSnapshot {
  const assessments = params.observations.map(assessLocalPhase);
  return {
    campaignId: params.campaignId,
    groupId: params.groupId,
    replicas: params.replicas,
    observations: params.observations,
    phaseMixture: phaseMixture(assessments),
    meanCorrelation: params.meanCorrelation ?? null,
    candidateEntropy: mean(params.observations.map((item) => item.candidateEntropy)),
    evidenceCompleteness: mean(params.observations.map((item) => item.evidenceCompleteness)),
    resourcePressure: mean(params.observations.map((item) => item.resourcePressure)),
    contextPressure: mean(params.observations.map((item) => item.contextPressure)),
    debtPressure: mean(params.observations.map((item) => item.debtPressure)),
  };
}

export function assessPopulation(snapshot: PopulationSnapshot): PopulationDecision {
  const actions: DynamicsAction[] = [];
  const rationale: string[] = [];
  const mix = snapshot.phaseMixture;

  const systemPressure = Math.max(
    snapshot.resourcePressure ?? 0,
    snapshot.contextPressure ?? 0,
    snapshot.debtPressure ?? 0,
  );

  if (systemPressure >= 0.8 || mix.jammed >= 0.25) {
    actions.push({
      kind: "drain",
      reason: "resource/context/debt pressure is too high for further expansion",
    });
    rationale.push("jammed pressure takes precedence over exploratory expansion");
    return { authority: "search-only", actions, rationale };
  }

  if (mix.critical >= 0.2) {
    const targets = snapshot.observations
      .filter((item) => assessLocalPhase(item).phase === "critical")
      .map((item) => item.replicaId);
    actions.push({
      kind: "measure",
      targetReplicaIds: targets,
      reason: "critical replicas require discriminating measurements before widening search",
    });
    rationale.push("critical behavior shifts budget from blind expansion to measurement");
  }

  if (mix.glass >= 0.15) {
    actions.push({
      kind: "perturb",
      profile: "glass-breaker",
      count: 1,
      reason: "bounded fresh-context perturbation for stalled low-mobility search",
    });
    rationale.push("glassy lanes get one bounded decorrelated perturbation");
  }

  const evidence = snapshot.evidenceCompleteness ?? 0;
  const entropy = snapshot.candidateEntropy ?? 1;
  if (mix.crystal >= 0.2 && evidence >= 0.8 && entropy <= 0.25) {
    const targets = snapshot.observations
      .filter((item) => assessLocalPhase(item).phase === "crystal")
      .map((item) => item.replicaId);
    actions.push({
      kind: "freeze",
      targetReplicaIds: targets,
      reason: "low-entropy candidates with substantial evidence should be frozen for verification",
    });
    rationale.push("crystal-like candidates stop mutating; authority remains unchanged");
  }

  if (mix.gas >= 0.4 && systemPressure < 0.6) {
    actions.push({
      kind: "spawn",
      profile: "builder",
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
