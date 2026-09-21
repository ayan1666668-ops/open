import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { transitionOwnedDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite-claim.kernel.js";
import {
  getDeliveryQueueEntriesOwnersInDatabase,
  upsertDeliveryQueueEntryInDatabase,
} from "../delivery-queue-sqlite.kernel.js";
import {
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
} from "./delivery-queue-namespaces.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";

/** Restore the exact pre-attempt row while its original owner still holds custody. */
export function restoreDeliveryAttemptBeforeDispatchInDatabase(
  database: OpenClawStateDatabase,
  entry: QueuedDelivery,
  reservedAttemptCount: number,
  claimedAttemptId?: string,
): void {
  const restored = transitionOwnedDeliveryQueueEntryInDatabase(
    database,
    {
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      id: entry.id,
      platformSendAttemptId: claimedAttemptId ?? null,
    },
    (currentRow) => {
      // SAFETY: The claimed pending row belongs to the prepared outbound namespace.
      const current = currentRow as QueuedDelivery;
      if (current.attemptCount !== reservedAttemptCount) {
        throw new Error(`Delivery attempt reservation changed before rollback: ${entry.id}`);
      }
      const restoredEntry: QueuedDelivery = {
        ...current,
        attemptCount: entry.attemptCount,
        availableAt: entry.availableAt,
        producerClaimId: entry.producerClaimId,
        platformSendAttemptId: entry.platformSendAttemptId,
        platformSendStartedAt: entry.platformSendStartedAt,
        effectiveReplyToId: entry.effectiveReplyToId,
        recoveryState: entry.recoveryState,
      };
      upsertDeliveryQueueEntryInDatabase(
        {
          queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
          entry: restoredEntry,
        },
        database,
      );
    },
  );
  if (!restored) {
    throw new Error(`Delivery platform claim was lost: ${entry.id}`);
  }
}

const OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS = [
  { queueName: OUTBOUND_DELIVERY_QUEUE_NAME, namespace: "prepared", retired: false },
  { queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME, namespace: "preparing", retired: true },
  { queueName: OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME, namespace: "migration", retired: true },
  {
    queueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
    namespace: "legacy-preparing",
    retired: true,
  },
  { queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, namespace: "legacy", retired: true },
] as const;

export function findDeliveryIntentOwnersInDatabase(
  database: OpenClawStateDatabase,
  params: { ids: readonly string[] },
) {
  const owners = getDeliveryQueueEntriesOwnersInDatabase(
    database,
    OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS.map(({ queueName }) => queueName),
    params.ids,
  );
  return params.ids.map((id) => {
    const namespaces = owners.get(id);
    for (const descriptor of OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS) {
      const owner = namespaces?.get(descriptor.queueName);
      if (owner) {
        return { ...descriptor, ...owner };
      }
    }
    return null;
  });
}
