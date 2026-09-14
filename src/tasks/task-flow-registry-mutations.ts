import {
  applyFlowPatch,
  areTaskFlowRecordsEqual,
  buildFlowRecord,
  cloneFlowRecord,
  normalizeRestoredFlowRecord,
  type FlowRecordCreateFields,
  type FlowRecordPatch,
} from "./task-flow-registry.records.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import type {
  TaskFlowRegistryAtomicOwnerCondition,
  TaskFlowRegistryUpdateResult,
} from "./task-flow-registry.store.types.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

export type TaskFlowUpdateResult =
  | { applied: true; flow: TaskFlowRecord }
  | {
      applied: false;
      reason: "not_found" | "revision_conflict" | "persist_failed";
      current?: TaskFlowRecord;
    };

export type TaskFlowAtomicUpdate = {
  flowId: string;
  expectedRevision: number;
  patch: FlowRecordPatch;
};

export type TaskFlowAtomicUpdateResult =
  | { applied: true; flows: TaskFlowRecord[] }
  | {
      applied: false;
      reason: "not_found" | "revision_conflict" | "persist_failed";
      flowId?: string;
      current?: TaskFlowRecord;
    };

export type TaskFlowAtomicCreateResult =
  | { applied: true; created: TaskFlowRecord; updated: TaskFlowRecord[] }
  | Exclude<TaskFlowAtomicUpdateResult, { applied: true }>;

type TaskFlowRegistryMutationContext = {
  ensureReady: () => void;
  getFlows: () => Map<string, TaskFlowRecord>;
  incrementProjectionEpoch: () => void;
  reloadFromStore: () => void;
  publishUpsert: (flow: TaskFlowRecord, previous?: TaskFlowRecord) => void;
  publishDelete: (flowId: string, previous: TaskFlowRecord) => void;
  warn: (message: string, meta: Record<string, unknown>) => void;
};

export function createTaskFlowRegistryMutationApi(context: TaskFlowRegistryMutationContext) {
  function prepareTaskFlowAtomicUpdates(
    updates: readonly TaskFlowAtomicUpdate[],
  ):
    | { applied: true; entries: Array<{ current: TaskFlowRecord; next: TaskFlowRecord }> }
    | Exclude<TaskFlowAtomicUpdateResult, { applied: true }> {
    const flows = context.getFlows();
    const seenFlowIds = new Set<string>();
    const entries: Array<{ current: TaskFlowRecord; next: TaskFlowRecord }> = [];
    for (const update of updates) {
      if (seenFlowIds.has(update.flowId)) {
        const current = flows.get(update.flowId);
        return {
          applied: false,
          reason: "revision_conflict",
          flowId: update.flowId,
          ...(current ? { current: cloneFlowRecord(current) } : {}),
        };
      }
      seenFlowIds.add(update.flowId);
      const current = flows.get(update.flowId);
      if (!current) {
        return { applied: false, reason: "not_found", flowId: update.flowId };
      }
      if (current.revision !== update.expectedRevision) {
        return {
          applied: false,
          reason: "revision_conflict",
          flowId: update.flowId,
          current: cloneFlowRecord(current),
        };
      }
      entries.push({ current, next: applyFlowPatch(current, update.patch) });
    }
    return { applied: true, entries };
  }

  function commitTaskFlowAtomicChanges(params: {
    created: TaskFlowRecord;
    updates: readonly TaskFlowAtomicUpdate[];
    ownerCondition?: TaskFlowRegistryAtomicOwnerCondition;
  }): TaskFlowAtomicCreateResult;
  function commitTaskFlowAtomicChanges(params: {
    created?: undefined;
    updates: readonly TaskFlowAtomicUpdate[];
    ownerCondition?: TaskFlowRegistryAtomicOwnerCondition;
  }): TaskFlowAtomicUpdateResult;
  function commitTaskFlowAtomicChanges(params: {
    created?: TaskFlowRecord;
    updates: readonly TaskFlowAtomicUpdate[];
    ownerCondition?: TaskFlowRegistryAtomicOwnerCondition;
  }): TaskFlowAtomicCreateResult | TaskFlowAtomicUpdateResult {
    context.ensureReady();
    const prepared = prepareTaskFlowAtomicUpdates(params.updates);
    if (!prepared.applied) {
      return prepared;
    }
    const changed = [
      ...prepared.entries.map((entry) => entry.next),
      ...(params.created ? [params.created] : []),
    ];
    if (changed.length === 0) {
      return { applied: true, flows: [] };
    }
    try {
      const store = getTaskFlowRegistryStore();
      if (!store.upsertFlowsAtomically) {
        throw new Error("task-flow registry store does not support atomic writes");
      }
      const applied = store.upsertFlowsAtomically({
        changes: [
          ...prepared.entries.map((entry) => ({
            flow: cloneFlowRecord(entry.next),
            expectedRevision: entry.current.revision,
          })),
          ...(params.created ? [{ flow: cloneFlowRecord(params.created) }] : []),
        ],
        ...(params.ownerCondition ? { ownerCondition: params.ownerCondition } : {}),
      });
      if (!applied) {
        context.reloadFromStore();
        return { applied: false, reason: "revision_conflict" };
      }
    } catch (error) {
      context.warn("Failed to persist atomic task-flow changes", {
        createdFlowId: params.created?.flowId,
        updatedFlowIds: params.updates.map((update) => update.flowId),
        error,
      });
      return { applied: false, reason: "persist_failed" };
    }

    const flows = context.getFlows();
    for (const flow of changed) {
      flows.set(flow.flowId, flow);
    }
    for (const entry of prepared.entries) {
      context.publishUpsert(cloneFlowRecord(entry.next), cloneFlowRecord(entry.current));
    }
    const created = params.created;
    if (created) {
      context.publishUpsert(cloneFlowRecord(created));
      return {
        applied: true,
        created: cloneFlowRecord(created),
        updated: prepared.entries.map((entry) => cloneFlowRecord(entry.next)),
      };
    }
    return {
      applied: true,
      flows: prepared.entries.map((entry) => cloneFlowRecord(entry.next)),
    };
  }

  function createManagedTaskFlowWithAtomicUpdates(params: {
    create: FlowRecordCreateFields & { controllerId: string };
    updates: readonly TaskFlowAtomicUpdate[];
    ownerCondition?: TaskFlowRegistryAtomicOwnerCondition;
  }): TaskFlowAtomicCreateResult {
    const created = buildFlowRecord({
      ...params.create,
      syncMode: "managed",
      controllerId: params.create.controllerId,
    });
    return commitTaskFlowAtomicChanges({
      created,
      updates: params.updates,
      ...(params.ownerCondition ? { ownerCondition: params.ownerCondition } : {}),
    });
  }

  function updateTaskFlowsAtomically(
    updates: readonly TaskFlowAtomicUpdate[],
  ): TaskFlowAtomicUpdateResult {
    return commitTaskFlowAtomicChanges({ updates });
  }

  function updateFlowRecordByIdExpectedRevision(params: {
    flowId: string;
    expectedRevision: number;
    patch: FlowRecordPatch;
  }): TaskFlowUpdateResult {
    context.ensureReady();
    const cached = context.getFlows().get(params.flowId);
    let result: TaskFlowRegistryUpdateResult;
    try {
      result = getTaskFlowRegistryStore().updateFlow(params, (observed) => {
        const current = observed.applied
          ? observed.flow
          : observed.reason === "revision_conflict"
            ? observed.current
            : undefined;
        const canonical = current ? cloneFlowRecord(current) : undefined;
        const previous = observed.applied ? observed.previous : cached;
        const changed =
          observed.applied ||
          !areTaskFlowRecordsEqual(
            cached ? normalizeRestoredFlowRecord(cached) : undefined,
            canonical,
          );
        const next = changed ? canonical : cached;
        let committed: TaskFlowRecord | undefined;
        return {
          stage: () => {
            context.incrementProjectionEpoch();
            if (next) {
              context.getFlows().set(params.flowId, next);
            } else {
              context.getFlows().delete(params.flowId);
            }
          },
          rollback: () => {
            context.incrementProjectionEpoch();
            if (cached) {
              context.getFlows().set(params.flowId, cached);
            } else {
              context.getFlows().delete(params.flowId);
            }
          },
          commit: () => {
            context.incrementProjectionEpoch();
            // Capture the final staged entry before any observer can reenter this owner.
            committed = context.getFlows().get(params.flowId);
          },
          publish: () => {
            if (!changed || context.getFlows().get(params.flowId) !== committed) {
              return;
            }
            if (next) {
              context.publishUpsert(next, previous);
            } else if (previous) {
              context.publishDelete(params.flowId, previous);
            }
          },
        };
      });
    } catch (error) {
      context.warn("Failed to persist task-flow registry update", {
        flowId: params.flowId,
        error,
      });
      return {
        applied: false,
        reason: "persist_failed",
        ...(cached ? { current: cloneFlowRecord(cached) } : {}),
      };
    }
    if (result.applied) {
      return { applied: true, flow: cloneFlowRecord(result.flow) };
    }
    if (result.reason === "invalid_patch") {
      throw result.error;
    }
    return result.reason === "revision_conflict"
      ? { ...result, current: cloneFlowRecord(result.current) }
      : result;
  }

  return {
    createManagedTaskFlowWithAtomicUpdates,
    updateFlowRecordByIdExpectedRevision,
    updateTaskFlowsAtomically,
  };
}
