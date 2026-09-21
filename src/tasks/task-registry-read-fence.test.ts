import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import * as taskRuntime from "./runtime-internal.js";
import { updateTask } from "./task-registry-mutation.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import {
  createReadTask,
  requestTasks,
  resetReadState,
  withReadState,
} from "./task-registry-read.test-support.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import { createTaskFixture } from "./task-registry.test-support.js";

afterEach(resetReadState);

describe("registered task list read fence", () => {
  it("retries a changed page without joining events accepted after its first read", async () => {
    await withReadState(async () => {
      const task = createReadTask("read-before-page-retry");
      const later = createTaskFixture("cli", {
        runId: "accepted-after-page-selection",
        ownerKey: "agent:main:later-event",
        requesterSessionKey: "agent:main:later-event",
        task: "Unrelated later work",
        status: "running",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      });
      const entered = createDeferred();
      const release = createDeferred();
      const store = getTaskRegistryStore();
      const mutate = store.runAgentEventMutationAsync.bind(store);
      vi.spyOn(store, "runAgentEventMutationAsync").mockImplementation(async (...args) => {
        if (args[1].taskId === later.taskId) {
          entered.resolve();
          await release.promise;
        }
        return mutate(...args);
      });
      const select = taskRuntime.listTaskRecordPage;
      let changed = false;
      vi.spyOn(taskRuntime, "listTaskRecordPage").mockImplementation(async (params) => {
        const page = await select(params);
        if (!changed && page.ok) {
          changed = true;
          expect(page.value.tasks).toMatchObject([{ taskId: task.taskId, toolUseCount: 1 }]);
          expect(updateTask(task.taskId, { task: "Changed before response" })).not.toBeNull();
          emitAgentEvent({
            runId: later.runId!,
            stream: "tool",
            data: { phase: "start", name: "later-tool" },
          });
          await withTestTimeout(entered.promise, 5_000, "Later event did not reach its barrier");
        }
        return page;
      });
      emitAgentEvent({
        runId: task.runId!,
        stream: "tool",
        data: { phase: "start", name: "accepted-before-read" },
      });
      const read = requestTasks(task.ownerKey);
      try {
        await withTestTimeout(
          Promise.race([
            entered.promise,
            read.then(() => {
              throw new Error("Task request settled before the later-event barrier");
            }),
          ]),
          5_000,
          "Later event did not reach its barrier",
        );
        const response = await withTestTimeout(read, 5_000, "Page retry joined a later event");
        expect(changed).toBe(true);
        expect(response.mock.calls[0]).toMatchObject([
          true,
          { tasks: [{ id: task.taskId, title: "Changed before response", toolUseCount: 1 }] },
        ]);
      } finally {
        release.resolve();
        await read;
        await prepareTaskRegistryRead();
      }
      expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(later.taskId)).toMatchObject({
        toolUseCount: 1,
        lastToolName: "later-tool",
      });
    });
  });
});
