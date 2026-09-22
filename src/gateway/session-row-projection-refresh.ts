import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { isColdArchivedSessionRow as isCold } from "./session-row-projection-archive.js";
import { refreshSessionRowMaterializations } from "./session-row-projection-materialize.js";
import {
  withSessionRowDatabaseFacts,
  type PreparedSessionRowDatabaseFacts,
} from "./session-row-projection-read.js";
import * as records from "./session-row-projection-record.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";

type MaterializationOwner = Parameters<typeof refreshSessionRowMaterializations>[0];

/** Refreshes borrow projection state; the projection retains revisions, rows, and archive custody. */
export function createSessionRowRefresh(
  owner: Omit<MaterializationOwner, "ids" | "prepared" | "materializeArchived"> & {
    state: () => {
      cfg: records.Inputs["cfg"];
      disposed: boolean;
      topologyDirty: boolean;
      subagentRevision: number;
    };
    runAsOwner: <T>(operation: () => T) => T;
    lookup: (query: records.Lookup) => records.Row | undefined;
    prepareRegistryFacts: () => Promise<void> | undefined;
    topology: () => void;
    catalog: { needsInitialRead: boolean; refresh: () => Promise<unknown> };
    placementFacts: { prepare: () => Promise<void>; needsPreparation: boolean };
    membership: { prepare: () => Promise<void>; needsPreparation: boolean };
    retainArchived: (row: records.MaterializedRow) => void;
  },
) {
  const revision = () => (owner.state().disposed ? undefined : owner.revision());
  function refresh(
    ids: readonly string[],
    prepared?: ReadonlyMap<string, PreparedSessionRowDatabaseFacts>,
    materializeArchived = false,
  ) {
    if (!owner.state().disposed) {
      refreshSessionRowMaterializations({ ...owner, ids, prepared, materializeArchived });
    }
  }
  function pendingExactRows(queries: readonly records.Lookup[]) {
    const { cfg, subagentRevision } = owner.state();
    const selected = new Set<string>();
    for (const query of queries) {
      const key = resolveStoredSessionKeyForAgentStore({
        cfg,
        sessionKey: query.key,
        agentId: query.agentId,
      });
      if (isIncognitoSessionKey(key)) {
        continue;
      }
      const row = owner.lookup(query);
      if (
        row &&
        (owner.dirty.has(records.identity(row)) ||
          isCold(row) ||
          row.subagentRevision !== subagentRevision)
      ) {
        selected.add(records.identity(row));
      }
    }
    return selected;
  }
  function prepareExactRows(queries: readonly records.Lookup[]) {
    if (owner.state().disposed) {
      return undefined;
    }
    const selected = pendingExactRows(queries);
    if (selected.size === 0) {
      return undefined;
    }
    for (const id of selected) {
      if (!isCold(owner.rows.get(id)!)) {
        owner.dirty.add(id);
      }
    }
    return owner.runAsOwner(() =>
      withSessionRowDatabaseFacts(
        { rows: owner.rows, dirty: owner.dirty, selected, cfg: owner.state().cfg, revision },
        (ids, facts) => {
          withAgentRosterFactsBatch(owner.state().cfg, () => refresh(ids, facts, true));
          for (const id of ids) {
            const row = owner.rows.get(id);
            if (records.ready(row) && row.entry.archivedAt !== undefined) {
              owner.retainArchived(row);
            }
          }
        },
      ),
    );
  }
  async function refreshBatch() {
    for (
      let pending = owner.prepareRegistryFacts();
      pending;
      pending = owner.prepareRegistryFacts()
    ) {
      await pending;
    }
    if (owner.state().disposed) {
      return;
    }
    if (owner.state().topologyDirty) {
      owner.topology();
    }
    await owner.membership.prepare();
    if (owner.catalog.needsInitialRead) {
      await owner.catalog.refresh();
    }
    await owner.placementFacts.prepare();
    for (
      let pending = owner.prepareRegistryFacts();
      pending;
      pending = owner.prepareRegistryFacts()
    ) {
      await pending;
    }
    if (
      owner.state().topologyDirty ||
      owner.membership.needsPreparation ||
      owner.placementFacts.needsPreparation
    ) {
      return;
    }
    await withSessionRowDatabaseFacts(
      { rows: owner.rows, dirty: owner.dirty, cfg: owner.state().cfg, revision },
      (ids, facts) => withAgentRosterFactsBatch(owner.state().cfg, () => refresh(ids, facts)),
    );
  }
  return {
    refresh,
    refreshBatch,
    prepareExactRows,
    assertExactRowsPrepared(this: void, queries: readonly records.Lookup[]) {
      if (pendingExactRows(queries).size > 0) {
        throw new Error("Session row facts changed before the prepared read; retry the request");
      }
    },
  };
}
