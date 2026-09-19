/** Tests exec-completion steering queue enqueue, leasing, ack/release, ownership, and shared occurrence. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  enqueueSystemEventEntry,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import {
  ackLeasedExecSteeringItems,
  enqueueExecSteeringCompletion,
  hasPendingExecSteeringItems,
  invalidateExecSteeringByOccurrence,
  leasePendingExecSteeringItems,
  prependExecSteeringPrompt,
  releaseLeasedExecSteeringItems,
  resetExecSteeringQueueForTest,
  retireExecSteeringForSessionKeys,
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
    ownerAgentId?: string;
    occurrenceKey?: string;
  } = {},
): string {
  const itemId = enqueueExecSteeringCompletion({
    requesterSessionKey: overrides.requesterSessionKey ?? requesterSessionKey,
    ...(overrides.ownerAgentId ? { ownerAgentId: overrides.ownerAgentId } : {}),
    occurrenceKey: overrides.occurrenceKey ?? `exec:${overrides.execId ?? "abcd1234"}`,
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
  afterEach(() => {
    resetSystemEventsForTest();
  });

  it("leases a pending completion into a turn prompt", () => {
    enqueue({ text: "compilation finished" });
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(true);

    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased).toBeDefined();
    expect(leased?.itemIds).toHaveLength(1);
    expect(leased?.prompt).toContain("Background exec completions arrived");
    expect(leased?.prompt).toContain("compilation finished");
    expect(leased?.isCurrent()).toBe(true);
    // Once leased, it is no longer offered to a concurrent lease.
    expect(
      leasePendingExecSteeringItems({ requesterSessionKey, leaseId: "run-2:exec-steering" }),
    ).toBeUndefined();
  });

  it("returns nothing for an idle session with no completions", () => {
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
    expect(
      leasePendingExecSteeringItems({ requesterSessionKey, leaseId: "run-1:exec-steering" }),
    ).toBeUndefined();
  });

  it("targets completions to the requester session key", () => {
    enqueue({ requesterSessionKey: "agent:main:other", text: "other session" });
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
    expect(
      leasePendingExecSteeringItems({ requesterSessionKey, leaseId: "run-1:exec-steering" }),
    ).toBeUndefined();
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey: "agent:main:other",
      leaseId: "run-1:exec-steering",
    });
    expect(leased?.itemIds).toHaveLength(1);
  });

  it("cannot leak one agent's global completion to another agent (cross-agent isolation)", () => {
    // Two agents both use the literal session key "global". The completion is
    // owned by the research agent; the main agent must never lease it.
    enqueue({
      requesterSessionKey: "global",
      ownerAgentId: "research",
      execId: "research1",
      text: "research secret output",
    });
    // The main agent, sharing the literal "global" key, resolves a distinct
    // agent-qualified queue key and sees nothing.
    expect(
      hasPendingExecSteeringItems({ requesterSessionKey: "global", ownerAgentId: "main" }),
    ).toBe(false);
    expect(
      leasePendingExecSteeringItems({
        requesterSessionKey: "global",
        ownerAgentId: "main",
        leaseId: "run-main:exec-steering",
      }),
    ).toBeUndefined();
    // The owning research agent leases its own output.
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey: "global",
      ownerAgentId: "research",
      leaseId: "run-research:exec-steering",
    });
    expect(leased?.itemIds).toHaveLength(1);
    expect(leased?.prompt).toContain("research secret output");
  });

  it("refuses an owner that contradicts the session key instead of using an unqualified key", () => {
    // Pairing agent:main:main with the research owner cannot be qualified, so
    // the completion is dropped rather than stored under a shared literal key.
    expect(
      enqueueExecSteeringCompletion({
        requesterSessionKey: "agent:main:main",
        ownerAgentId: "research",
        occurrenceKey: "exec:conflict1",
        execId: "conflict1",
        status: "completed",
        exitLabel: "exit 0",
        text: "unqualifiable",
      }),
    ).toBeUndefined();
    expect(
      hasPendingExecSteeringItems({ requesterSessionKey: "agent:main:main", ownerAgentId: "main" }),
    ).toBe(false);
  });

  it("preserves another agent's completions during an agent-scoped reset", () => {
    enqueue({
      requesterSessionKey: "global",
      ownerAgentId: "research",
      occurrenceKey: "exec:keep0001",
      execId: "keep0001",
      text: "research work",
    });

    expect(
      retireExecSteeringForSessionKeys({
        requesterSessionKeys: ["agent:research:global"],
        ownerAgentId: "main",
      }),
    ).toBe(0);
    expect(
      hasPendingExecSteeringItems({ requesterSessionKey: "global", ownerAgentId: "research" }),
    ).toBe(true);
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
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
  });

  it("acking a steered turn retires the shared durable system event (steering -> heartbeat)", () => {
    const queueKey = "agent:main:main";
    // The durable system event the notify path enqueues for this occurrence.
    enqueueSystemEventEntry("Exec completed (abcd1234, exit 0) :: job done", {
      sessionKey: queueKey,
      contextKey: "exec:abcd1234",
    });
    expect(peekSystemEventEntries(queueKey)).toHaveLength(1);

    enqueue({ occurrenceKey: "exec:abcd1234", execId: "abcd1234" });
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    ackLeasedExecSteeringItems({ itemIds: leased!.itemIds, leaseId: "run-1:exec-steering" });

    // A later heartbeat must find nothing to deliver: exactly-once across paths.
    expect(peekSystemEventEntries(queueKey)).toEqual([]);
  });

  it("invalidating an acknowledged occurrence removes its steering copy (poll/heartbeat -> steering)", () => {
    enqueue({ occurrenceKey: "exec:zzz99999", execId: "zzz99999", text: "polled output" });
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(true);
    // A terminal poll or heartbeat consumed this occurrence's durable event.
    expect(invalidateExecSteeringByOccurrence("exec:zzz99999")).toBe(1);
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
  });

  it("invalidates an already-leased copy before dispatch when its occurrence is acknowledged", () => {
    enqueue({ occurrenceKey: "exec:leased01", execId: "leased01" });
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased?.isCurrent()).toBe(true);
    // Concurrent terminal poll acknowledges the occurrence between lease and dispatch.
    expect(invalidateExecSteeringByOccurrence("exec:leased01")).toBe(1);
    // The pre-dispatch guard now rejects the stale leased copy.
    expect(leased?.isCurrent()).toBe(false);
  });

  it("retires queued completions when their conversation is reset", () => {
    enqueue({ occurrenceKey: "exec:reset001", execId: "reset001", text: "stale after reset" });
    // Leased but not yet acknowledged when the reset happens.
    const leased = leasePendingExecSteeringItems({
      requesterSessionKey,
      leaseId: "run-1:exec-steering",
    });
    expect(leased).toBeDefined();
    const removed = retireExecSteeringForSessionKeys({
      requesterSessionKeys: [requesterSessionKey],
      ownerAgentId: "main",
    });
    expect(removed).toBe(1);
    // The reset conversation's next turn leases nothing stale.
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(false);
    expect(
      leasePendingExecSteeringItems({ requesterSessionKey, leaseId: "run-2:exec-steering" }),
    ).toBeUndefined();
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
    expect(hasPendingExecSteeringItems({ requesterSessionKey })).toBe(true);
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
        occurrenceKey: "exec:abcd1234",
        execId: "abcd1234",
        status: "completed",
        exitLabel: "exit 0",
        text: "ignored",
      }),
    ).toBeUndefined();
  });

  it("ignores an empty occurrence key", () => {
    expect(
      enqueueExecSteeringCompletion({
        requesterSessionKey,
        occurrenceKey: "   ",
        execId: "abcd1234",
        status: "completed",
        exitLabel: "exit 0",
        text: "ignored",
      }),
    ).toBeUndefined();
  });
});
