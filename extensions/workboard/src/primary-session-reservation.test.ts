import { DatabaseSync } from "node:sqlite";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

const workerModuleUrl = resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint);

describe("primary session reservations through the SQLite worker", () => {
  it("keeps execution session links separate from edited primary links", async () => {
    const store = createWorkboardSqliteTestHarness().store;
    const card = await store.create({
      title: "Relink me",
      sessionKey: "agent:main:dashboard:1",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        sessionKey: "agent:main:dashboard:1",
        startedAt: 10,
        updatedAt: 10,
      },
    });

    const relinked = await store.update(card.id, { sessionKey: "agent:main:dashboard:2" });
    expect(relinked.sessionKey).toBe("agent:main:dashboard:2");
    expect(relinked.execution).toEqual(card.execution);
    expect(relinked.events?.at(-1)).toMatchObject({
      kind: "linked",
      sessionKey: "agent:main:dashboard:2",
    });

    const unlinked = await store.update(card.id, { sessionKey: "" });
    expect(unlinked.sessionKey).toBeUndefined();
    expect(unlinked.execution).toEqual(card.execution);

    const cleared = await store.update(card.id, { execution: null });
    expect(cleared.execution).toBeUndefined();
  });

  it("permits only one different-card reservation across independent connections", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    const otherSqlite = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
    const other = new WorkboardStore(otherSqlite.cards, otherSqlite);
    try {
      const left = await store.create({ title: "Left" });
      const right = await other.create({ title: "Right" });
      const results = await Promise.allSettled([
        store.update(left.id, { sessionKey: "agent:main:chat:reserved" }),
        other.update(right.id, { sessionKey: "agent:main:chat:reserved" }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        reason: { message: expect.stringContaining("already reserved by card") },
      });
      expect((await store.list()).filter((card) => card.sessionKey)).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  it.each(["blocked", "done"] as const)(
    "captures the active reservation instead of a newer %s card",
    async (status) => {
      const { store } = createWorkboardSqliteTestHarness();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      try {
        const active = await store.create({ title: "Active", sessionKey: "shared" });
        clock.mockReturnValue(2000);
        await store.create({ title: "Newer terminal", status, sessionKey: "shared" });
        await expect(
          store.captureSession({ sessionKey: "shared", title: "Captured" }),
        ).resolves.toEqual(active);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each(["primary", "execution"] as const)(
    "claims legacy agentless %s identity from its qualified current session",
    async (binding) => {
      const { store } = createWorkboardSqliteTestHarness();
      const legacy = "subagent:workboard-legacy";
      const qualified = `agent:main:${legacy}`;
      const card = await store.create({
        title: "Legacy worker",
        status: "ready",
        sessionKey: binding === "primary" ? legacy : "operator-chat",
        execution: { sessionKey: binding === "execution" ? legacy : "agent:main:distinct-worker" },
      });
      await expect(
        store.claim(card.id, { ownerId: "worker" }, { callerSessionKey: "unrelated-chat" }),
      ).rejects.toThrow("card is bound to session");
      expect(await store.get(card.id)).toEqual(card);
      const claimed = await store.claim(
        card.id,
        { ownerId: "worker" },
        { callerSessionKey: qualified },
      );
      expect(claimed.card.sessionKey).toBe(card.sessionKey);
      expect(claimed.card.execution).toEqual(card.execution);
      expect(claimed.card.metadata?.claim?.ownerId).toBe("worker");
      const scope = { ownerId: "worker", token: claimed.token, sessionKey: qualified };
      const heartbeat = await store.heartbeat(card.id, scope);
      expect(heartbeat.metadata?.claim?.ownerId).toBe("worker");
      const completed = await store.complete(card.id, { ...scope, summary: "Done" });
      expect(completed.status).toBe("done");
      expect(completed.sessionKey).toBe(card.sessionKey);
    },
  );

  it("keeps primary edits independent of a running execution", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    const card = await store.create({
      title: "Worker",
      execution: {
        id: "execution",
        status: "running",
        sessionKey: "agent:main:worker:one",
        updatedAt: 1,
      },
    });
    const rebound = await store.update(card.id, { sessionKey: "agent:main:chat:operator" });
    expect(rebound.execution).toEqual(card.execution);
    const detached = await store.update(card.id, { sessionKey: "" });
    expect(detached.sessionKey).toBeUndefined();
    expect(detached.execution).toEqual(card.execution);
  });

  it("keeps execution authority and explicit detach through claim, heartbeat and completion", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    const card = await store.create({
      title: "Detached worker authority",
      status: "ready",
      sessionKey: "operator",
      execution: { sessionKey: "worker" },
    });
    const detached = await store.bindSession(card.id, { action: "detach" });
    await expect(
      store.claim(card.id, { ownerId: "owner" }, { callerSessionKey: "foreign" }),
    ).rejects.toThrow("bound to session");
    expect(await store.get(card.id)).toEqual(detached);
    const claimed = await store.claim(
      card.id,
      { ownerId: "owner" },
      { callerSessionKey: "worker" },
    );
    expect(claimed.card.sessionKey).toBeUndefined();
    expect(claimed.card.primarySessionDetached).toBe(true);
    await expect(
      store.heartbeat(card.id, { ownerId: "owner", token: claimed.token, sessionKey: "foreign" }),
    ).rejects.toThrow("bound to session");
    expect(await store.get(card.id)).toEqual(claimed.card);
    const scope = { ownerId: "owner", token: claimed.token, sessionKey: "worker" };
    await store.heartbeat(card.id, scope);
    const completed = await store.complete(card.id, { ...scope, summary: "Done" });
    expect(completed.sessionKey).toBeUndefined();
    expect(completed.primarySessionDetached).toBe(true);
    expect(completed.execution).toEqual(card.execution);
  });

  it("rejects legacy duplicates before claim metadata or workspace adoption", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    const first = await store.create({ title: "First", status: "ready", sessionKey: "shared" });
    const duplicate = await store.create({ title: "Legacy", status: "ready" });
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("UPDATE workboard_cards SET session_key = ?, archived_at = 0 WHERE id = ?").run(
        "shared",
        duplicate.id,
      );
    } finally {
      db.close();
    }
    const before = await store.get(duplicate.id);
    await expect(store.claim(duplicate.id, { ownerId: "owner" })).rejects.toThrow(
      "already reserved by card",
    );
    expect(await store.get(duplicate.id)).toEqual(before);
    expect((await store.get(first.id))?.metadata?.claim).toBeUndefined();
  });
  it.each([
    { legacyKey: "legacy", mirrored: false },
    { legacyKey: " \tlegacy\u00a0", mirrored: false },
    { legacyKey: "legacy", mirrored: true },
    { legacyKey: " \tlegacy\u00a0", mirrored: true },
  ])(
    "recovers reopened legacy duplicates ($legacyKey, mirrored=$mirrored) by explicit detach",
    async ({ legacyKey, mirrored }) => {
      const { store, dbPath } = createWorkboardSqliteTestHarness();
      const first = await store.create({
        title: "First",
        sessionKey: "legacy",
        ...(mirrored ? { execution: { sessionKey: "legacy" } } : {}),
      });
      const second = await store.create({
        title: "Second",
        ...(mirrored ? { execution: { sessionKey: "other-worker" } } : {}),
      });
      await store.close();
      const db = new DatabaseSync(dbPath);
      try {
        // Reopen the pre-detach schema, not just data written by the current store.
        db.exec("ALTER TABLE workboard_cards DROP COLUMN primary_session_detached");
        db.prepare(
          "UPDATE workboard_cards SET session_key = ?, execution_session_key = ?, archived_at = 0 WHERE id = ?",
        ).run(legacyKey, mirrored ? legacyKey : null, second.id);
      } finally {
        db.close();
      }
      const sqlite = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
      let reopened = new WorkboardStore(sqlite.cards, sqlite);
      try {
        const peerSqlite = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
        const peer = new WorkboardStore(peerSqlite.cards, peerSqlite);
        let before;
        try {
          const snapshots = await Promise.all([reopened.list(), peer.list()]);
          expect(snapshots[0]).toEqual(snapshots[1]);
          before = snapshots[0];
        } finally {
          await peer.close();
        }
        const execution = before.find((card) => card.id === second.id)?.execution;
        await expect(
          reopened.captureSession({ sessionKey: "legacy", title: "Capture" }),
        ).rejects.toThrow("reserved");
        await expect(reopened.update(second.id, { title: "Unrelated edit" })).rejects.toThrow(
          "reserved",
        );
        expect(await reopened.list()).toEqual(before);
        const detached = await reopened.bindSession(second.id, { action: "detach" });
        expect(detached.sessionKey).toBeUndefined();
        expect(detached.primarySessionDetached).toBe(true);
        expect(detached.execution).toEqual(execution);
        expect(detached.metadata?.attempts).toEqual(
          before.find((card) => card.id === second.id)?.metadata?.attempts,
        );
        await reopened.close();
        const afterSqlite = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
        reopened = new WorkboardStore(afterSqlite.cards, afterSqlite);
        expect(await reopened.get(second.id)).toMatchObject({
          primarySessionDetached: true,
          ...(execution ? { execution } : {}),
        });
        await expect(
          reopened.captureSession({ sessionKey: "legacy", title: "Capture" }),
        ).resolves.toMatchObject({ id: first.id });
        await expect(
          reopened.update(first.id, { title: "Recovered owner" }),
        ).resolves.toMatchObject({
          sessionKey: "legacy",
        });
        await expect(
          reopened.bindSession(second.id, { action: "bind", sessionKey: "legacy" }),
        ).rejects.toThrow("already reserved");
        const rebound = await reopened.bindSession(second.id, {
          action: "bind",
          sessionKey: "new-primary",
        });
        expect(rebound.primarySessionDetached).toBeUndefined();
        expect(rebound.execution).toEqual(execution);
        await expect(
          reopened.create({ title: "Conflict", sessionKey: "new-primary" }),
        ).rejects.toThrow("already reserved");
      } finally {
        await reopened.close();
      }
    },
  );

  it("reserves normalized execution fallback and permits terminal/archive exemptions", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    const owner = await store.create({
      title: "Fallback",
      execution: { sessionKey: "  reserved  " },
    });
    await expect(store.create({ title: "Conflict", sessionKey: "reserved" })).rejects.toThrow(
      "already reserved by card",
    );
    for (const status of ["blocked", "done"] as const) {
      const terminal = await store.create({ title: status, status, sessionKey: "reserved" });
      await expect(store.update(terminal.id, { status: "ready" })).rejects.toThrow(
        "already reserved by card",
      );
    }
    await store.archive(owner.id, true);
    await expect(
      store.create({ title: "New owner", sessionKey: "reserved" }),
    ).resolves.toMatchObject({ sessionKey: "reserved" });
  });

  it("preserves operator binding through prepared/accepted launch and worker completion", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    const primary = "agent:main:chat:operator";
    const execution = "agent:main:subagent:generated";
    const created = await store.create({ title: "Launch", status: "ready", sessionKey: primary });
    const claimed = await store.claim(created.id, { ownerId: "worker" });
    const scope = { ownerId: "worker", token: claimed.token, sessionKey: execution };
    const prepared = await store.prepareExecutionLaunch(created.id, {
      requestedSessionKey: execution,
      now: Date.now(),
      scope: { ownerId: "worker", token: claimed.token },
    });
    expect(prepared.card.sessionKey).toBe(primary);
    const accepted = await store.acceptExecutionLaunch(created.id, {
      expectedLaunch: prepared.launch,
      acceptedAt: Date.now(),
      expectedSessionKey: execution,
      expectedRunId: prepared.launch.provisionalRunId,
      sessionKey: execution,
      runId: "run",
      execution: {
        ...prepared.card.execution!,
        runId: "run",
      },
    });
    expect(accepted?.sessionKey).toBe(primary);
    expect(accepted?.execution?.sessionKey).toBe(execution);
    await expect(store.create({ title: "Competing", sessionKey: primary })).rejects.toThrow(
      "already reserved by card",
    );
    const completed = await store.complete(
      created.id,
      { ownerId: "worker", token: claimed.token, summary: "Done" },
      scope,
    );
    expect(completed.sessionKey).toBe(primary);
    expect(completed.status).toBe("done");
  });

  it("rejects stale same-millisecond writes on one card", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    const sqlite = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
    const other = new WorkboardStore(sqlite.cards, sqlite);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000000000);
    try {
      const card = await store.create({ title: "Concurrent" });
      const results = await Promise.allSettled([
        store.update(card.id, { sessionKey: "left" }, { expectedUpdatedAt: card.updatedAt }),
        other.update(card.id, { sessionKey: "right" }, { expectedUpdatedAt: card.updatedAt }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const winner = results.find((result) => result.status === "fulfilled");
      if (winner?.status !== "fulfilled") {
        throw new Error("missing winner");
      }
      expect(await store.get(card.id)).toEqual(winner.value);
      expect(winner.value.updatedAt).toBeGreaterThan(card.updatedAt);
    } finally {
      clock.mockRestore();
      await other.close();
    }
  });
  it("rejects an operator rebind racing a claim's original unbound read", async () => {
    let release!: () => void;
    let reached!: () => void;
    let pause = false;
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { store, dbPath } = createWorkboardSqliteTestHarness({
      beforeCardWrite: async () => {
        if (pause) {
          pause = false;
          reached();
          await resumed;
        }
      },
    });
    const sqlite = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
    const operator = new WorkboardStore(sqlite.cards, sqlite);
    try {
      const card = await store.create({ title: "Claim race", status: "ready" });
      pause = true;
      const outcome = store
        .claim(card.id, { ownerId: "worker" }, { callerSessionKey: "worker-chat" })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      await writing;
      const bound = await operator.bindSession(card.id, { action: "bind", sessionKey: "operator" });
      release();
      await expect(outcome).resolves.toMatchObject({
        error: { name: "WorkboardCardConflictError" },
      });
      expect(await store.get(card.id)).toEqual(bound);
      expect(bound.metadata?.claim).toBeUndefined();
    } finally {
      release();
      await operator.close();
    }
  });
});
