type CognitiveReplica = {
  replicaId: string;
  campaignId: string;
  groupId: string;
  runId: string;
  requesterSessionKey: string;
  parentReplicaId?: string;
  trajectoryLabel?: string;
  authority: "search-only";
};

export const COGNITIVE_PHASES = [
  "gas",
  "liquid",
  "critical",
  "crystal",
  "glass",
  "jammed",
  "unknown",
] as const;

export type CognitivePhase = (typeof COGNITIVE_PHASES)[number];

export type DynamicsMetric = number | null;

export const DYNAMICS_METRIC_NAMES = [
  "candidateEntropy",
  "coherence",
  "mobility",
  "evidenceCompleteness",
  "acceptanceProgress",
  "verifierDisagreement",
  "resourcePressure",
  "contextPressure",
  "debtPressure",
  "branchingRatio",
  "progressRate",
] as const;

export type DynamicsMetricName = (typeof DYNAMICS_METRIC_NAMES)[number];
export type DynamicsMeasurementSource = "host" | "external";

export type DynamicsMeasurement = {
  version: 1;
  replicaId: string;
  metric: DynamicsMetricName;
  value: number;
  source: DynamicsMeasurementSource;
  candidateIdentity?: string;
  evidenceRef?: string;
};

export type LocalDynamicsObservation = {
  replicaId: string;
  candidateEntropy: DynamicsMetric;
  coherence: DynamicsMetric;
  mobility: DynamicsMetric;
  evidenceCompleteness: DynamicsMetric;
  /** Distance-to-acceptance coordinate; omitted means unknown. */
  acceptanceProgress?: DynamicsMetric;
  verifierDisagreement: DynamicsMetric;
  resourcePressure: DynamicsMetric;
  contextPressure: DynamicsMetric;
  debtPressure: DynamicsMetric;
  branchingRatio: DynamicsMetric;
  progressRate: DynamicsMetric;
};

export type LocalPhaseTrigger =
  | "pressure"
  | "verifier-conflict"
  | "low-mobility"
  | "entropy-ambiguity"
  | "frozen-candidate"
  | "high-entropy"
  | "productive-motion"
  | "insufficient-data";

export type LocalPhaseAssessment = {
  replicaId: string;
  phase: CognitivePhase;
  /** Heuristic salience score, not calibrated statistical confidence. */
  score: number;
  trigger: LocalPhaseTrigger;
  reason: string;
};

export type PhaseMixture = Record<CognitivePhase, number>;

export type PopulationSnapshot = {
  campaignId: string;
  groupId: string;
  replicas: readonly CognitiveReplica[];
  observations: readonly LocalDynamicsObservation[];
  measurements: readonly DynamicsMeasurement[];
  phaseMixture: PhaseMixture;
  meanCorrelation: number | null;
  meanCorrelationSource: DynamicsMeasurementSource | null;
  candidateEntropy: number | null;
  evidenceCompleteness: number | null;
  acceptanceProgress: number | null;
  resourcePressure: number | null;
  contextPressure: number | null;
  debtPressure: number | null;
};

export type DynamicsAction =
  | { kind: "spawn"; purpose: "coordinate"; count: number; reason: string }
  | { kind: "measure"; targetReplicaIds: readonly string[]; reason: string }
  | {
      kind: "deepen";
      targetReplicaIds: readonly string[];
      suggestedThinking: "high";
      reason: string;
    }
  | { kind: "freeze"; targetReplicaIds: readonly string[]; reason: string }
  | { kind: "perturb"; purpose: "decorrelate"; count: number; reason: string }
  | { kind: "drain"; reason: string }
  | { kind: "hold"; reason: string };

export type PopulationDecision = {
  authority: "search-only";
  actions: readonly DynamicsAction[];
  rationale: readonly string[];
};
