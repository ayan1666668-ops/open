import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, prepareSqliteQuerySync } from "../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber, normalizeSqliteNumber } from "../infra/sqlite-number.js";
import {
  bindPluginStateEntry,
  countLivePluginStateNamespaceEntries,
  createPluginStateError,
  deleteExpiredPluginStateEntries,
  getPluginStateKysely,
  hasPluginStateEntry,
  isRetainedPluginStateNamespace,
  PLUGIN_STATE_EXPIRY_BATCH_ROWS,
  RETAINED_PLUGIN_STATE_NAMESPACE_PREFIX,
  resolvePluginStateExpiresAtMs,
  upsertPluginStateEntry,
  type PluginStateCountRow,
  type PluginStateDatabase,
} from "./plugin-state-store.kernel.js";
import type { PluginStateOverflowPolicy } from "./plugin-state-store.types.js";

const RETAINED_PLUGIN_STATE_NAMESPACE_END = "@retained/";
type PluginStateCountParams = { pluginId: string; now: number };
const pluginStateCountQueries = new WeakMap<
  DatabaseSync,
  ReturnType<typeof prepareSqliteQuerySync<PluginStateCountParams, PluginStateCountRow>>
>();
const boundedPluginStateCountQueries = new WeakMap<
  DatabaseSync,
  ReturnType<typeof prepareSqliteQuerySync<PluginStateCountParams, PluginStateCountRow>>
>();

export function countLivePluginStateEntries(
  db: DatabaseSync,
  params: PluginStateCountParams,
): number {
  return countPluginStateEntries(db, params, false);
}

export function countLiveBoundedPluginStateEntries(
  db: DatabaseSync,
  params: PluginStateCountParams,
): number {
  return countPluginStateEntries(db, params, true);
}

function countPluginStateEntries(
  db: DatabaseSync,
  params: PluginStateCountParams,
  boundedOnly: boolean,
): number {
  const queries = boundedOnly ? boundedPluginStateCountQueries : pluginStateCountQueries;
  let query = queries.get(db);
  if (!query) {
    query = prepareSqliteQuerySync<PluginStateCountParams, PluginStateCountRow>(db, (parameter) => {
      const counts = getPluginStateKysely(db)
        .selectFrom("plugin_state_entries")
        .select((eb) => eb.fn.countAll<number | bigint>().as("count"))
        .where(
          "plugin_id",
          "=",
          parameter((value) => value.pluginId),
        )
        .where((eb) =>
          eb.or([
            eb("expires_at", "is", null),
            eb(
              "expires_at",
              ">",
              parameter((value) => value.now),
            ),
          ]),
        );
      // Separate aggregates keep both scans inside bounded namespace index ranges.
      return boundedOnly
        ? counts
            .where("namespace", "<", RETAINED_PLUGIN_STATE_NAMESPACE_PREFIX)
            .unionAll(counts.where("namespace", ">=", RETAINED_PLUGIN_STATE_NAMESPACE_END))
        : counts;
    });
    queries.set(db, query);
  }
  let count = 0;
  for (const row of query(params).rows) {
    count += coerceRequiredSqliteNumber(row.count);
  }
  return count;
}

function deleteOldestPluginStateNamespaceEntries(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; protectedKey: string; now: number; limit: number },
): number {
  const kysely = getPluginStateKysely(db);
  const keys = kysely
    .selectFrom("plugin_state_entries")
    .select("entry_key")
    .where("plugin_id", "=", params.pluginId)
    .where("namespace", "=", params.namespace)
    .where("entry_key", "!=", params.protectedKey)
    .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)]))
    .orderBy("created_at", "asc")
    .orderBy("entry_key", "asc")
    .limit(params.limit);
  const result = executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("plugin_state_entries")
      .where("plugin_id", "=", params.pluginId)
      .where("namespace", "=", params.namespace)
      .where("entry_key", "in", keys),
  );
  return Number(result.numAffectedRows ?? 0);
}

type PluginStateRetention = {
  namespaceCount: number;
  pluginCount: number;
  nextExpiry: number;
  now: number;
  sweepPending: boolean;
};

export function readPluginStateRetention(
  db: DatabaseSync,
  params: { pluginId: string; namespace: string; now: number },
): PluginStateRetention {
  const counts = getPluginStateKysely(db)
    .selectFrom("plugin_state_entries")
    .select((eb) => [
      eb.fn.countAll<number | bigint>().as("plugin_count"),
      eb.fn
        .countAll<number | bigint>()
        .filterWhere("namespace", "=", params.namespace)
        .as("namespace_count"),
      eb.fn.min<number | bigint | null>("expires_at").as("next_expiry"),
    ])
    .where("plugin_id", "=", params.pluginId)
    .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", params.now)]));
  const rows = executeSqliteQuerySync(
    db,
    counts
      .where("namespace", "<", RETAINED_PLUGIN_STATE_NAMESPACE_PREFIX)
      .unionAll(counts.where("namespace", ">=", RETAINED_PLUGIN_STATE_NAMESPACE_END)),
  ).rows;
  const retention: PluginStateRetention = {
    namespaceCount: 0,
    pluginCount: 0,
    nextExpiry: Infinity,
    now: params.now,
    sweepPending: true,
  };
  for (const row of rows) {
    retention.namespaceCount += coerceRequiredSqliteNumber(row.namespace_count);
    retention.pluginCount += coerceRequiredSqliteNumber(row.plugin_count);
    retention.nextExpiry = Math.min(
      retention.nextExpiry,
      normalizeSqliteNumber(row.next_expiry) ?? Infinity,
    );
  }
  return retention;
}

export function enforcePostRegisterLimits(params: {
  store: PluginStateDatabase;
  pluginId: string;
  namespace: string;
  maxEntries: number | undefined;
  overflowPolicy: PluginStateOverflowPolicy;
  now: number;
  retention?: PluginStateRetention;
  protectedKey: string;
  maxPluginEntries: number | undefined;
}): void {
  if (isRetainedPluginStateNamespace(params.namespace)) {
    return;
  }
  if (params.maxEntries === undefined) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "register",
      message: "Bounded plugin state requires maxEntries.",
    });
  }
  if (params.overflowPolicy === "reject-new") {
    return;
  }
  const maxPluginEntries = params.maxPluginEntries;
  // A plugin cap no larger than the namespace cap sheds the same oldest prefix.
  if (params.retention || maxPluginEntries === undefined || params.maxEntries < maxPluginEntries) {
    const namespaceCount =
      params.retention?.namespaceCount ??
      countLivePluginStateNamespaceEntries(params.store.db, {
        pluginId: params.pluginId,
        namespace: params.namespace,
        now: params.now,
      });
    if (namespaceCount > params.maxEntries) {
      const deleted = deleteOldestPluginStateNamespaceEntries(params.store.db, {
        pluginId: params.pluginId,
        namespace: params.namespace,
        protectedKey: params.protectedKey,
        now: params.now,
        limit: namespaceCount - params.maxEntries,
      });
      if (params.retention) {
        params.retention.namespaceCount -= deleted;
        params.retention.pluginCount -= deleted;
      }
    }
  }

  if (maxPluginEntries === undefined) {
    return;
  }

  const pluginCount =
    params.retention?.pluginCount ??
    countLiveBoundedPluginStateEntries(params.store.db, {
      pluginId: params.pluginId,
      now: params.now,
    });
  if (pluginCount <= maxPluginEntries) {
    return;
  }

  // Shed only rows from the namespace that grew. Sibling namespaces can hold
  // durable state; if this namespace cannot cover the overflow, fail so the
  // surrounding transaction rolls every insertion and deletion back.
  const deleted = deleteOldestPluginStateNamespaceEntries(params.store.db, {
    pluginId: params.pluginId,
    namespace: params.namespace,
    protectedKey: params.protectedKey,
    now: params.now,
    limit: pluginCount - maxPluginEntries,
  });
  if (params.retention) {
    params.retention.namespaceCount -= deleted;
    params.retention.pluginCount -= deleted;
  }
  // The deletion uses the same live-row predicate and transaction as pluginCount.
  const remainingPluginCount = params.retention?.pluginCount ?? pluginCount - deleted;
  if (remainingPluginCount > maxPluginEntries) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      operation: "register",
      message: `Plugin state for ${params.pluginId} exceeds the ${maxPluginEntries} live row limit.`,
      path: params.store.path,
    });
  }
}

export function assertCanInsertPluginStateEntry(params: {
  store: PluginStateDatabase;
  pluginId: string;
  namespace: string;
  maxEntries: number | undefined;
  overflowPolicy: PluginStateOverflowPolicy;
  now: number;
  retention?: PluginStateRetention;
  maxPluginEntries: number;
}): void {
  if (isRetainedPluginStateNamespace(params.namespace)) {
    return;
  }
  if (params.maxEntries === undefined) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "register",
      message: "Bounded plugin state requires maxEntries.",
    });
  }
  if (params.overflowPolicy !== "reject-new") {
    return;
  }
  const namespaceCount =
    params.retention?.namespaceCount ??
    countLivePluginStateNamespaceEntries(params.store.db, {
      pluginId: params.pluginId,
      namespace: params.namespace,
      now: params.now,
    });
  if (namespaceCount >= params.maxEntries) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      operation: "register",
      message: `Plugin state namespace ${params.namespace} for ${params.pluginId} reached its ${params.maxEntries}-row limit.`,
      path: params.store.path,
    });
  }
  const maxPluginEntries = params.maxPluginEntries;
  const pluginCount =
    params.retention?.pluginCount ??
    countLiveBoundedPluginStateEntries(params.store.db, {
      pluginId: params.pluginId,
      now: params.now,
    });
  if (pluginCount >= maxPluginEntries) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      operation: "register",
      message: `Plugin state for ${params.pluginId} reached the ${maxPluginEntries} live row limit.`,
      path: params.store.path,
    });
  }
}

export type PluginStateRegisterEntryParams = {
  pluginId: string;
  namespace: string;
  key: string;
  valueJson: string;
  maxEntries: number | undefined;
  overflowPolicy: PluginStateOverflowPolicy;
  ttlMs?: number;
  // Migration-only override: eviction orders rows by created_at, so imported
  // legacy rows must keep their original age instead of the import time.
  createdAtMs?: number;
};

/** The caller owns the write transaction, including expiry cleanup and quota eviction. */
export function registerPluginStateEntry(
  store: PluginStateDatabase,
  params: PluginStateRegisterEntryParams,
  maxPluginEntries: number,
  retention?: PluginStateRetention,
): void {
  const now = Date.now();
  const expiresAt = resolvePluginStateExpiresAtMs({
    ttlMs: params.ttlMs,
    namespace: params.namespace,
    now,
    operation: "register",
    path: store.path,
  });
  // Counts belong to this transaction. Expiry (including sibling rows) or a
  // backward clock invalidates them; ordinary writes update them incrementally.
  if (retention && (now < retention.now || now >= retention.nextExpiry)) {
    Object.assign(retention, readPluginStateRetention(store.db, { ...params, now }));
  }
  if (!retention || retention.sweepPending) {
    const deleted = deleteExpiredPluginStateEntries(store.db, now, params);
    if (retention) {
      retention.sweepPending = deleted === PLUGIN_STATE_EXPIRY_BATCH_ROWS;
    }
  }
  // Quotas and batch counts need existence, never the previous JSON payload.
  const existing =
    retention || params.overflowPolicy === "reject-new"
      ? hasPluginStateEntry(store.db, {
          pluginId: params.pluginId,
          namespace: params.namespace,
          key: params.key,
          now,
        })
      : false;
  if (!existing) {
    assertCanInsertPluginStateEntry({
      store,
      pluginId: params.pluginId,
      namespace: params.namespace,
      maxEntries: params.maxEntries,
      overflowPolicy: params.overflowPolicy,
      now,
      retention,
      maxPluginEntries,
    });
  }
  upsertPluginStateEntry(
    store.db,
    bindPluginStateEntry({
      pluginId: params.pluginId,
      namespace: params.namespace,
      key: params.key,
      valueJson: params.valueJson,
      createdAt: params.createdAtMs ?? now,
      expiresAt,
    }),
  );
  if (retention) {
    if (!existing) {
      retention.namespaceCount += 1;
      retention.pluginCount += 1;
    }
    retention.nextExpiry = Math.min(retention.nextExpiry, expiresAt ?? Infinity);
    retention.now = now;
  }
  enforcePostRegisterLimits({
    store,
    pluginId: params.pluginId,
    namespace: params.namespace,
    maxEntries: params.maxEntries,
    overflowPolicy: params.overflowPolicy,
    now,
    protectedKey: params.key,
    retention,
    maxPluginEntries,
  });
}
