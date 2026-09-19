import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { captureTaskRegistryReadFence } from "./task-registry-listener-state.js";
import { cloneTaskRecord, selectTaskRecordsForOwnerTree } from "./task-registry-records.js";
import {
  assertTaskRegistryOwnerCurrent,
  ensureTaskRegistryReadyAsync,
  prepareTaskRegistryProjectionAsync,
  tasks,
  taskIdsByOwnerKey,
} from "./task-registry-state.js";
import { getTaskRegistryProcessState, matchesScope } from "./task-registry.process-state.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import type { TaskRegistryMutationScope } from "./task-registry.store.types.js";
import type { TaskRecord } from "./task-registry.types.js";

export type TaskRegistryRead = {
  assertCurrent: () => void;
  isTaskCurrent: (taskId: string) => boolean;
  getTaskById: (taskId: string) => TaskRecord | undefined;
  listTaskRecordsForOwnerTree: (rootOwnerKeys: ReadonlySet<string>) => TaskRecord[];
};

function isTaskRegistryReadIdentityCurrent(taskId: string): boolean {
  const { projection } = getTaskRegistryProcessState();
  if (projection.pending.size === 0 && projection.dirtyScopes.size === 0) {
    return true;
  }
  const task = tasks.get(taskId);
  const preserved = new Set<TaskRegistryMutationScope>();
  for (const pending of projection.pending) {
    if (pending.readIdentity === "preserved") {
      preserved.add(pending.scope);
    } else if (
      pending.scope.taskId === taskId ||
      pending.published.has(taskId) ||
      pending.publication?.records.has(taskId) ||
      (task && matchesScope(task, pending.scope))
    ) {
      return false;
    }
  }
  // Failed publication can leave a dirty scope after its mutation owner retires.
  for (const scope of projection.dirtyScopes) {
    if (!preserved.has(scope) && (scope.taskId === taskId || (task && matchesScope(task, scope)))) {
      return false;
    }
  }
  return true;
}

/** External readers join a fixed accepted prefix; persistence preparation must never use this fence. */
export async function prepareTaskRegistryRead(): Promise<TaskRegistryRead | undefined> {
  const context = captureOpenClawStateWorkerContext();
  const store = getTaskRegistryStore();
  const fence = captureTaskRegistryReadFence(context.admission);
  const settled = await Promise.allSettled([ensureTaskRegistryReadyAsync(context), fence]);
  const errors = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw createSqliteLifecycleAggregateError(errors, "Task read preparation failed", errors[0]);
  }
  assertTaskRegistryOwnerCurrent(context, store);
  if (!(await prepareTaskRegistryProjectionAsync(context, store, 3))) {
    return undefined;
  }
  const assertCurrent = () => {
    assertTaskRegistryOwnerCurrent(context, store);
    if (getTaskRegistryProcessState().projection.dirty) {
      throw new Error("Task registry read projection is no longer ready");
    }
  };
  assertCurrent();
  const isTaskCurrent = (taskId: string) => {
    assertCurrent();
    return isTaskRegistryReadIdentityCurrent(taskId.trim());
  };
  return {
    assertCurrent,
    isTaskCurrent,
    getTaskById(taskId) {
      if (!isTaskCurrent(taskId)) {
        throw new Error("Task registry read identity requires preparation");
      }
      const task = tasks.get(taskId.trim());
      return task ? cloneTaskRecord(task) : undefined;
    },
    listTaskRecordsForOwnerTree(rootOwnerKeys) {
      assertCurrent();
      const selected = selectTaskRecordsForOwnerTree(tasks, taskIdsByOwnerKey, rootOwnerKeys);
      return selected.map((task) => {
        if (!isTaskCurrent(task.taskId)) {
          throw new Error("Task registry read identity requires preparation");
        }
        return cloneTaskRecord(task);
      });
    },
  };
}
