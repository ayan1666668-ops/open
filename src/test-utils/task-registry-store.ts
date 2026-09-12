import {
  applyFlowPatch,
  normalizeRestoredFlowRecord,
} from "../tasks/task-flow-registry.records.js";
import type { getTaskFlowRegistryStore } from "../tasks/task-flow-registry.store.js";
import type {
  TaskFlowRegistryObservedUpdate,
  TaskFlowRegistryStoreSnapshot,
} from "../tasks/task-flow-registry.store.types.js";
import type { TaskRegistryStore, TaskRegistryStoreSnapshot } from "../tasks/task-registry.store.js";

type TaskFlowRegistryStore = ReturnType<typeof getTaskFlowRegistryStore>;

export function createInMemoryTaskRegistryStore(
  snapshot: TaskRegistryStoreSnapshot = { tasks: new Map(), deliveryStates: new Map() },
): TaskRegistryStore {
  const state = structuredClone(snapshot);
  return {
    loadSnapshot: () => structuredClone(state),
    upsertTaskWithDeliveryState: ({ task, deliveryState }) => {
      const nextTask = structuredClone(task);
      const nextDeliveryState = deliveryState ? structuredClone(deliveryState) : undefined;
      state.tasks.set(task.taskId, nextTask);
      if (nextDeliveryState) {
        state.deliveryStates.set(task.taskId, nextDeliveryState);
      } else {
        state.deliveryStates.delete(task.taskId);
      }
    },
    deleteTaskWithDeliveryState: (taskId) => {
      state.tasks.delete(taskId);
      state.deliveryStates.delete(taskId);
    },
    upsertDeliveryState: (deliveryState) => {
      state.deliveryStates.set(deliveryState.taskId, structuredClone(deliveryState));
    },
  };
}

export function createInMemoryTaskFlowRegistryStore(
  snapshot: TaskFlowRegistryStoreSnapshot = { flows: new Map() },
): TaskFlowRegistryStore {
  const state = structuredClone(snapshot);
  return {
    loadSnapshot: () => structuredClone(state),
    upsertFlow: (flow) => {
      state.flows.set(flow.flowId, structuredClone(flow));
    },
    updateFlow: (params, preparePublication) => {
      const publish = (result: TaskFlowRegistryObservedUpdate) => {
        const publication = preparePublication(result);
        publication.stage();
        publication.commit();
        publication.publish();
        return result;
      };
      const stored = state.flows.get(params.flowId);
      if (!stored) {
        return publish({ applied: false, reason: "not_found" });
      }
      const current = normalizeRestoredFlowRecord(stored);
      if (current.revision !== params.expectedRevision) {
        return publish({
          applied: false,
          reason: "revision_conflict",
          current: structuredClone(current),
        });
      }
      let flow;
      try {
        flow = applyFlowPatch(current, params.patch);
      } catch (error) {
        return { applied: false, reason: "invalid_patch", error };
      }
      state.flows.set(flow.flowId, structuredClone(flow));
      return publish({ applied: true, previous: structuredClone(current), flow });
    },
    upsertFlowsAtomically: (write) => {
      if (write.ownerCondition) {
        const currentFlows = [...state.flows.values()]
          .filter(
            (flow) =>
              flow.ownerKey === write.ownerCondition?.ownerKey &&
              flow.controllerId === write.ownerCondition.controllerId &&
              write.ownerCondition.statuses.includes(flow.status) &&
              (!write.ownerCondition.excludeCancelRequested ||
                flow.cancelRequestedAt === undefined),
          )
          .toSorted((left, right) => left.flowId.localeCompare(right.flowId));
        const expectedFlows = [...write.ownerCondition.expectedFlows].toSorted((left, right) =>
          left.flowId.localeCompare(right.flowId),
        );
        if (
          currentFlows.length !== expectedFlows.length ||
          currentFlows.some((flow, index) => {
            const expected = expectedFlows[index];
            return (
              !expected ||
              flow.flowId !== expected.flowId ||
              flow.revision !== expected.revision ||
              flow.status !== expected.status
            );
          })
        ) {
          return false;
        }
      }
      for (const change of write.changes) {
        const current = state.flows.get(change.flow.flowId);
        if (
          change.expectedRevision === undefined
            ? current !== undefined
            : current?.revision !== change.expectedRevision
        ) {
          return false;
        }
      }
      for (const change of write.changes) {
        state.flows.set(change.flow.flowId, structuredClone(change.flow));
      }
      return true;
    },
    deleteFlow: (flowId) => {
      state.flows.delete(flowId);
    },
  };
}
