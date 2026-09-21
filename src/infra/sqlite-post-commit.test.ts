// Covers the synchronous boundary of SQLite post-commit publication scopes.
import { describe, expect, it } from "vitest";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  deferSqlitePostCommitPublication,
  hasSqlitePostCommitScope,
  stageSqliteTransactionState,
  withSqlitePostCommitPublications,
} from "./sqlite-post-commit.js";

describe("withSqlitePostCommitPublications", () => {
  it("rejects an async callback before deferred publications can run", () => {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(":memory:");
    try {
      const published: string[] = [];
      const stateEvents: string[] = [];
      expect(() =>
        withSqlitePostCommitPublications(db, async () => {
          stageSqliteTransactionState(db, {
            stage: () => stateEvents.push("staged"),
            rollback: () => stateEvents.push("rolled back"),
            commit: () => stateEvents.push("committed"),
          });
          deferSqlitePostCommitPublication(db, () => published.push("early"));
          await Promise.resolve();
          return "late";
        }),
      ).toThrow(/must be synchronous/);
      expect(published).toEqual([]);
      expect(stateEvents).toEqual(["staged", "rolled back"]);
      expect(hasSqlitePostCommitScope(db)).toBe(false);
      // The scope is reusable after the rejected misuse.
      const seen: string[] = [];
      const result = withSqlitePostCommitPublications(db, () => {
        deferSqlitePostCommitPublication(db, () => seen.push("sync"));
        return "ok";
      });
      expect(result).toBe("ok");
      expect(seen).toEqual(["sync"]);
    } finally {
      db.close();
    }
  });

  it("rolls back staged state and leaves no scope for late async continuations", async () => {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(":memory:");
    try {
      const events: string[] = [];
      let lateDeferResult: boolean | undefined;
      const body = async () => {
        await Promise.resolve();
        lateDeferResult = deferSqlitePostCommitPublication(db, () => events.push("late"));
        return "late";
      };
      expect(() => withSqlitePostCommitPublications(db, body)).toThrow(/must be synchronous/);
      expect(hasSqlitePostCommitScope(db)).toBe(false);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(lateDeferResult).toBe(false);
      expect(events).toEqual([]);
    } finally {
      db.close();
    }
  });
});
