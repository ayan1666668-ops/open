import { afterEach, describe, expect, it } from "vitest";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

type Tracked = "turn" | "followup" | Error;

function track(value: "turn" | "followup"): Promise<Tracked> {
  return trackAsyncWork(async () => value).catch((error: unknown) => error as Error);
}

describe("channel ingress drain async work ownership", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  // Webhook spools run the pump through runDetachedWebhookWork, whose async work scope
  // closes as soon as the pump returns. drainOnce does not wait for the dispatches it
  // starts, and a turn can leave a queued followup that starts after the turn settles.
  it("lets a dispatch and the followup it leaves track work after the pump's scope closes", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("evt-scope", { text: "hello" }, { laneKey: "lane-a" });
      let releaseTurn = () => {};
      const turnGate = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      let releaseFollowup = () => {};
      const followupGate = new Promise<void>((resolve) => {
        releaseFollowup = resolve;
      });
      let turn: Tracked | undefined;
      let followup: Promise<Tracked> | undefined;
      const drain = createChannelIngressDrain<Payload>({
        queue,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          await turnGate;
          turn = await track("turn");
          followup = followupGate.then(() => track("followup"));
          await lifecycle.onAdopted();
        },
      });

      const pump = new AsyncWorkScope();
      const { started } = await pump.track(() => drain.drainOnce());
      await pump.drain();
      releaseTurn();
      await drain.waitForIdle();
      releaseFollowup();

      expect(started).toBe(1);
      expect(turn).toBe("turn");
      await expect(followup).resolves.toBe("followup");
      drain.dispose();
    });
  });
});
