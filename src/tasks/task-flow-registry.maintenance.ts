import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { listTasksForFlowId } from "./runtime-internal.js";
import { isTaskFlowCancellationPending } from "./task-cancellation-state.js";
import { hasUnfulfilledDurableObligation } from "./task-flow-durable-obligation.js";
import {
  resolveTaskFlowMaintenanceAction,
  type TaskFlowMaintenanceAction,
} from "./task-flow-maintenance-policy.js";
import {
  listTaskFlowAuditFindings,
  summarizeTaskFlowAuditFindings,
  type TaskFlowAuditSummary,
} from "./task-flow-registry.audit.js";
import {
  getTaskFlowRegistryRestoreFailure,
  listTaskFlowRecords,
  prepareTaskFlowRegistryRead,
  runTaskFlowRegistryWorkerMutation,
} from "./task-flow-registry.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
// Reconciles stale task-flow records with their child task state.
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  prepareTaskRegistryRead,
  prepareTaskRegistryReadOwner,
  type TaskRegistryRead,
} from "./task-registry-read.js";

/**
 * State key a controller sets to declare that a terminal row still owns an
 * unfulfilled durable obligation and must outlive normal retention.
 *
 * Pruning a terminal row is normally safe because the row is only a record. It
 * is NOT safe when the row is the last durable pointer to work the system still
 * owes someone: continuation's terminal `continue_work` notice keeps its
 * restart backstop here after bounded handoff retries fail. The marker is
 * generic and read structurally so `src/tasks/` stays free of feature imports;
 * the owning controller clears it once the obligation is handed off.
 */
/** Counts task-flow registry maintenance actions without exposing individual records. */
type TaskFlowRegistryMaintenanceSummary = {
  reconciled: number;
  pruned: number;
};

export function assertTaskFlowRegistryMaintenanceReady(): void {
  const restoreFailure = getTaskFlowRegistryRestoreFailure();
  if (restoreFailure) {
    throw new Error(
      `Task-flow registry restore failed: ${restoreFailure}. Refusing task maintenance.`,
    );
  }
}

/**
 * Upstream's policy resolver has no durable-obligation concept, so it will return
 * `prune` for a terminal flow that still owes durable work. Refuse that here, where
 * the action is consumed, and leave the upstream policy module byte-identical.
 */
function resolveGuardedTaskFlowMaintenanceAction(
  flow: TaskFlowRecord,
  now: number,
  hasPendingTasks: () => boolean,
): TaskFlowMaintenanceAction | undefined {
  const action = resolveTaskFlowMaintenanceAction(flow, now, hasPendingTasks);
  if (action?.kind === "prune" && hasUnfulfilledDurableObligation(flow)) {
    return undefined;
  }
  return action;
}

export function getInspectableTaskFlowAuditSummary(): TaskFlowAuditSummary {
  return summarizeTaskFlowAuditFindings(listTaskFlowAuditFindings());
}

export function previewTaskFlowRegistryMaintenance(): TaskFlowRegistryMaintenanceSummary {
  const now = Date.now();
  let reconciled = 0;
  let pruned = 0;
  for (const flow of listTaskFlowRecords()) {
    const action = resolveGuardedTaskFlowMaintenanceAction(flow, now, () =>
      listTasksForFlowId(flow.flowId).some(isTaskFlowCancellationPending),
    );
    if (action?.kind === "prune") {
      pruned += 1;
    } else if (action) {
      reconciled += 1;
    }
  }
  return { reconciled, pruned };
}

export async function runTaskFlowRegistryMaintenance(): Promise<TaskFlowRegistryMaintenanceSummary> {
  const now = Date.now();
  const context = captureOpenClawStateWorkerContext();
  const store = getTaskFlowRegistryStore();
  let taskOwner: Awaited<ReturnType<typeof prepareTaskRegistryReadOwner>> | undefined;
  const assertOwnerCurrent = () => {
    context.admission.assertCurrent();
    taskOwner?.assertCurrent();
    if (getTaskFlowRegistryStore() !== store) {
      throw new Error("Task-flow maintenance owner is no longer current.");
    }
  };
  const prepareFlows = async () => {
    assertOwnerCurrent();
    const read = await prepareTaskFlowRegistryRead(context);
    assertOwnerCurrent();
    return read;
  };
  const initial = await prepareFlows();
  if (!initial) {
    throw new Error("Task-flow registry changed while preparing maintenance.");
  }
  let reconciled = 0;
  let pruned = 0;
  for (const flowId of initial.listTaskFlowIds()) {
    const selectedRead = await prepareFlows();
    if (!selectedRead?.isTaskFlowCurrent(flowId)) {
      continue;
    }
    const selected = selectedRead.getTaskFlowById(flowId);
    const selectedAction =
      selected && resolveGuardedTaskFlowMaintenanceAction(selected, now, () => false);
    if (!selectedAction) {
      continue;
    }
    const attempts = selectedAction.kind === "prune" ? 1 : 2;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let taskRead: TaskRegistryRead | undefined;
      if (selectedAction.kind !== "repair") {
        taskOwner ??= await prepareTaskRegistryReadOwner(context);
        taskRead = await prepareTaskRegistryRead(taskOwner);
        assertOwnerCurrent();
        if (!taskRead) {
          break;
        }
      }
      // Task restoration and accepted publications may have changed the selected flow.
      const read = await prepareFlows();
      if (!read?.isTaskFlowCurrent(flowId)) {
        break;
      }
      const current = read.getTaskFlowById(flowId);
      const action =
        current &&
        resolveGuardedTaskFlowMaintenanceAction(
          current,
          now,
          () => taskRead?.hasPendingTasksForFlow(flowId) ?? true,
        );
      if (!current || !action || action.kind !== selectedAction.kind) {
        break;
      }
      const assertMutationAllowed = () => {
        assertOwnerCurrent();
        read.assertOwnerCurrent();
        if (action.kind !== "repair" && (!taskRead || taskRead.hasPendingTasksForFlow(flowId))) {
          throw new Error("Task-flow maintenance has active or unsettled linked tasks.");
        }
      };
      try {
        const result = await runTaskFlowRegistryWorkerMutation(
          { flowId, admission: context.admission },
          () =>
            runOpenClawStateWorkerOperation(
              context,
              (scope) =>
                scope.execute({
                  type: "flows.maintain",
                  input: { flowId, expectedRevision: current.revision, action: action.kind, now },
                }),
              {
                requireStateLifecycle: true,
                assertCurrent: assertOwnerCurrent,
                createAdmission: createSqliteWorkerWriteAdmission(assertMutationAllowed, [
                  context.admission.databasePath,
                ]),
              },
            ),
          async () => {
            assertOwnerCurrent();
            const flow = await store.readFlowAsync(context, flowId);
            assertOwnerCurrent();
            return flow;
          },
        );
        assertOwnerCurrent();
        if (result === "revision_conflict") {
          continue;
        }
        if (result === "reconciled") {
          reconciled += 1;
        } else if (result === "pruned") {
          pruned += 1;
        }
      } catch {
        // The mutation owner records failures and reconciles publication; uncertain writes never replay.
        assertOwnerCurrent();
      }
      break;
    }
  }
  return { reconciled, pruned };
}
