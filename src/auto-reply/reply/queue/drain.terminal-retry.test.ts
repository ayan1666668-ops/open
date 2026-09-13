// Regression: the drain reschedule tail treated every unclassified error as
// retriable. `drainNextQueueItem` restores the failing item to the head of the
// queue, so an error that can never clear (e.g. a reply operation that refuses
// to rebind tool authority after admission) made the `finally` tail call
// `scheduleFollowupDrain` again immediately, replaying the identical failure at
// debounce speed forever. A live Gateway logged the same drain failure ~2Hz for
// five hours against one session key.
//
// Post-fix: consecutive unclassified failures are counted per queue key, the
// retry is spaced by exponential backoff, and past the cap the head item is
// retired (removeQueuedItemsByRef + completeFollowupRunLifecycle, the
// dropAbortedFollowups precedent) with one loud terminal error.
//
// No module mocks: real enqueueFollowupRun / scheduleFollowupDrain / FOLLOWUP_QUEUES.
// Only the retry policy timings are shrunk, through the queue drain test API, so
// the suite does not wait real seconds for the backoff ladder.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRuntime } from "../../../runtime.js";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  FollowupRunDeferredError,
  scheduleFollowupDrain,
} from "../queue.js";
import { createQueueTestRun as createRun } from "../queue.test-helpers.js";
import {
  readFollowupDrainFailureCount,
  resetFollowupDrainFailureCounts,
  resetFollowupDrainRetryPolicy,
  setFollowupDrainRetryPolicy,
} from "./drain.test-support.js";
import { FOLLOWUP_QUEUES } from "./state.js";
import type { QueueSettings } from "./types.js";

const MAX_CONSECUTIVE_FAILURES = 3;
const SETTINGS: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("followup drain terminal path for unclassified errors", () => {
  const keysToCleanup: string[] = [];
  let errors: string[] = [];
  let previousRuntimeError: typeof defaultRuntime.error;

  beforeEach(() => {
    errors = [];
    previousRuntimeError = defaultRuntime.error;
    defaultRuntime.error = ((message: unknown) => {
      errors.push(String(message));
    }) as typeof defaultRuntime.error;
    resetFollowupDrainFailureCounts();
    setFollowupDrainRetryPolicy({
      baseDelayMs: 1,
      maxDelayMs: 2,
      maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
    });
  });

  afterEach(() => {
    resetFollowupDrainRetryPolicy();
    resetFollowupDrainFailureCounts();
    defaultRuntime.error = previousRuntimeError;
    if (keysToCleanup.length > 0) {
      clearSessionQueues(keysToCleanup.splice(0));
    }
  });

  it("retires the wedged head item after the consecutive-failure cap and stops retrying", async () => {
    const key = `test-drain-terminal-${Date.now()}-${Math.random()}`;
    keysToCleanup.push(key);
    let attempts = 0;
    const runFollowup = async () => {
      attempts += 1;
      throw new Error("Reply operation cannot change tool authority after admission");
    };

    enqueueFollowupRun(
      key,
      createRun({ prompt: "wedged", messageId: "m-wedged", originatingChannel: "slack" }),
      SETTINGS,
    );
    scheduleFollowupDrain(key, runFollowup);

    await waitFor(() => !FOLLOWUP_QUEUES.has(key), "the wedged queue to be retired");
    // The loop is dead: a settle window adds no further attempts.
    const attemptsAtRetirement = attempts;
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(attemptsAtRetirement).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(attempts).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(FOLLOWUP_QUEUES.has(key)).toBe(false);
    expect(readFollowupDrainFailureCount(key)).toBe(0);
    const terminal = errors.filter((message) =>
      message.includes("followup queue retired undeliverable work"),
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toContain(key);
    expect(terminal[0]).toContain("messageId=m-wedged");
    expect(terminal[0]).toContain("cannot change tool authority after admission");
    expect(terminal[0]).toContain(`after ${MAX_CONSECUTIVE_FAILURES} consecutive drain failures`);
  });

  it("retires only the wedged head item and drains the survivors behind it", async () => {
    const key = `test-drain-terminal-survivor-${Date.now()}-${Math.random()}`;
    keysToCleanup.push(key);
    const delivered: string[] = [];
    const runFollowup = async (run: { prompt: string }) => {
      if (run.prompt === "wedged") {
        throw new Error("permanent producer defect");
      }
      delivered.push(run.prompt);
    };

    enqueueFollowupRun(key, createRun({ prompt: "wedged", messageId: "m-1" }), SETTINGS);
    enqueueFollowupRun(key, createRun({ prompt: "survivor", messageId: "m-2" }), SETTINGS);
    scheduleFollowupDrain(key, runFollowup);

    await waitFor(() => delivered.length > 0, "the survivor item to drain");
    expect(delivered).toEqual(["survivor"]);
    expect(
      errors.some((message) => message.includes("followup queue retired undeliverable work")),
    ).toBe(true);
  });

  it("resets the consecutive-failure counter once a drain generation succeeds", async () => {
    const key = `test-drain-terminal-reset-${Date.now()}-${Math.random()}`;
    keysToCleanup.push(key);
    let attempts = 0;
    const runFollowup = async () => {
      attempts += 1;
      if (attempts <= MAX_CONSECUTIVE_FAILURES - 1) {
        throw new Error("transient producer defect");
      }
    };

    enqueueFollowupRun(key, createRun({ prompt: "transient", messageId: "m-t" }), SETTINGS);
    scheduleFollowupDrain(key, runFollowup);

    await waitFor(() => !FOLLOWUP_QUEUES.has(key), "the queue to drain");
    expect(attempts).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(readFollowupDrainFailureCount(key)).toBe(0);
    expect(
      errors.some((message) => message.includes("followup queue retired undeliverable work")),
    ).toBe(false);
  });

  it("leaves deferred retries unbounded", async () => {
    const key = `test-drain-terminal-deferred-${Date.now()}-${Math.random()}`;
    keysToCleanup.push(key);
    const deferredAttempts = MAX_CONSECUTIVE_FAILURES + 3;
    let attempts = 0;
    const runFollowup = async () => {
      attempts += 1;
      if (attempts <= deferredAttempts) {
        throw new FollowupRunDeferredError("still busy");
      }
    };

    enqueueFollowupRun(key, createRun({ prompt: "deferred", messageId: "m-d" }), SETTINGS);
    scheduleFollowupDrain(key, runFollowup);

    await waitFor(() => !FOLLOWUP_QUEUES.has(key), "the deferred queue to drain");
    expect(attempts).toBe(deferredAttempts + 1);
    expect(readFollowupDrainFailureCount(key)).toBe(0);
    expect(
      errors.some((message) => message.includes("followup queue retired undeliverable work")),
    ).toBe(false);
  });
});
