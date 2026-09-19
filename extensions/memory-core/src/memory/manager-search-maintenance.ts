// Memory Core owns detached search-time index maintenance lifecycle.
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { MemoryIndexRevisionConflictError } from "./manager-db-kernel.js";

type MemorySearchMaintenanceManager<DirtyGeneration> = {
  adoptReindexRetryState(generation: DirtyGeneration): void;
  takeReindexRetryStateForMaintenance(): DirtyGeneration;
  sync(params: { reason: string }): Promise<void>;
  status(): { dirty?: boolean; lastSyncError?: string };
  close(): Promise<void>;
};

export async function runMemorySearchMaintenance<DirtyGeneration>(params: {
  reason: string;
  takeDirtyGeneration: () => DirtyGeneration;
  restoreDirtyGeneration: (generation: DirtyGeneration) => void;
  acquireManager: () => Promise<MemorySearchMaintenanceManager<DirtyGeneration> | null>;
}): Promise<string | undefined> {
  const dirtyGeneration = params.takeDirtyGeneration();
  let manager: MemorySearchMaintenanceManager<DirtyGeneration> | null;
  try {
    manager = await params.acquireManager();
  } catch (err) {
    params.restoreDirtyGeneration(dirtyGeneration);
    throw toErrorObject(err, "Memory search maintenance manager acquisition failed");
  }
  if (!manager) {
    params.restoreDirtyGeneration(dirtyGeneration);
    return undefined;
  }

  let maintenanceError: Error | undefined;
  let incompleteReason: string | undefined;
  try {
    // The transient manager owns exactly this handed-off generation, merged with
    // its initial repair state. Full-retry flags still select rebuilds in runSync.
    manager.adoptReindexRetryState(dirtyGeneration);
    try {
      await manager.sync({ reason: params.reason });
    } catch (err) {
      if (!(err instanceof MemoryIndexRevisionConflictError)) {
        throw err;
      }
      // Retry only this automatic generation. The failed sync released its reindex
      // lease, and the next shadow build starts from the newest live revision.
      await manager.sync({ reason: params.reason });
    }
    const status = manager.status();
    if (status.dirty === true) {
      // Return remaining work, including edits skipped by a completed full rebuild.
      params.restoreDirtyGeneration(manager.takeReindexRetryStateForMaintenance());
      incompleteReason = status.lastSyncError;
    }
  } catch (err) {
    params.restoreDirtyGeneration(dirtyGeneration);
    maintenanceError = toErrorObject(err, "Memory search maintenance failed");
  }
  try {
    await manager.close();
  } catch (err) {
    maintenanceError ??= toErrorObject(err, "Memory search maintenance close failed");
  }
  if (maintenanceError) {
    throw maintenanceError;
  }
  return incompleteReason;
}

/** Await writer publication and retirement before a retained reader queries. */
export async function runMemorySearchRefresh<T extends { close(): Promise<void> }>(params: {
  signal?: AbortSignal;
  acquireManager: () => Promise<T | null>;
  refresh: (manager: T) => Promise<void>;
  retainForCleanup: (manager: T) => void;
}): Promise<void> {
  params.signal?.throwIfAborted();
  // Registry acquisition declines during teardown instead of waiting on this reader.
  const manager = await params.acquireManager();
  if (!manager) {
    throw new Error("Memory search refresh unavailable during teardown");
  }
  try {
    params.signal?.throwIfAborted();
    await params.refresh(manager);
    params.signal?.throwIfAborted();
  } finally {
    // Cancellation cannot release accepted native work or failed cleanup custody.
    await manager.close().catch((error: unknown) => {
      params.retainForCleanup(manager);
      throw error;
    });
  }
}
