import { afterEach, describe, expect, it } from "vitest";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

describe("channel ingress drain async work ownership", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  // Webhook spools run the pump through runDetachedWebhookWork, whose async work scope
  // drains as soon as the pump returns. drainOnce does not wait for the dispatches it
  // starts, so they must stay tracked by that scope until they settle.
  it("keeps a started dispatch tracked by the scope drainOnce ran in", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("evt-scope", { text: "hello" }, { laneKey: "lane-a" });
      let releaseDispatch = () => {};
      const dispatchGate = new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });
      let tracked: "tracked" | Error | undefined;
      const drain = createChannelIngressDrain<Payload>({
        queue,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          await dispatchGate;
          // An agent turn's first steps go through the ambient work tracker.
          tracked = await trackAsyncWork(async () => "tracked" as const).catch(
            (error: unknown) => error as Error,
          );
          await lifecycle.onAdopted();
        },
      });

      const pump = new AsyncWorkScope();
      const { started } = await pump.track(() => drain.drainOnce());
      const pumpDrained = pump.drain();
      releaseDispatch();
      await pumpDrained;
      await drain.waitForIdle();

      expect(started).toBe(1);
      expect(tracked).toBe("tracked");
      drain.dispose();
    });
  });
});
