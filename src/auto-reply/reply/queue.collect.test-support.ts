import { createDeferred } from "../../../test/helpers/promise.js";
import {
  enqueueFollowupRun,
  scheduleFollowupDrain,
  type FollowupRun,
  type QueueSettings,
} from "./queue.js";
import { createQueueTestRun as createRun } from "./queue.test-helpers.js";

export function createQueueSettings(overrides: Partial<QueueSettings> = {}): QueueSettings {
  return {
    mode: "collect",
    debounceMs: 0,
    cap: 50,
    dropPolicy: "summarize",
    ...overrides,
  };
}

export function enqueueTestRun(
  key: string,
  params: Parameters<typeof createRun>[0],
  settings: QueueSettings,
  runOverrides?: Partial<FollowupRun["run"]>,
) {
  const run = createRun(params);
  if (runOverrides) {
    run.run = { ...run.run, ...runOverrides };
  }
  return enqueueFollowupRun(key, run, settings);
}

export function enqueueSlackRun(
  key: string,
  settings: QueueSettings,
  prompt: string,
  runOverrides: Partial<FollowupRun["run"]>,
  routeOverrides: Partial<Parameters<typeof createRun>[0]> = {},
) {
  return enqueueTestRun(
    key,
    { prompt, originatingChannel: "slack", originatingTo: "channel:A", ...routeOverrides },
    settings,
    runOverrides,
  );
}

export function createDrainRecorder(expectedCalls = 1) {
  const calls: Array<FollowupRun & { currentTurnImagesPrepared?: true }> = [];
  const done = createDeferred();
  const runFollowup = async (run: FollowupRun) => {
    calls.push(run);
    if (calls.length >= expectedCalls) {
      done.resolve();
    }
  };
  return { calls, done, runFollowup };
}

export function createQueueCase(
  key: string,
  overrides: Partial<QueueSettings> = {},
  expectedCalls = 1,
) {
  return { key, ...createDrainRecorder(expectedCalls), settings: createQueueSettings(overrides) };
}

export function enqueueTestRuns(
  key: string,
  settings: QueueSettings,
  ...runs: Parameters<typeof createRun>[0][]
) {
  for (const run of runs) {
    enqueueTestRun(key, run, settings);
  }
}

export function enqueueRoutedRuns(
  key: string,
  settings: QueueSettings,
  route: Omit<Parameters<typeof createRun>[0], "prompt">,
  ...prompts: string[]
) {
  for (const prompt of prompts) {
    enqueueTestRun(key, { prompt, ...route }, settings);
  }
}

export async function drainRecordedQueue(
  key: string,
  runFollowup: ReturnType<typeof createDrainRecorder>["runFollowup"],
  done: ReturnType<typeof createDrainRecorder>["done"],
) {
  scheduleFollowupDrain(key, runFollowup);
  await done.promise;
}
