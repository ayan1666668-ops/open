import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { onSubagentRegistryPersisted } from "../agents/subagents/registry/subagent-registry-state.js";
import {
  onAgentEvent,
  registerAgentEventLifecycleRotationHandler,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { hasResidentTaskBacking, readTaskBackingInstance } from "./task-backing-authority.js";
import { recordTaskActivityEvent } from "./task-registry-activity.js";
import { enqueueTaskAgentEvent, taskAgentEventMutations } from "./task-registry-agent-events.js";
import {
  claimTaskRegistryListenerStart,
  setTaskRegistryListenerStarter,
  setTaskRegistryListenerStop,
} from "./task-registry-listener-state.js";
import {
  reconcileTaskProgressBatches,
  retireTaskProgressForSession,
  scheduleYieldedSubagentTaskProgress,
} from "./task-registry-progress.js";
import { filterTasksByRunScope } from "./task-registry-records.js";
import { getTasksByRunScope, tasks } from "./task-registry-state.js";
import {
  clearTaskProgressBatches,
  getTaskRegistryProcessState,
} from "./task-registry.process-state.js";
import { onTaskRegistryChange } from "./task-registry.store.js";
import { isTerminalTaskStatus, type TaskRecord } from "./task-registry.types.js";

function selectEventTasks(evt: AgentEventPayload): TaskRecord[] {
  const scopedTasks = getTasksByRunScope({ runId: evt.runId, sessionKey: evt.sessionKey });
  const canonicalRunId = subagentRuns.get(evt.runId)?.taskRunId;
  if (canonicalRunId && canonicalRunId !== evt.runId) {
    scopedTasks.push(
      ...getTasksByRunScope({
        runId: canonicalRunId,
        runtime: "subagent",
        sessionKey: evt.sessionKey,
      }).filter((task) => readTaskBackingInstance(task.detail)?.runtime === "subagent"),
    );
  }
  // A committed rebind can precede its projection. Retain that mutation's fixed task id.
  for (const pending of getTaskRegistryProcessState().projection.pending) {
    if (
      pending.scope.runId !== evt.runId ||
      scopedTasks.some((task) => task.taskId === pending.scope.taskId)
    ) {
      continue;
    }
    const current = tasks.get(pending.scope.taskId);
    if (current) {
      scopedTasks.push(
        ...filterTasksByRunScope(
          [
            {
              ...current,
              runId: pending.scope.runId,
              childSessionKey: pending.scope.childSessionKey ?? current.childSessionKey,
            },
          ],
          { sessionKey: evt.sessionKey },
        ),
      );
    }
  }
  return scopedTasks;
}

function ensureListener() {
  if (!claimTaskRegistryListenerStart(taskAgentEventMutations)) {
    return;
  }
  const stop = onAgentEvent((event) => {
    if (event.stream === "lifecycle" && event.data.phase === "start") {
      reconcileTaskProgressBatches();
    }
    for (const task of selectEventTasks(event)) {
      const backing = readTaskBackingInstance(task.detail);
      const subagent = subagentRuns.get(event.runId);
      if (
        isTerminalTaskStatus(task.status) ||
        !hasResidentTaskBacking(task) ||
        (task.runtime === "subagent" &&
          backing?.runtime === "subagent" &&
          (subagent?.generation !== backing.generation ||
            subagent?.childSessionKey !== task.childSessionKey))
      ) {
        continue;
      }
      if (enqueueTaskAgentEvent(task, event)) {
        const prepared = recordTaskActivityEvent(task, event);
        scheduleYieldedSubagentTaskProgress(task, event, prepared);
      }
    }
  });
  const stopTasks = onTaskRegistryChange(reconcileTaskProgressBatches);
  const stopRuns = onSubagentRegistryPersisted(() => reconcileTaskProgressBatches());
  const stopIdentity = onSessionIdentityMutation(retireTaskProgressForSession);
  setTaskRegistryListenerStop(() => {
    stop();
    stopTasks();
    stopRuns();
    stopIdentity();
  });
  // Initial task restoration can publish before these listeners attach.
  reconcileTaskProgressBatches({ kind: "restored" });
}

setTaskRegistryListenerStarter(ensureListener);
registerAgentEventLifecycleRotationHandler("tasks:progress", clearTaskProgressBatches);
