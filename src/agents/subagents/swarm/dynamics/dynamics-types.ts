export const DYNAMICS_PROFILE_VERSION = 1 as const;

export const DYNAMICS_ROLES = [
  "explorer",
  "builder",
  "integrator",
  "critic",
  "security",
  "performance",
  "reproducer",
  "verifier",
  "glass-breaker",
] as const;

export type DynamicsRole = (typeof DYNAMICS_ROLES)[number];

export const INFORMATION_BOUNDARIES = [
  "isolated",
  "artifact-only",
  "evidence-only",
  "summary-only",
  "fork",
] as const;

export type InformationBoundary = (typeof INFORMATION_BOUNDARIES)[number];

export type DynamicsProfile = {
  version: typeof DYNAMICS_PROFILE_VERSION;
  id: string;
  role: DynamicsRole;
  effectiveTemperature: number;
  mutationBudget: number;
  verificationWeight: number;
  contextBoundary: InformationBoundary;
};

export type ResolvedDynamicsProfile = DynamicsProfile & {
  digestInput: string;
};

export type CognitiveReplica = {
  replicaId: string;
  campaignId: string;
  groupId: string;
  runId: string;
  requesterSessionKey: string;
  parentReplicaId?: string;
  profile: ResolvedDynamicsProfile;
  authority: "search-only";
};

export type HandoffManifest = {
  version: 1;
  sourceReplicaId: string;
  targetReplicaId: string;
  boundary: InformationBoundary;
  candidateDigest?: string;
  artifactRefs: readonly string[];
  evidenceRefs: readonly string[];
  summary?: string;
};
