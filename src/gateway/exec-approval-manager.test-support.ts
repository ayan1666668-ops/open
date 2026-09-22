import { randomUUID } from "node:crypto";
import path from "node:path";
import { vi, type TestContext } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import type { ExecApprovalManagerOptions } from "./exec-approval-manager.types.js";
import * as operatorApprovalStore from "./operator-approval-store.js";

const testCleanups = new WeakMap<TestContext["task"], Array<() => Promise<void>>>();

/** Reset owners must join fixture work before changing registries, mocks, or stores. */
export async function cleanupTestApprovalFixtures(test: TestContext): Promise<void> {
  const results = await Promise.allSettled(
    (testCleanups.get(test.task) ?? []).map((close) => close()),
  );
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) {
    throw new AggregateError(errors, "Approval fixture cleanup failed");
  }
}

/** Vitest clocks are process-local; send controlled time through the store's existing input. */
export function installTestApprovalClock(): (() => void) | undefined {
  const forceDeny = operatorApprovalStore.forceDenyOperatorApproval;
  if (vi.isMockFunction(forceDeny)) {
    return undefined;
  }
  const spy = vi
    .spyOn(operatorApprovalStore, "forceDenyOperatorApproval")
    .mockImplementation((params) => {
      if (params.nowMs === undefined && (vi.isFakeTimers() || vi.isMockFunction(Date.now))) {
        return forceDeny({ ...params, nowMs: Date.now() });
      }
      return forceDeny(params);
    });
  return () => spy.mockRestore();
}

/** Each manager owns a real store, including when two managers reuse an approval id. */
export function createTestApprovalManager<TPayload = ExecApprovalRequestPayload>(
  test: TestContext,
  options: Omit<ExecApprovalManagerOptions<TPayload>, "persistence"> = {},
): ExecApprovalManager<TPayload> {
  return createTestApprovalFixture(test, options).manager;
}

/** Prepare the real worker before a request starts its approval deadline. */
export async function createPreparedTestApprovalManager<TPayload = ExecApprovalRequestPayload>(
  test: TestContext,
  options: Omit<ExecApprovalManagerOptions<TPayload>, "persistence"> = {},
) {
  const fixture = createTestApprovalFixture(test, options);
  await operatorApprovalStore.listPendingOperatorApprovals({
    databaseOptions: fixture.databaseOptions,
  });
  return fixture;
}

export function createTestApprovalFixture<TPayload = ExecApprovalRequestPayload>(
  test: TestContext,
  options: Omit<ExecApprovalManagerOptions<TPayload>, "persistence"> = {},
) {
  test.signal.throwIfAborted();
  const restoreClock = installTestApprovalClock();
  test.onTestFinished(() => restoreClock?.());
  const fixture = createFixtureLifetime();
  let manager: ExecApprovalManager<TPayload> | undefined;
  let databasePath: string | undefined = undefined;
  const requests: Promise<unknown>[] = [];
  let body: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  async function drainRequests() {
    try {
      await manager?.drain();
    } finally {
      // Manager retirement settles observers; their outer RPC/policy continuations
      // still own the database until they have unwound.
      await Promise.allSettled(requests);
    }
  }
  function cleanup(): Promise<void> {
    return (closing ??= (async () => {
      void fixture.verifyCleanup(async () => {
        await drainRequests();
        await Promise.allSettled([body]);
        if (databasePath) {
          await closeOpenClawStateDatabaseByPathAsync(databasePath);
        }
      });
      await fixture.cleanup();
    })());
  }
  // Vitest finishes hooks after afterEach. Both owners join the same cleanup,
  // including failed initialization, before either can release fixture inputs.
  const cleanups = testCleanups.get(test.task) ?? [];
  cleanups.push(cleanup);
  testCleanups.set(test.task, cleanups);
  test.onTestFinished(cleanup);
  const root = fixture.createTempDir("openclaw-test-approval-");
  databasePath = path.join(root, "state.sqlite");
  const databaseOptions = {
    path: databasePath,
    env: { ...process.env, OPENCLAW_STATE_DIR: root },
  };
  // Schema setup precedes the request's existing deadline, as at Gateway startup.
  try {
    openOpenClawStateDatabase(databaseOptions);
    manager = new ExecApprovalManager<TPayload>({
      ...options,
      persistence: { runtimeEpoch: randomUUID(), databaseOptions },
    });
    return {
      manager,
      databaseOptions,
      cleanup,
      track: <T>(request: Promise<T>) => {
        requests.push(request);
        void request.catch(() => {});
        return request;
      },
      run: <T>(callback: () => Promise<T>) => {
        const work = fixture.run(() => runQaGatewayFixture(callback, drainRequests));
        body = work;
        return work;
      },
    };
  } catch (error) {
    // A failed open can include failed closure of an unpublished handle.
    // Retain its inputs rather than certify cleanup from an empty cache.
    void fixture.track(
      Promise.reject(new Error("Approval fixture initialization failed", { cause: error })),
      true,
    );
    throw error;
  }
}
