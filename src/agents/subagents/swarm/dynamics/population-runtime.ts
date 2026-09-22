import { buildDynamicsDiagnostic } from "./dynamics-diagnostics.js";
import { assessPopulation, buildPopulationSnapshot } from "./population-controller.js";
import type {
  DynamicsMeasurement,
  LocalDynamicsObservation,
  PopulationSnapshot,
} from "./population-types.js";

type HostCollectorTerminalStatus = "done" | "failed" | "killed" | "timeout" | null;

export type HostCollectorDynamicsRecord = {
  runId: string;
  terminalStatus: HostCollectorTerminalStatus;
};

function requireNonEmptyText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(name + " must be non-empty");
  }
  return normalized;
}

function emptyHostObservation(runId: string): LocalDynamicsObservation {
  return {
    replicaId: runId,
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

function hostMeasurement(
  replicaId: string,
  metric: DynamicsMeasurement["metric"],
  value: number,
): DynamicsMeasurement {
  return { version: 1, replicaId, metric, value, source: "host" };
}

function buildHostCollectorSnapshot(params: {
  groupId: string;
  maxConcurrent: number;
  records: readonly HostCollectorDynamicsRecord[];
}): PopulationSnapshot {
  const groupId = requireNonEmptyText(params.groupId, "group id");
  if (!Number.isSafeInteger(params.maxConcurrent) || params.maxConcurrent < 1) {
    throw new Error("maxConcurrent must be a positive safe integer");
  }

  const runIds = new Set<string>();
  const records = params.records.map((record) => {
    const runId = requireNonEmptyText(record.runId, "collector run id");
    if (runIds.has(runId)) {
      throw new Error("collector dynamics records require unique run ids");
    }
    runIds.add(runId);
    return { runId, terminalStatus: record.terminalStatus };
  });

  const activeCount = records.filter((record) => record.terminalStatus === null).length;
  const resourcePressure = Math.min(1, activeCount / params.maxConcurrent);
  const observations = records.map((record) => emptyHostObservation(record.runId));
  const measurements: DynamicsMeasurement[] = [];

  for (const record of records) {
    measurements.push(hostMeasurement(record.runId, "resourcePressure", resourcePressure));
    if (record.terminalStatus !== null) {
      measurements.push(
        hostMeasurement(record.runId, "debtPressure", record.terminalStatus === "done" ? 0 : 1),
        hostMeasurement(record.runId, "progressRate", record.terminalStatus === "done" ? 1 : 0),
      );
    }
  }

  return buildPopulationSnapshot({
    campaignId: groupId,
    groupId,
    replicas: [],
    observations,
    measurements,
    meanCorrelation: null,
  });
}

/**
 * Project the same host-owned snapshot into both a search-only decision and
 * diagnostics. Semantic search metrics remain unknown until a separate trusted
 * producer supplies typed external measurements.
 */
export function diagnoseHostCollectorPopulation(params: {
  groupId: string;
  maxConcurrent: number;
  records: readonly HostCollectorDynamicsRecord[];
}) {
  const snapshot = buildHostCollectorSnapshot(params);
  const decision = assessPopulation(snapshot);
  return {
    decision,
    diagnostic: buildDynamicsDiagnostic(snapshot, decision),
  };
}
