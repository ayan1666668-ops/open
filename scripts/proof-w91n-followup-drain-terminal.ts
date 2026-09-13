// Real-runtime proof for the bounded followup-drain terminal path.
//
// Run: pnpm tsx scripts/proof-w91n-followup-drain-terminal.ts
//
// No vitest, no mocks of the seam under test. The real
// `enqueueFollowupRun` / `scheduleFollowupDrain` / `FOLLOWUP_QUEUES` registry and
// the real Gateway work-admission fence drive every scenario, with the shipped
// retry policy (no timing overrides), so the wall-clock cost of scenario 1 is
// the production backoff ladder itself. Only `defaultRuntime.error` is captured,
// at the logging edge, so the terminal message can be asserted.
//
// Scenarios:
//   1. An item whose run throws the non-retriable authority error is retried a
//      bounded number of times, then retired with one loud terminal error, and
//      the loop stops.
//   2. A deferred item still retries past the unclassified cap and succeeds.
//   3. The Gateway restart fence still parks the drain instead of retiring it.

import type { FollowupRun, QueueSettings } from "../src/auto-reply/reply/queue.js";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  FollowupRunDeferredError,
  scheduleFollowupDrain,
} from "../src/auto-reply/reply/queue.js";
import { FOLLOWUP_QUEUES } from "../src/auto-reply/reply/queue/state.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  beginGatewayRestartSignalAdmission,
  GatewayDrainingError,
  resetGatewayWorkAdmission,
} from "../src/process/gateway-work-admission.js";
import { defaultRuntime } from "../src/runtime.js";

const SETTINGS: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
const AUTHORITY_ERROR = "Reply operation cannot change tool authority after admission";

/** Shipped policy in src/auto-reply/reply/queue/drain.ts. Kept in sync by assertion. */
const EXPECTED_MAX_CONSECUTIVE_FAILURES = 7;
const EXPECTED_BACKOFF_LADDER_MS = [500, 1000, 2000, 4000, 8000, 10_000];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

function createRun(prompt: string, messageId: string): FollowupRun {
  return {
    prompt,
    messageId,
    enqueuedAt: Date.now(),
    originatingChannel: "slack",
    originatingTo: "proof-channel",
    run: {
      agentId: "agent",
      agentDir: "/tmp",
      sessionId: "sess",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp",
      config: {} as OpenClawConfig,
      provider: "openai",
      model: "gpt-test",
      timeoutMs: 10_000,
      blockReplyBreak: "text_end",
    },
  };
}

const capturedErrors: string[] = [];
const realRuntimeError = defaultRuntime.error;
defaultRuntime.error = ((message: unknown) => {
  capturedErrors.push(String(message));
}) as typeof defaultRuntime.error;

function restoreRuntimeError(): void {
  defaultRuntime.error = realRuntimeError;
}

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitFor(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`ASSERTION FAILED: timed out after ${timeoutMs}ms waiting for ${label}`);
}

async function scenarioBoundedRetirement(): Promise<void> {
  const key = `proof-w91n-terminal-${Date.now()}`;
  capturedErrors.length = 0;
  let attempts = 0;
  const attemptTimestamps: number[] = [];
  const runFollowup = async (): Promise<void> => {
    attempts += 1;
    attemptTimestamps.push(Date.now());
    throw new Error(AUTHORITY_ERROR);
  };

  const expectedLadderMs = EXPECTED_BACKOFF_LADDER_MS.reduce((sum, ms) => sum + ms, 0);
  console.log(
    `[1/3] wedged item: expecting ${EXPECTED_MAX_CONSECUTIVE_FAILURES} attempts over ~${Math.round(expectedLadderMs / 1000)}s of production backoff...`,
  );
  const startedAt = Date.now();
  enqueueFollowupRun(key, createRun("wedged", "proof-m1"), SETTINGS);
  scheduleFollowupDrain(key, runFollowup);

  await waitFor(
    () => !FOLLOWUP_QUEUES.has(key),
    "the wedged queue to be retired",
    expectedLadderMs + 30_000,
  );
  const elapsedMs = Date.now() - startedAt;
  const attemptsAtRetirement = attempts;
  // The loop must be dead, not merely slow: a further settle window adds nothing.
  await sleep(2_000);

  assert(
    attemptsAtRetirement === EXPECTED_MAX_CONSECUTIVE_FAILURES,
    `expected exactly ${EXPECTED_MAX_CONSECUTIVE_FAILURES} attempts before retirement, saw ${attemptsAtRetirement}`,
  );
  assert(
    attempts === attemptsAtRetirement,
    `expected the drain loop to stop after retirement, saw ${attempts - attemptsAtRetirement} extra attempts`,
  );
  assert(!FOLLOWUP_QUEUES.has(key), "expected the wedged queue to be removed from the registry");

  const gaps = attemptTimestamps
    .slice(1)
    .map((timestamp, index) => timestamp - (attemptTimestamps[index] ?? timestamp));
  assert(
    gaps.length === EXPECTED_BACKOFF_LADDER_MS.length,
    `expected ${EXPECTED_BACKOFF_LADDER_MS.length} inter-attempt gaps, saw ${gaps.length}`,
  );
  for (const [index, gap] of gaps.entries()) {
    const expected = EXPECTED_BACKOFF_LADDER_MS[index] ?? 0;
    assert(
      gap >= expected * 0.8,
      `expected retry ${index + 1} to wait at least ${expected}ms of backoff, waited ${gap}ms — the storm is not bounded`,
    );
  }

  const terminal = capturedErrors.filter((message) =>
    message.includes("followup queue retired undeliverable work"),
  );
  assert(terminal.length === 1, `expected exactly one terminal error, saw ${terminal.length}`);
  const [terminalMessage] = terminal;
  assert(terminalMessage?.includes(key) === true, "terminal error must name the session key");
  assert(
    terminalMessage?.includes("messageId=proof-m1") === true,
    "terminal error must identify the retired item",
  );
  assert(
    terminalMessage?.includes(AUTHORITY_ERROR) === true,
    "terminal error must carry the final underlying error",
  );
  console.log(
    `      ok: ${attempts} attempts, gaps ${gaps.join("/")}ms, retired after ${(elapsedMs / 1000).toFixed(1)}s`,
  );
  console.log(`      terminal log: ${terminalMessage}`);
}

async function scenarioDeferredStillRetries(): Promise<void> {
  const key = `proof-w91n-deferred-${Date.now()}`;
  capturedErrors.length = 0;
  const deferrals = EXPECTED_MAX_CONSECUTIVE_FAILURES + 3;
  let attempts = 0;
  let delivered = false;
  const runFollowup = async (): Promise<void> => {
    attempts += 1;
    if (attempts <= deferrals) {
      throw new FollowupRunDeferredError("proof: agent still busy");
    }
    delivered = true;
  };

  console.log(
    `[2/3] deferred item: expecting ${deferrals} deferrals (past the ${EXPECTED_MAX_CONSECUTIVE_FAILURES}-failure cap) then delivery...`,
  );
  enqueueFollowupRun(key, createRun("deferred", "proof-m2"), SETTINGS);
  scheduleFollowupDrain(key, runFollowup);

  await waitFor(() => delivered, "the deferred item to be delivered", 30_000);
  assert(
    attempts === deferrals + 1,
    `expected ${deferrals + 1} attempts, saw ${attempts} — deferred retries must stay unbounded`,
  );
  assert(
    !capturedErrors.some((message) =>
      message.includes("followup queue retired undeliverable work"),
    ),
    "a deferred item must never be retired",
  );
  console.log(`      ok: ${attempts} attempts, delivered, nothing retired`);
}

async function scenarioRestartFenceParks(): Promise<void> {
  const key = `proof-w91n-fence-${Date.now()}`;
  capturedErrors.length = 0;
  resetGatewayWorkAdmission();
  let attempts = 0;
  let delivered = false;
  let fenceLease: { rollback: () => boolean } | null = null;
  const runFollowup = async (): Promise<void> => {
    attempts += 1;
    if (attempts === 1) {
      fenceLease = beginGatewayRestartSignalAdmission();
      assert(fenceLease !== null, "expected to raise a reversible restart-signal fence");
      throw new GatewayDrainingError("proof: gateway restart signalled");
    }
    delivered = true;
  };

  console.log("[3/3] restart fence: expecting the drain to park, not retire...");
  enqueueFollowupRun(key, createRun("fenced", "proof-m3"), SETTINGS);
  scheduleFollowupDrain(key, runFollowup);

  await waitFor(() => attempts === 1, "the first fenced attempt", 10_000);
  await sleep(3_000);
  const attemptsWhileParked = attempts;
  assert(
    attemptsWhileParked === 1,
    `expected the drain to park on the fence, saw ${attemptsWhileParked} attempts`,
  );
  assert(FOLLOWUP_QUEUES.has(key), "expected the fenced item to stay queued");
  assert(
    !capturedErrors.some((message) =>
      message.includes("followup queue retired undeliverable work"),
    ),
    "a fenced item must never be retired",
  );

  const lease = fenceLease as { rollback: () => boolean } | null;
  assert(lease !== null, "expected a fence lease to roll back");
  assert(lease.rollback(), "expected the restart-signal fence to roll back");
  await waitFor(() => delivered, "the fenced item to drain after rollback", 30_000);
  assert(attempts === 2, `expected 2 attempts after rollback, saw ${attempts}`);
  console.log("      ok: parked on the fence, then delivered after rollback");
}

async function main(): Promise<void> {
  // Unref'd backoff timers must not be the only thing holding the loop open.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await scenarioBoundedRetirement();
    await scenarioDeferredStillRetries();
    await scenarioRestartFenceParks();
  } finally {
    clearInterval(keepAlive);
    clearSessionQueues([...FOLLOWUP_QUEUES.keys()]);
    resetGatewayWorkAdmission();
    restoreRuntimeError();
  }
  console.log("All runtime assertions passed.");
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    restoreRuntimeError();
    console.error(String(error));
    process.exit(1);
  },
);
