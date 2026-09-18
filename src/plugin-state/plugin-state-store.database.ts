import { hasErrnoCode } from "../infra/errno.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { isTerminalSqliteIntegrityError } from "../infra/sqlite-integrity.js";
import { isSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { resolveDatabasePath } from "../state/openclaw-state-db-maintenance.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { hasOpenClawStateTablesBeyondStartupCheckpoint } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabase,
  isOpenClawStateDatabaseOpen,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  bindPluginStateEntry,
  createPluginStateError,
  deletePluginStateEntry,
  resolvePluginStateExpiresAtMs,
  selectPluginStateEntry,
  upsertPluginStateEntry,
  type PluginStateDatabase,
} from "./plugin-state-store.kernel.js";
import {
  PluginStateStoreError,
  type PluginStateStoreErrorCode,
  type PluginStateStoreOperation,
  type PluginStateStoreProbeResult,
  type PluginStateStoreProbeStep,
} from "./plugin-state-store.types.js";
export function wrapPluginStateError(
  error: unknown,
  operation: PluginStateStoreOperation,
  fallbackCode: PluginStateStoreErrorCode,
  message: string,
  pathname = resolveOpenClawStateSqlitePath(process.env),
): PluginStateStoreError {
  if (error instanceof PluginStateStoreError) {
    return error;
  }
  let publicMessage = message;
  // Only owner-classified failures get public hints. Cause messages can contain
  // database paths, SQL, or stored values and must stay out of this message.
  if (fallbackCode === "PLUGIN_STATE_OPEN_FAILED") {
    if (isSqliteSchemaVersionError(error)) {
      publicMessage +=
        "\nThe state database uses a newer schema. Run an OpenClaw build that supports it.";
    } else if (error instanceof Error && isTerminalSqliteIntegrityError(error)) {
      publicMessage +=
        "\nDatabase integrity verification failed. Restore or repair the state database, then run openclaw doctor --fix.";
    }
  }
  return createPluginStateError({
    code: fallbackCode,
    operation,
    message: publicMessage,
    path: pathname,
    cause: error,
  });
}

export function openPluginStateDatabase(
  operation: PluginStateStoreOperation = "open",
  options: OpenClawStateDatabaseOptions = {},
): PluginStateDatabase {
  const env = options.env ?? process.env;
  const pathname = resolveOpenClawStateSqlitePath(env);
  try {
    return openOpenClawStateDatabase(options);
  } catch (error) {
    throw wrapPluginStateError(
      error,
      operation,
      "PLUGIN_STATE_OPEN_FAILED",
      "Failed to open the plugin state database.",
      pathname,
    );
  }
}

function isMissingPluginStateTableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    hasErrnoCode(error, "ERR_SQLITE_ERROR") &&
    error.message === "no such table: plugin_state_entries"
  );
}

/** Read plugin state without joining the shared writable database lifecycle. */
export function withPluginStateDatabaseReadOnly<T>(
  operationName: PluginStateStoreOperation,
  operation: (store: PluginStateDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T | undefined {
  const pathname = resolveDatabasePath(options);
  let operationStarted = false;
  try {
    return withExistingOpenClawStateDatabaseReadOnly(({ db, path }) => {
      operationStarted = true;
      try {
        return operation({ db, path });
      } catch (error) {
        if (isMissingPluginStateTableError(error)) {
          // The lease bootstrap creates exactly schema_meta + state_leases before the first write;
          // any other table means the missing plugin-state table is damage, not fresh state.
          if (!hasOpenClawStateTablesBeyondStartupCheckpoint(db)) {
            return undefined;
          }
        }
        throw error;
      }
    }, options);
  } catch (error) {
    if (!operationStarted) {
      throw wrapPluginStateError(
        error,
        operationName,
        "PLUGIN_STATE_OPEN_FAILED",
        "Failed to open the plugin state database.",
        pathname,
      );
    }
    throw error;
  }
}
export function runWriteTransaction<T>(
  operation: PluginStateStoreOperation,
  write: (store: PluginStateDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  // Only cold acquisition failures are open errors. A held owner's ownership or
  // transaction failure must remain a write error, with its callback supplying the handle.
  if (!isOpenClawStateDatabaseOpen(resolveOpenClawStateSqlitePath(options.env ?? process.env))) {
    openPluginStateDatabase(operation, options);
  }
  return runOpenClawStateWriteTransaction(write, options);
}
export function probePluginStateStore(): PluginStateStoreProbeResult {
  const databasePath = resolveOpenClawStateSqlitePath(process.env);
  const steps: PluginStateStoreProbeStep[] = [];
  const stateWasOpen = isOpenClawStateDatabaseOpen();

  const pushOk = (name: string) => steps.push({ name, ok: true });
  const pushFailure = (name: string, error: unknown) => {
    const wrapped =
      error instanceof PluginStateStoreError
        ? error
        : createPluginStateError({
            code: "PLUGIN_STATE_OPEN_FAILED",
            operation: "probe",
            message: error instanceof Error ? error.message : String(error),
            path: databasePath,
            cause: error,
          });
    steps.push({ name, ok: false, code: wrapped.code, message: wrapped.message });
  };

  try {
    requireNodeSqlite();
    pushOk("load-sqlite");
  } catch (error) {
    pushFailure(
      "load-sqlite",
      createPluginStateError({
        code: "PLUGIN_STATE_SQLITE_UNAVAILABLE",
        operation: "load-sqlite",
        message: "SQLite support is unavailable for plugin state storage.",
        path: databasePath,
        cause: error,
      }),
    );
    return { ok: false, databasePath, steps };
  }

  try {
    openPluginStateDatabase("probe");
    pushOk("open");
    pushOk("schema");
    runWriteTransaction("probe", ({ db }) => {
      const now = Date.now();
      const expiresAt = resolvePluginStateExpiresAtMs({
        ttlMs: 60_000,
        now,
        operation: "probe",
        path: databasePath,
      });
      upsertPluginStateEntry(
        db,
        bindPluginStateEntry({
          pluginId: "core:plugin-state-probe",
          namespace: "diagnostics",
          key: "probe",
          valueJson: JSON.stringify({ ok: true }),
          createdAt: now,
          expiresAt,
        }),
      );
      selectPluginStateEntry(db, {
        pluginId: "core:plugin-state-probe",
        namespace: "diagnostics",
        key: "probe",
        now,
      });
      deletePluginStateEntry(db, {
        pluginId: "core:plugin-state-probe",
        namespace: "diagnostics",
        key: "probe",
      });
    });
    pushOk("write-read-delete");
    openOpenClawStateDatabase().walMaintenance.checkpoint();
    pushOk("checkpoint");
  } catch (error) {
    pushFailure("probe", error);
  } finally {
    if (!stateWasOpen) {
      closeOpenClawStateDatabase();
    }
  }

  return { ok: steps.every((step) => step.ok), databasePath, steps };
}
