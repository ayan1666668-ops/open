// Defines storage contracts for managed task-flow records.
import type { FlowRecordPatch } from "./task-flow-registry.records.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

export type TaskFlowRegistryUpdate = {
  flowId: string;
  expectedRevision: number;
  patch: FlowRecordPatch;
};

export type TaskFlowRegistryObservedUpdate =
  | { applied: true; previous: TaskFlowRecord; flow: TaskFlowRecord }
  | { applied: false; reason: "not_found" }
  | { applied: false; reason: "revision_conflict"; current: TaskFlowRecord };

export type TaskFlowRegistryUpdateResult =
  | TaskFlowRegistryObservedUpdate
  | { applied: false; reason: "invalid_patch"; error: unknown };

/** Stage read-your-writes state separately from committed observer publication. */
export type TaskFlowRegistryUpdatePublication = {
  stage: () => void;
  rollback: () => void;
  commit: () => void;
  publish: () => void;
};

/** Full task-flow registry snapshot used for persistence restore and replacement writes. */
export type TaskFlowRegistryStoreSnapshot = {
  flows: Map<string, TaskFlowRecord>;
};

type TaskFlowRegistryAtomicChange = {
  flow: TaskFlowRecord;
  expectedRevision?: number;
};

export type TaskFlowRegistryAtomicOwnerCondition = {
  ownerKey: string;
  controllerId: string;
  statuses: readonly TaskFlowRecord["status"][];
  expectedFlows: ReadonlyArray<Pick<TaskFlowRecord, "flowId" | "revision" | "status">>;
  excludeCancelRequested?: boolean;
};

export type TaskFlowRegistryAtomicWrite = {
  changes: readonly TaskFlowRegistryAtomicChange[];
  ownerCondition?: TaskFlowRegistryAtomicOwnerCondition;
};
