import { WORKBOARD_STATUSES } from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import { isDependencyPromotableStatus } from "./store-card-helpers.js";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

function createStore() {
  return createWorkboardSqliteTestStore({ createStores: createKernelStores });
}

describe("Workboard blocked parent claims", () => {
  it("keeps blocked outside automatic dependency promotion", () => {
    expect(WORKBOARD_STATUSES.filter((status) => isDependencyPromotableStatus(status))).toEqual([
      "triage",
      "backlog",
      "todo",
      "scheduled",
      "ready",
    ]);
  });

  it("claims a blocked child after all parents are done", async () => {
    const store = createStore();
    const parent = await store.create({ title: "Parent", status: "done" });
    const child = await store.create({ title: "Child", parents: [parent.id] });
    const first = await store.claim(child.id, { ownerId: "main", token: "token-1" });
    await store.block(child.id, {
      ownerId: "main",
      token: first.token,
      reason: "Needs owner decision.",
    });

    const claimed = await store.claim(child.id, { ownerId: "main", token: "token-2" });

    expect(claimed.card.status).toBe("running");
    expect(claimed.card.metadata?.claim).toMatchObject({ ownerId: "main", token: "token-2" });
  });

  it("claims a blocked card with no parent while leaving it blocked", async () => {
    const store = createStore();
    const card = await store.create({ title: "Standalone" });
    const first = await store.claim(card.id, { ownerId: "main", token: "token-1" });
    await store.block(card.id, {
      ownerId: "main",
      token: first.token,
      reason: "Needs owner decision.",
    });

    const claimed = await store.claim(card.id, { ownerId: "main", token: "token-2" });

    expect(claimed.card.status).toBe("blocked");
    expect(claimed.card.metadata?.claim).toMatchObject({ ownerId: "main", token: "token-2" });
  });

  it("still rejects a blocked child whose parents are not done", async () => {
    const store = createStore();
    const parent = await store.create({ title: "Open parent", status: "running" });
    const child = await store.create({ title: "Child", parents: [parent.id] });
    await store.move(child.id, "blocked", child.position);

    await expect(store.claim(child.id, { ownerId: "main" })).rejects.toThrow(
      "card dependencies are not done.",
    );
    expect((await store.get(child.id))?.status).toBe("blocked");

    await expect(store.prepareStart(child.id)).resolves.toMatchObject({
      id: child.id,
      status: "blocked",
    });
    await store.dispatch();
    expect((await store.get(child.id))?.status).toBe("blocked");
  });

  it("does not promote a blocked child when parents are done", async () => {
    const store = createStore();
    const parent = await store.create({ title: "Parent", status: "done" });
    const child = await store.create({ title: "Child", parents: [parent.id] });
    const first = await store.claim(child.id, { ownerId: "main", token: "token-1" });
    await store.block(child.id, {
      ownerId: "main",
      token: first.token,
      reason: "Needs owner decision.",
    });

    await expect(store.prepareStart(child.id)).resolves.toMatchObject({
      id: child.id,
      status: "blocked",
    });
    const dispatched = await store.dispatch();
    expect(dispatched.promoted.some((card) => card.id === child.id)).toBe(false);
    expect(dispatched.blocked.some((card) => card.id === child.id)).toBe(false);
    expect((await store.get(child.id))?.status).toBe("blocked");

    const claimed = await store.claim(child.id, { ownerId: "main", token: "token-2" });
    expect(claimed.card.status).toBe("running");
  });

  it("keeps a blocked child blocked when created or linked to completed parents", async () => {
    const store = createStore();
    const parent = await store.create({ title: "Parent", status: "done" });
    const created = await store.create({
      title: "Created blocked",
      status: "blocked",
      parents: [parent.id],
    });
    expect(created.status).toBe("blocked");
    expect(
      created.metadata?.links?.some(
        (link) => link.type === "parent" && link.targetCardId === parent.id,
      ),
    ).toBe(true);

    const linked = await store.create({ title: "Linked blocked", status: "blocked" });
    const afterLink = await store.linkCards(parent.id, linked.id);
    expect(afterLink.status).toBe("blocked");
    expect(
      afterLink.metadata?.links?.some(
        (link) => link.type === "parent" && link.targetCardId === parent.id,
      ),
    ).toBe(true);

    await store.dispatch();
    await expect(store.prepareStart(created.id)).resolves.toMatchObject({ status: "blocked" });
    await expect(store.prepareStart(linked.id)).resolves.toMatchObject({ status: "blocked" });
    expect((await store.get(created.id))?.status).toBe("blocked");
    expect((await store.get(linked.id))?.status).toBe("blocked");
  });

  it("unblocks a held child and then promotes it once parents are done", async () => {
    const store = createStore();
    const parent = await store.create({ title: "Parent", status: "done" });
    const child = await store.create({
      title: "Held child",
      status: "blocked",
      parents: [parent.id],
    });

    const unblocked = await store.unblock(child.id);
    expect(unblocked.status).toBe("todo");
    await expect(store.prepareStart(child.id)).resolves.toMatchObject({
      id: child.id,
      status: "ready",
    });
  });

  it("keeps a future-scheduled blocked child blocked when parents are done", async () => {
    const store = createStore();
    const parent = await store.create({ title: "Parent", status: "done" });
    const child = await store.create({
      title: "Blocked later",
      status: "blocked",
      scheduledAt: Date.now() + 60_000,
      parents: [parent.id],
    });

    expect(child.status).toBe("blocked");
    await store.dispatch();
    await expect(store.prepareStart(child.id)).resolves.toMatchObject({ status: "blocked" });
    const claimed = await store.claim(child.id, { ownerId: "main", token: "token-1" });
    expect(claimed.card.status).toBe("blocked");
    expect(claimed.card.metadata?.claim).toMatchObject({ ownerId: "main", token: "token-1" });
    expect(claimed.card.metadata?.automation?.scheduledAt).toBeGreaterThan(Date.now());
  });

  it("keeps a blocked card with a future schedule blocked and claimable", async () => {
    const store = createStore();
    const card = await store.create({
      title: "Blocked later",
      status: "blocked",
      scheduledAt: Date.now() + 60_000,
    });

    expect(card.status).toBe("blocked");
    await store.dispatch();
    expect((await store.get(card.id))?.status).toBe("blocked");

    const claimed = await store.claim(card.id, { ownerId: "main", token: "token-1" });

    expect(claimed.card.status).toBe("blocked");
    expect(claimed.card.metadata?.claim).toMatchObject({ ownerId: "main", token: "token-1" });
    expect(claimed.card.metadata?.automation?.scheduledAt).toBeGreaterThan(Date.now());
  });

  it("does not re-block an already blocked exhausted card on dispatch", async () => {
    const store = createStore();
    const card = await store.create({
      title: "Exhausted blocked",
      status: "blocked",
      maxRetries: 1,
      metadata: { failureCount: 2 },
    });

    const first = await store.dispatch();
    const second = await store.dispatch();
    const latest = await store.get(card.id);

    expect(first.blocked).toEqual([]);
    expect(second.blocked).toEqual([]);
    expect(latest).toMatchObject({ status: "blocked" });
    expect(latest?.metadata?.notifications ?? []).toEqual([]);
  });
});
