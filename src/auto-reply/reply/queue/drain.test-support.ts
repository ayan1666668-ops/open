import "./drain.js";

type FollowupDrainRetryPolicy = {
  baseDelayMs: number;
  maxDelayMs: number;
  maxConsecutiveFailures: number;
};

type QueueDrainTestApi = {
  setFollowupDrainRetryPolicy(policy: Partial<FollowupDrainRetryPolicy>): void;
  resetFollowupDrainRetryPolicy(): void;
  readFollowupDrainFailureCount(key: string): number;
  resetFollowupDrainFailureCounts(): void;
};

function getTestApi(): QueueDrainTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.queueDrainTestApi")
  ];
  if (!api) {
    throw new Error("queue drain test API is unavailable");
  }
  return api as QueueDrainTestApi;
}

/** Shrink the unclassified-failure backoff so tests do not wait real seconds. */
export function setFollowupDrainRetryPolicy(policy: Partial<FollowupDrainRetryPolicy>): void {
  getTestApi().setFollowupDrainRetryPolicy(policy);
}

export function resetFollowupDrainRetryPolicy(): void {
  getTestApi().resetFollowupDrainRetryPolicy();
}

export function readFollowupDrainFailureCount(key: string): number {
  return getTestApi().readFollowupDrainFailureCount(key);
}

export function resetFollowupDrainFailureCounts(): void {
  getTestApi().resetFollowupDrainFailureCounts();
}
