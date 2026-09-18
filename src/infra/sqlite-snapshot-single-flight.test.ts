import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { prepareSingleFlightSqliteSnapshot } from "./sqlite-snapshot-single-flight.js";

it("tracks the producer after a caller cancels its wait", async () => {
  const produced = createDeferred();
  const tracked: Promise<unknown>[] = [];
  const controller = new AbortController();
  const pending = prepareSingleFlightSqliteSnapshot(
    "producer-drain.sqlite",
    "test",
    async () => {
      await produced.promise;
      return {
        location: "snapshot.sqlite",
        cleanup: () => true,
        cleanupAsync: async () => true,
      };
    },
    controller.signal,
    { trackProducer: (producer) => tracked.push(producer) },
  );

  controller.abort(new Error("caller stopped waiting"));
  await expect(pending).rejects.toThrow("caller stopped waiting");
  expect(tracked).toHaveLength(1);
  let producerSettled = false;
  void tracked[0]?.then(() => {
    producerSettled = true;
  });
  await Promise.resolve();
  expect(producerSettled).toBe(false);
  produced.resolve();
  await expect(tracked[0]).resolves.toMatchObject({ location: "snapshot.sqlite" });
});
