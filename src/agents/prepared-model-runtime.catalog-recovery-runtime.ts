import {
  recoverPreparedModelRuntimeCatalogWorker,
  replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch,
} from "./prepared-model-runtime.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";

type CatalogWorkerBorrower = {
  agentDir: string;
  isCurrent: () => boolean;
};

export async function recoverPreparedModelRuntimeCatalogWorkerAtRuntime(
  borrowers: readonly CatalogWorkerBorrower[],
): Promise<void> {
  await recoverPreparedModelRuntimeCatalogWorker(borrowers);
}

export async function replacePreparedModelRuntimeSnapshotAtRuntime(
  snapshot: PreparedModelRuntimeSnapshot,
): Promise<boolean> {
  return await replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(snapshot);
}
