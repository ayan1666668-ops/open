/** Tests exec-completion steering queue enqueue, leasing, ack/release, and ordering. */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ackLeasedExecSteeringItems,
  enqueueExecSteeringCompletion,
  hasPendingExecSteeringItems,
  leasePendingExecSteeringItems,
  prependExecSteeringPrompt,
  releaseLeasedExecSteeringItems,
  resetExecSteeringQueueForTest,
} from "./exec-steering-queue.js";

const requesterSessionKey = "agent:main:main";

function enqueue(
  overrides: {
    execId?: string;
    status?: string;
    exitLabel?: string;
    text?: string;
    endedAt?: number;
    requesterSessionKey?: string;
  } = {},
): string {
  const itemId = enqueueExecSteeringCompletion({
    requesterSessionKey: overrides.requesterSessionKey ?? requesterSessionKey,
    execId: overrides.execId ?? "abcd1234",
    status: overrides.status ?? "completed",
    exitLabel: overrides.exitLabel ?? "exit 0",
    text: overrides.text ?? "job done",
    endedAt: overrides.endedAt ?? 1_000,
  });
  if (!itemId) {
    throw new Error("expected an enqueued item id");
  }
  return itemId;
}

describe("exec-steering-queue", () => {
  beforeEach(() => {
    resetExecSteeringQueueForTest();
  });

  it("leases a pending completion into a turn prompt", () => {
    enqueue({ text: "compilation finished" });
    expect(hasPendingExecSteeringItems(requesterSessionKey)).toBe(true);

    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased).toBeDefined();
    expect(leased?.itemIds).toHaveLength(1);
    expect(leased?.prompt).toContain("Background exec completions arrived");
    expect(leased?.prompt).toContain("compilation finished");
    // Once leased, it is no longer offered to a concurrent lease.
    expect(
      leasePendingExecSteeringItems({ requesterSessionKey, leaseId: "run-2:exec-steering" }),
    ).toBeUndefined();
  });

  it("returns nothing for an idle session with no completions", () => {
    expect(hasPendingExecSteeringItems(requesterSessionKey)).toBe(false);
    expect(
      leasePendingExecSteeringItems({ requesterSessionKey, leaseId: "run-1:exec-steering" }),
    ).toBeUndefined();
  });

  it("targets completions to the requester session key", () => {
    enqueue({ requesterSessionKey: "agent:main:other", text: "other session" });
    expect(hasPendingExecSteeringItems(requesterSessionKey)).toBe(false);
    expect(
      leasePendingExecSteeringItems({ requesterSessionKey, leaseId: "run-1:exec-steering" }),
    ).toBeUndefined();
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey: "agent:main:other",
      leaseId: "run-1:exec-steering",
    });
    expect(leased?.itemIds).toHaveLength(1);
  });

  it("acks a leased item so it is delivered exactly once", () => {
    enqueue();
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased).toBeDefined();
    const acked = ackLeasedExecSteeringItems({
      itemIds: leased!.itemIds,
      leaseId: "run-1:exec-steering",
    });
    expect(acked).toBe(1);
    // A second ack is a no-op; the item is gone.
    expect(
      ackLeasedExecSteeringItems({ itemIds: leased!.itemIds, leaseId: "run-1:exec-steering" }),
    ).toBe(0);
    expect(hasPendingExecSteeringItems(requesterSessionKey)).toBe(false);
  });

  it("does not ack with a mismatched lease id", () => {
    enqueue();
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(
      ackLeasedExecSteeringItems({ itemIds: leased!.itemIds, leaseId: "run-2:exec-steering" }),
    ).toBe(0);
    // Still leased under the original id, so a fresh lease sees nothing.
    expect(
      leasePendingExecSteeringItems({ requesterSessionKey, leaseId: "run-3:exec-steering" }),
    ).toBeUndefined();
  });

  it("re-queues a released item for the next turn", () => {
    enqueue({ text: "needs retry" });
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased).toBeDefined();
    const released = releaseLeasedExecSteeringItems({
      itemIds: leased!.itemIds,
      leaseId: "run-1:exec-steering",
    });
    expect(released).toBe(1);
    expect(hasPendingExecSteeringItems(requesterSessionKey)).toBe(true);
    const released2 = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-2:exec-steering",
    });
    expect(released2?.itemIds).toEqual(leased!.itemIds);
    expect(released2?.prompt).toContain("needs retry");
  });

  it("steers multiple completions in requester order", () => {
    enqueue({ execId: "first111", text: "first output", endedAt: 1_000 });
    enqueue({ execId: "second22", text: "second output", endedAt: 2_000 });
    enqueue({ execId: "third333", text: "third output", endedAt: 3_000 });
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased?.itemIds).toHaveLength(3);
    const firstIdx = leased!.prompt.indexOf("first output");
    const secondIdx = leased!.prompt.indexOf("second output");
    const thirdIdx = leased!.prompt.indexOf("third output");
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  it("orders identically-timed completions by enqueue sequence", () => {
    enqueue({ execId: "aaa11111", text: "earlier enqueue", endedAt: 5_000 });
    enqueue({ execId: "bbb22222", text: "later enqueue", endedAt: 5_000 });
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased!.prompt.indexOf("earlier enqueue")).toBeLessThan(
      leased!.prompt.indexOf("later enqueue"),
    );
  });

  it("prepends the steering prompt above the current parent turn", () => {
    const merged = prependExecSteeringPrompt({
      steeringPrompt: "STEER",
      prompt: "do the thing",
    });
    expect(merged).toBe("STEER\n\nCurrent parent turn:\n\ndo the thing");
  });

  it("returns only the steering prompt when the parent prompt is blank", () => {
    expect(prependExecSteeringPrompt({ steeringPrompt: "STEER", prompt: "   " })).toBe("STEER");
  });

  it("ignores an empty requester session key", () => {
    expect(
      enqueueExecSteeringCompletion({
        requesterSessionKey: "   ",
        execId: "abcd1234",
        status: "completed",
        exitLabel: "exit 0",
        text: "ignored",
      }),
    ).toBeUndefined();
  });
});
