import type { bindDeliveryQueueEntry } from "./delivery-queue-sqlite-bound.js";
import type { DeliveryQueueEntryLoadResult } from "./delivery-queue-sqlite-codec.js";
import type { DeliveryQueueStoredStatus } from "./delivery-queue-sqlite.kernel.js";

export type SessionDeliveryAgentRunUpdate = {
  expectedMediaUrls?: string[];
  message?: string;
  suppressTextDelivery?: boolean;
};

type PreparedEntry = ReturnType<typeof bindDeliveryQueueEntry>;

export type SessionDeliveryWorkerOperations = {
  "sessionDelivery.enqueue": { input: PreparedEntry; output: void };
  "sessionDelivery.enqueueClaimed": {
    input: PreparedEntry;
    output: { id: string; claimed: boolean; status: DeliveryQueueStoredStatus };
  };
  "sessionDelivery.releaseClaim": { input: { id: string }; output: void };
  "sessionDelivery.defer": { input: { id: string; delayMs: number }; output: void };
  "sessionDelivery.advanceAgentRun": {
    input: { id: string; updates?: SessionDeliveryAgentRunUpdate };
    output: void;
  };
  "sessionDelivery.mergePreparedMedia": {
    input: { id: string; mediaUrl: string; blocksJson: string };
    output: { source: "input" } | { source: "stored"; blocks: Array<Record<string, unknown>> };
  };
  "sessionDelivery.markAttemptStarted": { input: PreparedEntry; output: void };
  "sessionDelivery.markSettlement": { input: PreparedEntry; output: void };
  "sessionDelivery.complete": { input: { id: string }; output: void };
  "sessionDelivery.fail": {
    input: { id: string; error: string; releaseAttemptOwnership?: boolean };
    output: void;
  };
  "sessionDelivery.failInvalid": {
    input: {
      entry: { id: string; enqueuedAt: number; retryCount: number };
      error: string;
      entryJson: string;
    };
    output: void;
  };
  "sessionDelivery.load": { input: { id: string }; output: DeliveryQueueEntryLoadResult | null };
  "sessionDelivery.list": { input: undefined; output: DeliveryQueueEntryLoadResult[] };
  "sessionDelivery.moveToFailed": { input: { id: string }; output: void };
};
