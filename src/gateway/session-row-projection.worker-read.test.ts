import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import * as entryCache from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";

afterEach(() => vi.restoreAllMocks());

it("preserves a keyed replacement while an older worker reply is pending", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const query = { agentId: "main", key: "agent:main:worker-replacement" };
    const entry = { sessionId: "original", updatedAt: 1 };
    replaceSessionEntrySync({ agentId: query.agentId, sessionKey: query.key }, entry);
    const releaseForeground = retainSessionListForegroundWork();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let reading: Promise<void> | undefined;
    const projection = await createSessionRowProjection({
      cfg: { agents: { list: [{ id: "main", default: true }] } },
    });
    try {
      await projection.ensureMaterialized();
      const readDatabases = history.withSessionHistoryWorkerDatabases;
      vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementationOnce(
        (databases, consume) =>
          readDatabases(databases, (owners) =>
            consume(
              owners.map((owner) => ({
                ...owner,
                async readRowFacts(input) {
                  const reply = await owner.readRowFacts(input);
                  entered.resolve();
                  await release.promise;
                  return reply;
                },
              })),
            ),
          ),
      );
      sessionChanges.emit({ agentId: query.agentId, sessionKey: query.key });
      reading = projection.ensureMaterialized();
      await entered.promise;
      // A direct reader can discover a new lifecycle independently of bulk publication.
      vi.spyOn(entryCache, "readCommittedSessionEntryCache").mockReturnValueOnce(
        new Map([[query.key, { ...entry, sessionId: "replacement" }]]),
      );
      const replacement = projection.describe(query);
      expect(replacement?.entry.sessionId).toBe("replacement");
      release.resolve();
      await reading;
      expect(projection.isCurrent(replacement!)).toBe(true);
      expect(projection.snapshot(query).row?.sessionId).toBe("replacement");
    } finally {
      release.resolve();
      await reading;
      projection.dispose();
      releaseForeground();
    }
  });
});

it("refreshes prepared ACP metadata on publication and fences replacement lifecycles", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:acp:worker-row";
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const target = { agentId: "main", sessionKey: key };
    replaceSessionEntrySync(target, {
      sessionId: "worker-row",
      lifecycleRevision: "first",
      updatedAt: 1,
    });
    const releaseForeground = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg });
    try {
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key }).row?.runtimeSelectionLocked).toBe(false);
      for (const backend of ["acpx", "replacement-acp-backend"]) {
        // Released free-runtime aliases are case-insensitive and read-only compatible.
        writeAcpSessionMetaForMigration({
          sessionKey: key.toUpperCase(),
          lifecycleRevision: "first",
          meta: {
            backend,
            agent: "main",
            runtimeSessionName: "worker-row",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 1,
          },
        });
        const reads = observeSqliteReadSql(StatementSync.prototype);
        try {
          await projection.ensureMaterialized();
          expect(projection.snapshot({ agentId: "main", key }).row).toMatchObject({
            runtimeSelectionLocked: true,
            agentRuntime: { id: backend, source: "session-key" },
          });
          expect(reads.queries.filter((sql) => sql.includes("acp_sessions"))).toEqual([]);
        } finally {
          reads.restore();
        }
      }
      replaceSessionEntrySync(target, {
        sessionId: "worker-row",
        lifecycleRevision: "replacement",
        updatedAt: 2,
      });
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key }).row?.runtimeSelectionLocked).toBe(false);
    } finally {
      projection.dispose();
      releaseForeground();
    }
  });
});
