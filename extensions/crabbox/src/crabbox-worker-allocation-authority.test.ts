import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { operationLeaseId } from "./crabbox-worker-profile.js";
import {
  CHECKPOINT_ID,
  LEASE_ID,
  PROFILE,
  captureWarmImage,
  checkpointResult,
  commandResult,
  createWarmProvider,
  openWarmImageStore,
  provisionWarmProfile,
} from "./crabbox-worker-warm-image.test-support.js";

describe("Crabbox allocation source authority", () => {
  it.each([false, true])(
    "does not allocate after source closure during checkpoint selection (failure=%s)",
    async (failure) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const physical = new AbortController();
      const closed = new Error("allocation source closed");
      let selecting = false;
      let current = true;
      const { provider, calls } = createWarmProvider(async ({ argv }) => {
        if (selecting && argv[1] === "checkpoint" && argv[2] === "inspect") {
          entered.resolve();
          await release.promise;
          return failure
            ? commandResult({ code: 1, stderr: "checkpoint temporarily unavailable" })
            : checkpointResult(CHECKPOINT_ID, LEASE_ID, "available");
        }
        return undefined;
      });
      await captureWarmImage(provider);
      const store = openWarmImageStore();
      const [entry] = store.entries();
      if (!entry?.value.image) {
        throw new Error("missing captured image");
      }
      store.update(entry.key, (record) => {
        if (!record?.image) {
          throw new Error("missing image owner");
        }
        return { ...record, image: { ...record.image, state: "pending" } };
      });
      calls.length = 0;
      selecting = true;
      const operationId = "revoked-checkpoint-selection";
      const pending = provisionWarmProfile(provider, PROFILE, operationId, undefined, {
        signal: physical.signal,
        assertCurrent: () => {
          if (!current) {
            throw closed;
          }
        },
      }).then(
        (lease) => ({ lease }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("selection did not wait");
          }),
        ]);
        current = false;
      } finally {
        release.resolve();
      }
      expect(await pending).toEqual({ error: closed });
      expect(physical.signal.aborted).toBe(false);
      expect(
        calls.some(
          ({ argv }) => argv[1] === "warmup" || (argv[1] === "checkpoint" && argv[2] === "fork"),
        ),
      ).toBe(false);
      expect(store.lookup(entry.key)?.allocations[operationLeaseId(operationId)]).toBeUndefined();
      expect(store.lookup(entry.key)?.image?.checkpointId).toBe(CHECKPOINT_ID);
    },
  );
});
