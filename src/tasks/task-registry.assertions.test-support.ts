import { expect } from "vitest";
import { findTaskByRunId, getTaskById } from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";

export function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

export function requireTaskByRunId(runId: string): TaskRecord {
  const task = findTaskByRunId(runId);
  if (!task) {
    throw new Error(`Expected task for run ${runId}`);
  }
  return task;
}

export function requireTaskById(taskId: string): TaskRecord {
  const task = getTaskById(taskId);
  if (!task) {
    throw new Error(`Expected task ${taskId}`);
  }
  return task;
}

export function firstMockArg(
  mock: { mock: { calls: readonly unknown[][] } },
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`Expected ${label} call`);
  }
  return expectRecordFields(call[0], {});
}
