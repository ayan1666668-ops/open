import type { MatrixMessageWireDispatchGuards } from "./message-wire-dispatch.js";
import type { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import { createMatrixGuardedFetch } from "./transport.js";

export function createMatrixClientFetch(
  params: Omit<
    Parameters<typeof createMatrixGuardedFetch>[0],
    "assertBeforeSend" | "beforeRequest"
  > & {
    recoveryKeyStore: Pick<MatrixRecoveryKeyStore, "drainPendingPersistence">;
    messageWireDispatchGuards: MatrixMessageWireDispatchGuards;
  },
): typeof fetch {
  return createMatrixGuardedFetch({
    ...params,
    assertBeforeSend: (resource, init) =>
      params.messageWireDispatchGuards.assertBeforeRequest(resource, init),
    beforeRequest: async (resource, init) => {
      // Complete admitted key persistence before checking live wire authority.
      await params.recoveryKeyStore.drainPendingPersistence();
      await params.messageWireDispatchGuards.beforeRequest(resource, init);
    },
  });
}
