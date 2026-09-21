import type { GatewayClient } from "./server-methods/types.js";
import { prepareProjectedSessionPresentation } from "./session-row-presentation.js";
import type { MaterializedRow } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";

type SessionListRead = {
  projection: SessionRowProjection;
  record: MaterializedRow;
  client?: GatewayClient | null;
  generation: MaterializedRow["generation"];
  sessionId: string;
  lifecycleRevision?: string;
};

// In-process consumers retain the producer's generation without exposing it on the wire.
const reads = new WeakMap<object, SessionListRead>();

export function bindSessionListRowRead(
  row: object,
  read: Pick<SessionListRead, "projection" | "record" | "client">,
): void {
  reads.set(row, {
    ...read,
    generation: read.record.generation,
    sessionId: read.record.entry.sessionId,
    lifecycleRevision: read.record.entry.lifecycleRevision,
  });
}

/** Explicit tool enrichment reads the selected physical owner, never a wire-provided path. */
export async function readSessionListRowTitleFields(row: object, requireOwner: boolean) {
  const selected = reads.get(row);
  if (!selected) {
    if (requireOwner) {
      throw new Error("Session enrichment requires its Gateway or embedded read owner");
    }
    return undefined;
  }
  const visible = await withCurrentSessionListRows([row], ([allowed]) => allowed, true);
  if (!visible) {
    return null;
  }
  const { readSessionTitleFieldsFromTranscriptAsync } =
    await import("./session-transcript-title-reader.js");
  return await readSessionTitleFieldsFromTranscriptAsync({
    agentId: selected.record.storeTarget.agentId,
    sessionKey: selected.record.key,
    sessionId: selected.sessionId,
    storePath: selected.record.storeTarget.storePath,
    sessionEntry: { sessionId: selected.sessionId },
  });
}

/** Finalize buffered enrichment inside one current owner read, without a later await. */
export async function withCurrentSessionListRows<T>(
  rows: readonly object[],
  consume: (visible: readonly boolean[]) => T,
  requireOwner: boolean,
): Promise<T> {
  if (rows.length === 0) {
    return consume([]);
  }
  const captured = rows.map((row) => reads.get(row));
  if (!requireOwner && captured.every((read) => !read)) {
    // A remote client consumes independently authorized RPC responses, not a local owner view.
    return consume(rows.map(() => true));
  }
  const selected = captured.map((read) => {
    if (!read) {
      throw new Error("Session enrichment requires its Gateway or embedded read owner");
    }
    return read;
  });
  const projection = selected[0]!.projection;
  if (selected.some((read) => read.projection !== projection)) {
    throw new Error("Gateway changed while preparing session inventory; retry the request");
  }
  while (true) {
    const prepared = await projection.withPreparedExactRows(
      () => selected.map(({ record }) => ({ agentId: record.agentId, key: record.key })),
      (read) => {
        const presentations = new Map<
          GatewayClient | null | undefined,
          ReturnType<typeof prepareProjectedSessionPresentation>
        >();
        const visible = selected.map((selectedRead) => {
          const { record: previous, client } = selectedRead;
          const query = { agentId: previous.agentId, key: previous.key };
          const record = read.describe(query, previous);
          if (
            !record ||
            record.agentId !== previous.agentId ||
            record.key !== previous.key ||
            record.storeTarget.storePath !== previous.storeTarget.storePath ||
            record.generation !== selectedRead.generation ||
            record.entry.sessionId !== selectedRead.sessionId ||
            record.entry.lifecycleRevision !== selectedRead.lifecycleRevision
          ) {
            return false;
          }
          if (client === undefined) {
            return true;
          }
          let presentation = presentations.get(client);
          if (!presentation) {
            presentation = prepareProjectedSessionPresentation(read, client);
            presentations.set(client, presentation);
          }
          return (
            !presentation.authorizeDescription(query) &&
            presentation.sharing.entryFilter?.(record.key, record.entry) !== false
          );
        });
        return consume(visible);
      },
    );
    if (prepared.kind === "complete") {
      return prepared.value;
    }
    const { certifySessionCanonicalValidationPending } =
      await import("../config/sessions/session-canonical-validation-readiness.js");
    await certifySessionCanonicalValidationPending(prepared.database);
  }
}
