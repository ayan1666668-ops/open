import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  applySessionEntryLifecycleMutation,
  applySessionEntryReplacements,
  applySessionPatchProjections,
  assignSessionOwner,
  listSessionEntriesByStatus,
  loadSessionEntry,
  onSessionIdentityMutation,
  upsertSessionEntryCore,
  type SessionPatchProjectionOperation,
} from "./session-accessor.js";
import { loadExactSessionEntry, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.js";
import { applySessionEntryCanonicalReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirs: string[] = [];

describe("session accessor bulk replacement", () => {
  let storePath: string;
  beforeEach(() => {
    storePath = path.join(makeTempDir(tempDirs, "openclaw-session-replacement-"), "sessions.json");
  });
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanupTempDirs(tempDirs);
  });

  it("applies explicit replacements without exposing mutable store rows", async () => {
    await applySessionEntryLifecycleMutation({
      storePath,
      upserts: [
        {
          sessionKey: "agent:main:main",
          entry: {
            sessionId: "session-1",
            status: "running",
            updatedAt: 10,
          },
        },
        {
          sessionKey: "agent:main:other",
          entry: {
            sessionId: "session-2",
            status: "running",
            updatedAt: 20,
          },
        },
        {
          sessionKey: "agent:main:done",
          entry: {
            sessionId: "session-done",
            status: "done",
            updatedAt: 25,
          },
        },
        {
          sessionKey: "agent:main:shared-running",
          entry: {
            sessionId: "session-shared",
            status: "running",
            updatedAt: 26,
          },
        },
        {
          sessionKey: "agent:main:shared-done",
          entry: {
            sessionId: "session-shared",
            status: "done",
            updatedAt: 27,
          },
        },
      ],
      skipMaintenance: true,
    });
    const doneOwner = { id: "done-owner", type: "human" as const };
    assignSessionOwner(
      { sessionKey: "agent:main:done", storePath },
      { assignedBy: doneOwner, owner: doneOwner },
    );
    recordSessionParticipant(
      { sessionKey: "agent:main:main", storePath },
      { identity: { type: "profile", id: "replacement-reader" }, promptedAt: 10 },
    );
    const databasePath = expectDefined(
      resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
      "replacement preparation database path",
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    const preparationReads = trackSqliteStatementExecutions(
      database.db,
      ["entries", "participants"],
      (sql) => {
        if (/from\s+"session_nodes"/i.test(sql)) {
          return "entries";
        }
        return /from\s+"session_participants"/i.test(sql) ? "participants" : null;
      },
    );

    const result = await applySessionEntryReplacements({
      storePath,
      update: (entries) => {
        // Measure preparation before the required fresh transaction-side reads.
        expect.soft(preparationReads.counts.entries).toBeLessThanOrEqual(2);
        expect.soft(preparationReads.counts.participants).toBeLessThanOrEqual(1);
        expect(preparationReads.rowCounts.entries).toBeGreaterThan(0);
        expect(preparationReads.rowCounts.participants).toBeGreaterThan(0);
        expect(entries.map(({ sessionKey }) => sessionKey)).toEqual([
          "agent:main:done",
          "agent:main:main",
          "agent:main:other",
          "agent:main:shared-done",
          "agent:main:shared-running",
        ]);
        const main = entries.find((entry) => entry.sessionKey === "agent:main:main");
        const other = entries.find((entry) => entry.sessionKey === "agent:main:other");
        if (other) {
          other.entry.status = "failed";
        }
        if (!main) {
          return { result: { replaced: false } };
        }
        expect(main.entry.participants).toEqual([
          { identity: { type: "profile", id: "replacement-reader" } },
        ]);
        main.entry.abortedLastRun = true;
        main.entry.updatedAt = 30;
        return {
          result: { replaced: true },
          replacements: [{ sessionKey: main.sessionKey, entry: main.entry }],
        };
      },
    }).finally(() => preparationReads.restore());

    expect(result).toEqual({ replaced: true });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      abortedLastRun: true,
      sessionId: "session-1",
      updatedAt: 30,
    });
    expect(loadSessionEntry({ sessionKey: "agent:main:other", storePath })).toMatchObject({
      sessionId: "session-2",
      status: "running",
      updatedAt: 20,
    });

    const selectedKeys = await applySessionEntryReplacements({
      sessionKeys: ["agent:main:main"],
      storePath,
      update: (entries) => ({ result: entries.map((entry) => entry.sessionKey) }),
    });
    expect(selectedKeys).toEqual(["agent:main:main"]);

    const runningKeys = await applySessionEntryReplacements({
      statuses: ["running"],
      storePath,
      update: (entries) => ({ result: entries.map((entry) => entry.sessionKey) }),
    });
    expect(runningKeys).toEqual([
      "agent:main:main",
      "agent:main:other",
      "agent:main:shared-running",
    ]);
    const doneSessions = listSessionEntriesByStatus({ storePath }, ["done"]);
    expect(doneSessions.map((entry) => entry.sessionKey)).toEqual([
      "agent:main:done",
      "agent:main:shared-done",
    ]);
    expect(doneSessions[0]?.entry.owner?.actor).toEqual(doneOwner);

    const other = loadSessionEntry({ sessionKey: "agent:main:other", storePath });
    expect(other).toBeDefined();
    await expect(
      applySessionEntryReplacements({
        sessionKeys: ["agent:main:main"],
        storePath,
        update: () => ({
          replacements: [{ sessionKey: "agent:main:other", entry: other! }],
          result: undefined,
        }),
      }),
    ).rejects.toThrow("outside the selected key set");

    const runtimeAliasMarker = {
      sessionKey: "agent:main:missing",
      entry: { sessionId: "missing", status: "running" as const, updatedAt: 30 },
      previousSessionKeys: [],
    };
    const missingSelectionResult = await applySessionEntryReplacements({
      sessionKeys: ["agent:main:missing"],
      storePath,
      update: () => ({
        replacements: [runtimeAliasMarker],
        result: "missing-row-no-op",
      }),
    });
    expect(missingSelectionResult).toBe("missing-row-no-op");
    expect(loadSessionEntry({ sessionKey: "agent:main:missing", storePath })).toBeUndefined();

    const done = loadSessionEntry({ sessionKey: "agent:main:done", storePath });
    expect(done).toBeDefined();
    await expect(
      applySessionEntryReplacements({
        statuses: ["running"],
        storePath,
        update: () => ({
          replacements: [{ sessionKey: "agent:main:done", entry: done! }],
          result: undefined,
        }),
      }),
    ).rejects.toThrow("outside the selected row set");
  });

  it("ignores runtime-only alias rekey fields on public exact replacements", async () => {
    const canonicalKey = "agent:main:runtime-canonical";
    const aliasKey = "agent:main:runtime-alias";
    await upsertSessionEntryCore(
      { sessionKey: canonicalKey, storePath },
      { sessionId: "runtime-canonical", updatedAt: 1 },
    );
    await upsertSessionEntryCore(
      { sessionKey: aliasKey, storePath },
      { sessionId: "runtime-alias", updatedAt: 2 },
    );
    const runtimeAliasRekeyMarker = {
      sessionKey: canonicalKey,
      entry: { sessionId: "runtime-canonical", label: "Updated", updatedAt: 3 },
      previousSessionKeys: [aliasKey],
    };

    await applySessionEntryReplacements({
      sessionKeys: [canonicalKey, aliasKey],
      storePath,
      update: () => ({ replacements: [runtimeAliasRekeyMarker], result: undefined }),
    });

    expect(loadSessionEntry({ sessionKey: canonicalKey, storePath })).toMatchObject({
      label: "Updated",
      sessionId: "runtime-canonical",
    });
    expect(loadSessionEntry({ sessionKey: aliasKey, storePath })).toMatchObject({
      sessionId: "runtime-alias",
    });
  });

  it("projects ordered patches against one mutable store view", async () => {
    const keys = ["a", "b", "c", "d"].map((suffix) => `agent:main:batch-${suffix}`);
    for (const [index, sessionKey] of keys.entries()) {
      await upsertSessionEntryCore(
        { sessionKey, storePath },
        { sessionId: `batch-${index}`, updatedAt: index + 1 },
      );
    }
    const snapshots = new Set<object>();
    const operation = (
      index: number,
      label: string,
      authorize?: () => { ok: false; error: string } | undefined,
    ): SessionPatchProjectionOperation<{ ok: false; error: string }> => ({
      resolveTarget: (snapshot) => {
        snapshots.add(snapshot.store);
        return { primaryKey: keys[index]! };
      },
      project: ({ existingEntry, isLabelInUse }) => {
        if (isLabelInUse(label)) {
          return { ok: false as const, error: `duplicate:${label}` };
        }
        return { ok: true as const, entry: { ...existingEntry!, label } };
      },
      ...(authorize ? { authorize } : {}),
    });

    const results = await applySessionPatchProjections({
      storePath,
      operations: [
        operation(0, "Shared"),
        operation(1, "Shared"),
        operation(2, "Blocked", () => ({ ok: false, error: "authorization changed" })),
        operation(3, "Blocked"),
      ],
    });

    expect(snapshots.size).toBe(1);
    expect(results.map((result) => (result.ok ? result.entry.label : result.error))).toEqual([
      "Shared",
      "duplicate:Shared",
      "authorization changed",
      "Blocked",
    ]);
    expect(loadSessionEntry({ sessionKey: keys[0]!, storePath })?.label).toBe("Shared");
    expect(loadSessionEntry({ sessionKey: keys[1]!, storePath })?.label).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: keys[2]!, storePath })?.label).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: keys[3]!, storePath })?.label).toBe("Blocked");
  });

  it("inserts and canonically rekeys through the bulk replacement owner", async () => {
    const insertedKey = "agent:main:replacement-insert";
    await applySessionEntryCanonicalReplacements({
      sessionKeys: [insertedKey],
      storePath,
      update: () => ({
        replacements: [
          {
            entry: { sessionId: "inserted", updatedAt: 1 },
            previousSessionKeys: [],
            sessionKey: insertedKey,
          },
        ],
        result: undefined,
      }),
    });
    expect(loadSessionEntry({ sessionKey: insertedKey, storePath })).toMatchObject({
      sessionId: "inserted",
    });

    const canonicalKey = "agent:main:replacement-canonical";
    const previousKey = "agent:main:replacement-previous";
    await upsertSessionEntryCore(
      { sessionKey: canonicalKey, storePath },
      { sessionId: "canonical-older", updatedAt: 10 },
    );
    await upsertSessionEntryCore(
      { sessionKey: previousKey, storePath },
      { sessionId: "rekeyed", updatedAt: 20 },
    );
    for (const [sessionKey, count] of [
      [canonicalKey, 2],
      [previousKey, 3],
    ] as const) {
      for (let promptedAt = 0; promptedAt < count; promptedAt += 1) {
        recordSessionParticipant(
          { sessionKey, storePath },
          { identity: { type: "profile", id: "profile-shared" }, promptedAt },
        );
      }
    }
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    database.db
      .prepare(
        "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, ?, ?, ?)",
      )
      .run(previousKey, "member-1", "test", 1);
    const identityListener = vi.fn();
    const unsubscribe = onSessionIdentityMutation(identityListener);
    await applySessionEntryCanonicalReplacements({
      sessionKeys: [canonicalKey, previousKey],
      storePath,
      update: (entries) => ({
        replacements: [
          {
            entry: {
              ...entries.find((entry) => entry.sessionKey === previousKey)!.entry,
              label: "Moved",
            },
            previousSessionKeys: [previousKey],
            sessionKey: canonicalKey,
          },
        ],
        result: undefined,
      }),
    });
    unsubscribe();
    expect(loadSessionEntry({ sessionKey: previousKey, storePath })).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: canonicalKey, storePath })).toMatchObject({
      label: "Moved",
      sessionId: "rekeyed",
    });
    expect(
      database.db
        .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
        .get("rekeyed"),
    ).toEqual({ session_key: canonicalKey });
    expect(
      database.db
        .prepare("SELECT session_key, identity_id FROM session_members WHERE identity_id = ?")
        .get("member-1"),
    ).toEqual({ session_key: canonicalKey, identity_id: "member-1" });
    expect(
      database.db
        .prepare("SELECT contribution_count FROM session_participants WHERE actor_id = ?")
        .get("profile-shared"),
    ).toEqual({ contribution_count: 5 });
    expect(identityListener.mock.calls.map(([event]) => event.kind)).toEqual(["move", "replace"]);
    await expect(
      applySessionEntryCanonicalReplacements({
        sessionKeys: [canonicalKey, previousKey],
        storePath,
        update: (entries) => ({
          replacements: [
            {
              entry: entries.find((entry) => entry.sessionKey === canonicalKey)!.entry,
              previousSessionKeys: [previousKey],
              sessionKey: canonicalKey,
            },
          ],
          result: undefined,
        }),
      }),
    ).rejects.toThrow("cannot replace missing alias");
    expect(
      database.db
        .prepare("SELECT contribution_count FROM session_participants WHERE actor_id = ?")
        .get("profile-shared"),
    ).toEqual({ contribution_count: 5 });
  });

  it("rejects internal canonical targets and alias sources without changing rows or events", async () => {
    const visibleKey = "agent:main:replacement-visible";
    const internalKey = "agent:main:internal-session-effects:replacement-guard";
    await upsertSessionEntryCore(
      { sessionKey: visibleKey, storePath },
      { label: "Visible", sessionId: "replacement-visible", updatedAt: 10 },
    );
    await upsertSessionEntryCore(
      { sessionKey: internalKey, storePath },
      { label: "Internal", sessionId: "replacement-internal", updatedAt: 20 },
    );
    const snapshot = () =>
      [visibleKey, internalKey].map((sessionKey) =>
        loadExactSessionEntry({ sessionKey, storePath }),
      );
    const before = snapshot();
    const identityListener = vi.fn();
    const unsubscribe = onSessionIdentityMutation(identityListener);

    try {
      for (const replacement of [
        {
          entry: { sessionId: "fabricated-target", updatedAt: 30 },
          previousSessionKeys: [],
          sessionKey: internalKey,
        },
        {
          entry: { sessionId: "fabricated-alias", updatedAt: 30 },
          previousSessionKeys: [internalKey],
          sessionKey: visibleKey,
        },
      ]) {
        await expect(
          applySessionEntryCanonicalReplacements({
            sessionKeys: [visibleKey, internalKey],
            storePath,
            update: () => ({ replacements: [replacement], result: undefined }),
          }),
        ).rejects.toThrow("cannot target internal effects rows");
        expect(snapshot()).toEqual(before);
      }
    } finally {
      unsubscribe();
    }
    expect(identityListener).not.toHaveBeenCalled();
  });

  it("rolls back mixed exact replacements and canonical rekeys as one transaction", async () => {
    const exactKey = "agent:main:replacement-rollback-exact";
    const canonicalKey = "agent:main:replacement-rollback-canonical";
    const previousKey = "agent:main:replacement-rollback-previous";
    await upsertSessionEntryCore(
      { sessionKey: exactKey, storePath },
      { label: "Exact original", sessionId: "rollback-exact", updatedAt: 10 },
    );
    await upsertSessionEntryCore(
      { sessionKey: canonicalKey, storePath },
      { label: "Canonical original", sessionId: "rollback-canonical", updatedAt: 20 },
    );
    await upsertSessionEntryCore(
      { sessionKey: previousKey, storePath },
      { label: "Previous original", sessionId: "rollback-previous", updatedAt: 30 },
    );
    const before = new Map(
      [exactKey, canonicalKey, previousKey].map((sessionKey) => [
        sessionKey,
        structuredClone(loadSessionEntry({ sessionKey, storePath })),
      ]),
    );
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    database.db.exec(`
      CREATE TEMP TRIGGER fail_mixed_replacement_after_exact_write
      BEFORE UPDATE OF entry_json ON main.session_nodes
      WHEN NEW.session_key = '${canonicalKey}'
        AND (
          SELECT json_extract(entry_json, '$.label')
          FROM session_nodes
          WHERE session_key = '${exactKey}'
        ) = 'Exact updated'
      BEGIN
        SELECT RAISE(ABORT, 'injected mixed replacement failure');
      END;
    `);
    const identityListener = vi.fn();
    const unsubscribe = onSessionIdentityMutation(identityListener);

    try {
      await expect(
        applySessionEntryCanonicalReplacements({
          sessionKeys: [exactKey, canonicalKey, previousKey],
          storePath,
          update: (entries) => ({
            replacements: [
              {
                entry: {
                  ...entries.find((entry) => entry.sessionKey === exactKey)!.entry,
                  label: "Exact updated",
                },
                previousSessionKeys: [],
                sessionKey: exactKey,
              },
              {
                entry: {
                  ...entries.find((entry) => entry.sessionKey === previousKey)!.entry,
                  label: "Canonical updated",
                },
                previousSessionKeys: [previousKey],
                sessionKey: canonicalKey,
              },
            ],
            result: undefined,
          }),
        }),
      ).rejects.toThrow("injected mixed replacement failure");
    } finally {
      unsubscribe();
      database.db.exec("DROP TRIGGER fail_mixed_replacement_after_exact_write");
    }

    for (const sessionKey of [exactKey, canonicalKey, previousKey]) {
      expect(loadSessionEntry({ sessionKey, storePath })).toEqual(before.get(sessionKey));
    }
    expect(identityListener).not.toHaveBeenCalled();
  });

  it("rejects a label claimed while a replacement is being prepared", async () => {
    const target = { sessionKey: "agent:main:label-target", storePath };
    const competing = { sessionKey: "agent:main:label-competitor", storePath };
    await upsertSessionEntryCore(target, { sessionId: "label-target", updatedAt: 1 });
    await upsertSessionEntryCore(competing, { sessionId: "label-competitor", updatedAt: 1 });

    await expect(
      applySessionEntryCanonicalReplacements({
        sessionKeys: [target.sessionKey],
        includeLabelOwners: "Claimed",
        storePath,
        update: async (entries) => {
          expect(entries.map(({ sessionKey }) => sessionKey)).toEqual([target.sessionKey]);
          await Promise.resolve();
          replaceSessionEntrySync(competing, {
            sessionId: "label-competitor",
            label: "Claimed",
            updatedAt: 2,
          });
          return {
            result: undefined,
            replacements: [
              {
                sessionKey: target.sessionKey,
                previousSessionKeys: [],
                entry: { ...entries[0]!.entry, label: "Claimed" },
              },
            ],
          };
        },
      }),
    ).rejects.toThrow("label owners changed before replacement");
    expect(loadSessionEntry(target)?.label).toBeUndefined();
    expect(loadSessionEntry(competing)?.label).toBe("Claimed");
  });

  it("rejects a label owner released during snapshot hydration and reclaimed during planning", async () => {
    const target = { sessionKey: "agent:main:label-target", storePath };
    const competing = { sessionKey: "agent:main:label-competitor", storePath };
    const competingEntry = { sessionId: "label-competitor", label: "Claimed", updatedAt: 1 };
    await upsertSessionEntryCore(target, { sessionId: "label-target", updatedAt: 1 });
    await upsertSessionEntryCore(competing, competingEntry);
    const databasePath = expectDefined(
      resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
      "label race database path",
    );
    const externalWriter = new DatabaseSync(databasePath);
    const changeCompetingLabel = (label: string, updatedAt: number) => {
      externalWriter
        .prepare(
          "UPDATE session_nodes SET label = ?, updated_at = ?, entry_json = json_set(entry_json, '$.label', ?, '$.updatedAt', ?) WHERE session_key = ?",
        )
        .run(label, updatedAt, label, updatedAt, competing.sessionKey);
    };
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    clearNodeSqliteKyselyCacheForDatabase(database.db);
    const prepare = database.db.prepare.bind(database.db);
    let released = false;
    const releaseAfterSelection = (sawCompeting: boolean) => {
      if (released) {
        return;
      }
      expect(sawCompeting).toBe(true);
      released = true;
      changeCompetingLabel("Released", 2);
    };
    const readSpy = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (/select "session_key" from "session_nodes" where "label" = /i.test(sql)) {
        // Release after the native label-key read finishes, before either exact
        // or cohort hydration; both must pair that newer row with its own CAS bytes.
        statement.all = new Proxy(statement.all.bind(statement), {
          apply(all, _receiver, args) {
            const rows = all(...args);
            releaseAfterSelection(rows.some((row) => row.session_key === competing.sessionKey));
            return rows;
          },
        });
        statement.iterate = new Proxy(statement.iterate.bind(statement), {
          apply(iterate, _receiver, args) {
            const rows = iterate(...args);
            return (function* () {
              let sawCompeting = false;
              for (const row of rows) {
                sawCompeting ||= row.session_key === competing.sessionKey;
                yield row;
              }
              releaseAfterSelection(sawCompeting);
            })();
          },
        });
      }
      return statement;
    });

    try {
      await expect(
        applySessionEntryCanonicalReplacements({
          sessionKeys: [target.sessionKey],
          includeLabelOwners: "Claimed",
          storePath,
          update: async (entries) => {
            expect(released).toBe(true);
            expect(
              entries.find(({ sessionKey }) => sessionKey === competing.sessionKey)?.entry,
            ).toMatchObject({ label: "Released" });
            await Promise.resolve();
            changeCompetingLabel("Claimed", 3);
            return {
              result: undefined,
              replacements: [
                {
                  sessionKey: target.sessionKey,
                  previousSessionKeys: [],
                  entry: {
                    ...entries.find(({ sessionKey }) => sessionKey === target.sessionKey)!.entry,
                    label: "Claimed",
                  },
                },
              ],
            };
          },
        }),
      ).rejects.toThrow("changed before replacement");
      expect(loadSessionEntry(target)?.label).toBeUndefined();
      expect(loadSessionEntry(competing)?.label).toBe("Claimed");
    } finally {
      clearNodeSqliteKyselyCacheForDatabase(database.db);
      readSpy.mockRestore();
      externalWriter.close();
    }
  });

  it("prepares entry replacements without holding a write transaction", async () => {
    const scope = {
      sessionKey: "agent:main:replacement-prepare",
      storePath,
    };
    await upsertSessionEntryCore(scope, {
      model: "base",
      sessionId: "replacement-prepare",
      updatedAt: 10,
    });
    const plannerStarted = createDeferred();
    const plannerGate = createDeferred();
    const pendingReplacement = applySessionEntryReplacements({
      sessionKeys: [scope.sessionKey],
      storePath,
      update: async (entries) => {
        plannerStarted.resolve();
        await plannerGate.promise;
        return {
          replacements: entries.map(({ entry, sessionKey }) => ({
            entry: { ...entry, model: "planned" },
            sessionKey,
          })),
          result: undefined,
        };
      },
    });

    await plannerStarted.promise;
    let replacementError: unknown;
    try {
      replaceSessionEntrySync(scope, {
        model: "newer",
        sessionId: "replacement-prepare",
        updatedAt: 20,
      });
    } catch (error) {
      replacementError = error;
    } finally {
      plannerGate.resolve();
    }
    const planningError = await pendingReplacement.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(replacementError).toBeUndefined();
    expect(planningError).toMatchObject({
      message: expect.stringContaining("changed before replacement"),
    });
    expect(loadSessionEntry(scope)).toMatchObject({ model: "newer", updatedAt: 20 });
  });

  it("preserves participant changes made while status-selected replacements are planned", async () => {
    const scope = { sessionKey: "agent:main:participant-replacement", storePath };
    await upsertSessionEntryCore(scope, {
      sessionId: "participant-replacement",
      status: "running",
      updatedAt: 10,
    });
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:participant-replacement-peer", storePath },
      { sessionId: "participant-replacement-peer", status: "running", updatedAt: 10 },
    );
    recordSessionParticipant(scope, {
      identity: {
        type: "observation",
        id: "8167215807",
        pluginId: null,
        accountId: null,
        senderKind: "unknown",
      },
      promptedAt: 10,
    });

    await applySessionEntryReplacements({
      statuses: ["running"],
      storePath,
      update: async (entries) => {
        expect(entries).toHaveLength(2);
        const snapshot = expectDefined(
          entries.find(({ sessionKey }) => sessionKey === scope.sessionKey),
          "selected replacement snapshot",
        );
        expect(snapshot.entry.participantCount).toBe(1);
        expect(snapshot.entry.participants?.map(({ identity }) => identity.id)).toEqual([
          "8167215807",
        ]);
        await Promise.resolve();
        expect(
          recordSessionParticipant(scope, {
            identity: { type: "agent", id: "late-participant" },
            promptedAt: 20,
          }),
        ).toBe("inserted");
        // The detached snapshot stays old; participant history has its own writer.
        expect(snapshot.entry.participantCount).toBe(1);
        expect(snapshot.entry.participants?.map(({ identity }) => identity.id)).toEqual([
          "8167215807",
        ]);
        return {
          replacements: entries.map(({ entry, sessionKey }) => ({
            entry: { ...entry, abortedLastRun: true },
            sessionKey,
          })),
          result: undefined,
        };
      },
    });

    const fresh = expectDefined(loadSessionEntry(scope), "replaced session entry");
    expect(fresh).toMatchObject({ abortedLastRun: true, participantCount: 2 });
    expect(fresh.participants?.map(({ identity }) => identity.id)).toEqual([
      "8167215807",
      "late-participant",
    ]);
    const databasePath = expectDefined(
      resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
      "participant replacement database path",
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    const stored = expectDefined(
      database.db
        .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
        .get(scope.sessionKey),
      "persisted replacement row",
    );
    if (typeof stored.entry_json !== "string") {
      throw new Error("Expected persisted session JSON");
    }
    const persisted: unknown = JSON.parse(stored.entry_json);
    expect(persisted).not.toHaveProperty("participants");
    expect(persisted).not.toHaveProperty("participantCount");
  });
});
