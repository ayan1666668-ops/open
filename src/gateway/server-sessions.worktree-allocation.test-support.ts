import { vi } from "vitest";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";

export function holdWorktreeAllocation() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const operationEntered = createDeferredCore();
  // The same capacity lease serializes real worktree create, remove, and restore operations.
  const allocation = withOpenClawStateLease(
    {
      scope: "core:managed-worktrees:create",
      key: "capacity",
      database: { scope: "shared" },
      leaseMs: 60_000,
      waitMs: 5_000,
    },
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  const originalRemove = managedWorktrees.remove.bind(managedWorktrees);
  const originalRestore = managedWorktrees.restore.bind(managedWorktrees);
  const remove = vi.spyOn(managedWorktrees, "remove").mockImplementation((params) => {
    operationEntered.resolve();
    return originalRemove(params);
  });
  const restore = vi.spyOn(managedWorktrees, "restore").mockImplementation((params) => {
    operationEntered.resolve();
    return originalRestore(params);
  });
  return { entered, release, operationEntered, allocation, remove, restore };
}
