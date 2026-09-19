import { beforeEach, describe, it, vi } from "vitest";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { expectPublishedOwnerRecoveryAfterGenerationMismatch } from "./prepared-model-catalog-worker.generation-recovery.test-support.js";
import { createStaticCatalogSnapshotFixture } from "./test-helpers/prepared-model-catalog-static-fixture.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();
const createStaticSnapshot = createStaticCatalogSnapshotFixture({ makeTempDir, retireAfterTest });

describe("prepared model catalog generation recovery", () => {
  beforeEach(() => {
    vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-worker-empty-codex-"));
  });

  it("isolates a failed owner from a healthy shared-pool waiter", async () => {
    const fixture = await createStaticSnapshot(0);
    const run = WorkerTaskPool.prototype.run;
    let injectMismatch = false;
    const runSpy = vi
      .spyOn(WorkerTaskPool.prototype, "run")
      .mockImplementation(function (input, options) {
        if (typeof input !== "function") {
          return run.call(this, input, options);
        }
        return run.call(
          this,
          async () => {
            const task = await input();
            if (
              !injectMismatch ||
              typeof task !== "object" ||
              task === null ||
              !("value" in task) ||
              !("request" in task) ||
              typeof task.request !== "object" ||
              task.request === null ||
              !("kind" in task.request) ||
              task.request.kind !== "catalog"
            ) {
              return task;
            }
            injectMismatch = false;
            return {
              ...task,
              value: {
                ...task.value,
                generationFingerprint: "configured-owner-generation-drifted",
              },
            };
          },
          options,
        );
      });
    try {
      await expectPublishedOwnerRecoveryAfterGenerationMismatch(fixture, () => {
        injectMismatch = true;
      });
    } finally {
      runSpy.mockRestore();
    }
  });
});
