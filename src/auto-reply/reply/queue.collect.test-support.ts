import { createDeferred } from "../../../test/helpers/promise.js";
import { isModelExecutionSelection } from "../../model-picker/execution-selection.js";
import {
  enqueueFollowupRun,
  scheduleFollowupDrain,
  type FollowupRun,
  type QueueSettings,
} from "./queue.js";
import { createQueueTestRun as createRun } from "./queue.test-helpers.js";
function createQueueSettings(overrides: Partial<QueueSettings> = {}): QueueSettings {
  return {
    mode: "collect",
    debounceMs: 0,
    cap: 50,
    dropPolicy: "summarize",
    ...overrides,
  };
}

function concreteSelection(run: FollowupRun["run"]) {
  if (!isModelExecutionSelection(run.executionSelection)) {
    throw new Error("Expected a concrete queue fixture selection.");
  }
  return run.executionSelection;
}

type TestRunOverrides = Partial<FollowupRun["run"]> & { provider?: string; model?: string };
function applyRunOverrides(
  run: FollowupRun["run"],
  overrides: TestRunOverrides,
): FollowupRun["run"] {
  const { provider, model, ...fields } = overrides;
  if (fields.executionSelection || (provider === undefined && model === undefined)) {
    return { ...run, ...fields };
  }
  return {
    ...run,
    ...fields,
    executionSelection: {
      ...concreteSelection(run),
      model: {
        provider: provider ?? concreteSelection(run).model.provider,
        id: model ?? concreteSelection(run).model.id,
      },
    },
  };
}

function enqueueTestRun(
  key: string,
  params: Parameters<typeof createRun>[0],
  settings: QueueSettings,
  runOverrides?: TestRunOverrides,
) {
  const run = createRun(params);
  if (runOverrides) {
    run.run = applyRunOverrides(run.run, runOverrides);
  }
  return enqueueFollowupRun(key, run, settings);
}

function enqueueSlackRun(
  key: string,
  settings: QueueSettings,
  prompt: string,
  runOverrides: TestRunOverrides,
  routeOverrides: Partial<Parameters<typeof createRun>[0]> = {},
) {
  return enqueueTestRun(
    key,
    { prompt, originatingChannel: "slack", originatingTo: "channel:A", ...routeOverrides },
    settings,
    runOverrides,
  );
}

function createDrainRecorder(expectedCalls = 1) {
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

function createQueueCase(key: string, overrides: Partial<QueueSettings> = {}, expectedCalls = 1) {
  return { key, ...createDrainRecorder(expectedCalls), settings: createQueueSettings(overrides) };
}

function enqueueTestRuns(
  key: string,
  settings: QueueSettings,
  ...runs: Parameters<typeof createRun>[0][]
) {
  for (const run of runs) {
    enqueueTestRun(key, run, settings);
  }
}

function enqueueRoutedRuns(
  key: string,
  settings: QueueSettings,
  route: Omit<Parameters<typeof createRun>[0], "prompt">,
  ...prompts: string[]
) {
  for (const prompt of prompts) {
    enqueueTestRun(key, { prompt, ...route }, settings);
  }
}

async function drainRecordedQueue(
  key: string,
  runFollowup: ReturnType<typeof createDrainRecorder>["runFollowup"],
  done: ReturnType<typeof createDrainRecorder>["done"],
) {
  scheduleFollowupDrain(key, runFollowup);
  await done.promise;
}

export {
  applyRunOverrides,
  concreteSelection,
  createDrainRecorder,
  createQueueCase,
  createQueueSettings,
  drainRecordedQueue,
  enqueueRoutedRuns,
  enqueueSlackRun,
  enqueueTestRun,
  enqueueTestRuns,
  type TestRunOverrides,
};
