import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

type Request = {
  input: unknown;
  taskId: number;
  nativeSections: SharedArrayBuffer;
};
type Resource = { close: () => Promise<void>; agentId?: string; revoke?: () => void };
const observed = vi.hoisted(() => ({
  handler: undefined as ((input: unknown) => unknown) | undefined,
  receive: undefined as ((message: Request) => void) | undefined,
  post: vi.fn<(message: unknown) => void>(),
  read: vi.fn<() => unknown>(),
  close: vi.fn<() => void>(),
  run: vi.fn<() => Promise<unknown>>(),
  closeResources: vi.fn<(key?: string) => Promise<void>>(),
  rotate: vi.fn<() => Promise<void>>(),
  unregister: vi.fn<() => void>(),
  resources: [] as Resource[],
  nativeWorker: vi.fn(() => {
    throw new Error("Native workers are forbidden in these pure controls");
  }),
}));

vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: observed.nativeWorker,
  parentPort: {
    on: (_event: string, receive: (message: Request) => void) => {
      observed.receive = receive;
    },
    postMessage: (message: unknown) => observed.post(message),
  },
}));
vi.mock("../../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/session-history.worker.mjs"),
  resolveRuntimeWorkerArgv: () => [],
  resolveRuntimeWorkerThreadExecArgv: () => [],
}));
vi.mock("../../infra/worker-task-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/worker-task-pool.js")>();
  return {
    ...actual,
    createOwnedWorkerTaskPool: () => ({
      run(prepare: () => unknown) {
        prepare();
        return observed.run();
      },
      rotate: observed.rotate,
      closeResources: observed.closeResources,
    }),
    WorkerTaskPool: class {
      run(prepare: () => unknown) {
        prepare();
        return observed.run();
      }
      rotate() {
        return observed.rotate();
      }
    },
  };
});
vi.mock("../../infra/worker-task-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/worker-task-server.js")>();
  return {
    ...actual,
    serveOwnedWorkerTasks: (handler: (input: unknown) => unknown) => {
      observed.handler = handler;
      actual.serveOwnedWorkerTasks(handler);
    },
  };
});
vi.mock("../../state/openclaw-agent-db-resources.js", () => ({
  matchesAgentDatabaseReadCandidatePath: (candidate: { path: string }, path: string) =>
    candidate.path === path,
  registerOpenClawAgentDatabaseReadCandidateResource: (resource: Resource) => {
    observed.resources.push(resource);
    return observed.unregister;
  },
  registerOpenClawAgentDatabaseAsyncResource: (resource: Resource) => {
    observed.resources.push(resource);
    return observed.unregister;
  },
}));
vi.mock("../../state/openclaw-agent-db-readonly-scope.js", () => ({
  closeOpenClawAgentDatabaseReadOnlyCandidates: vi.fn(),
  OpenClawAgentDatabaseReadOnlyScope: class {
    hasRetainedConnection = true;
    run(_database: unknown, operation: () => unknown) {
      return operation();
    }
    close() {
      observed.close();
    }
  },
}));
vi.mock("./session-accessor.sqlite-entry.js", () => ({
  loadSessionEntryReadOnlyInScope: () => observed.read(),
}));
vi.mock("./session-sharing-store.js", () => ({
  listSessionMembers: () => {
    throw new Error("Native membership reads are forbidden in these pure controls");
  },
}));

await import("./session-transcript.worker.js");
let sequence = 0;
function input() {
  const database = { agentId: "main", path: `/synthetic/session-read-errors-${++sequence}.sqlite` };
  return {
    kind: "session-row-presence",
    database,
    scope: {
      agentId: "main",
      databaseAgentId: "main",
      sessionKey: "agent:main:errors",
      storePath: database.path,
    },
  };
}
function invoke(request: ReturnType<typeof input>) {
  assert(observed.handler);
  return Promise.resolve(observed.handler(request));
}

beforeEach(() => {
  observed.post.mockReset();
  observed.read.mockReset();
  observed.close.mockReset();
  observed.run.mockReset();
  observed.rotate.mockReset().mockResolvedValue(undefined);
  observed.closeResources.mockReset().mockResolvedValue(undefined);
  observed.unregister.mockReset();
});
afterEach(async () => {
  observed.rotate.mockResolvedValue(undefined);
  await Promise.all(observed.resources.splice(0).map((resource) => resource.close()));
  expect(observed.nativeWorker).not.toHaveBeenCalled();
});

it("preserves the original worker read error when closing succeeds", async () => {
  const primary = new Error("read failed");
  observed.read.mockImplementation(() => {
    throw primary;
  });
  await expect(invoke(input())).rejects.toBe(primary);
  expect(observed.close).toHaveBeenCalledTimes(1);
});

it("retains both worker errors locally when the read and close fail", async () => {
  const primary = new Error("read failed");
  const cleanup = new Error("database close failed");
  observed.read.mockImplementation(() => {
    throw primary;
  });
  observed.close.mockImplementation(() => {
    throw cleanup;
  });
  const failure: unknown = await invoke(input()).catch((error: unknown) => error);
  assert(failure instanceof AggregateError);
  expect(failure.errors).toEqual([primary, cleanup]);
  expect(failure.cause).toBe(cleanup);
  expect(failure.message).toContain(primary.message);
  expect(failure.message).toContain(cleanup.message);
});

const typedFailures = [
  {
    error: new SessionTranscriptColdError("cold-session"),
    reply: { kind: "cold", sessionId: "cold-session" },
  },
  {
    error: new SessionTranscriptProjectionUnavailableError("projected-session"),
    reply: { kind: "projection", sessionId: "projected-session" },
  },
  {
    error: new SessionTranscriptReadFenceError("fence failed"),
    reply: { kind: "fence", message: "fence failed" },
  },
];
it.each(typedFailures)(
  "keeps typed $reply.kind recovery when closing succeeds",
  async ({ error, reply }) => {
    observed.read.mockImplementation(() => {
      throw error;
    });
    await expect(invoke(input())).resolves.toEqual({ ok: false, error: reply });
    expect(observed.close).toHaveBeenCalledTimes(1);
  },
);
it.each(typedFailures)(
  "does not recover typed $reply.kind reads when close also fails",
  async ({ error }) => {
    const cleanup = new Error("close failed");
    observed.read.mockImplementation(() => {
      throw error;
    });
    observed.close.mockImplementation(() => {
      throw cleanup;
    });
    const failure: unknown = await invoke(input()).catch((caught: unknown) => caught);
    assert(failure instanceof AggregateError);
    expect(failure.errors).toEqual([error, cleanup]);
  },
);

it("carries both failure messages through the existing worker response", async () => {
  const primary = new Error("primary read detail");
  const cleanup = new Error("close detail");
  observed.read.mockImplementation(() => {
    throw primary;
  });
  observed.close.mockImplementation(() => {
    throw cleanup;
  });
  const posted = createDeferredCore<unknown>();
  observed.post.mockImplementation(posted.resolve);
  assert(observed.receive);
  observed.receive({ input: input(), taskId: 7, nativeSections: new SharedArrayBuffer(4) });
  const reply = await posted.promise;
  expect(reply).toEqual({
    status: "failed",
    taskId: 7,
    error: expect.stringContaining(primary.message),
  });
  expect(reply).toMatchObject({ error: expect.stringContaining(cleanup.message) });
});

it("retires idle history workers under critical pressure after active scopes release custody", async () => {
  const pressure = channel("openclaw.memory.critical");
  const request = input();
  const retirement = createDeferredCore();
  const unregistered = createDeferredCore();
  observed.run.mockResolvedValue({ ok: true, value: false });
  observed.rotate.mockReturnValue(retirement.promise);
  observed.unregister.mockImplementation(unregistered.resolve);
  await withSessionHistoryWorkerDatabase(request.database, async (owner) => {
    expect(await owner.readEntryPresence(request.scope)).toBe(false);
    pressure.publish(undefined);
    expect(observed.rotate).not.toHaveBeenCalled();
  });

  pressure.publish(undefined);
  expect(observed.rotate).toHaveBeenCalledTimes(1);
  expect(observed.unregister).not.toHaveBeenCalled();
  pressure.publish(undefined);
  expect(observed.rotate).toHaveBeenCalledTimes(1);
  retirement.resolve();
  await unregistered.promise;
  expect(observed.unregister).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "awaits retirement and preserves both failures when retirement fails=%s",
  async (fails) => {
    const primary = new WorkerTaskError("worker response failed", "failed");
    const cleanup = new Error("retirement failed");
    const entered = createDeferredCore();
    const retirement = createDeferredCore();
    observed.run.mockRejectedValue(primary);
    observed.rotate.mockImplementation(() => {
      entered.resolve();
      return retirement.promise;
    });
    const request = input();
    let settled = false;
    const pending = withSessionHistoryWorkerDatabase(request.database, (owner) =>
      owner.readEntryPresence(request.scope),
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    expect(settled).toBe(false);
    expect(observed.unregister).not.toHaveBeenCalled();
    if (fails) {
      retirement.reject(cleanup);
    } else {
      retirement.resolve();
    }
    const failure: unknown = await pending;
    if (fails) {
      assert(failure instanceof AggregateError);
      expect(failure.errors).toEqual([primary, cleanup]);
      expect(failure.cause).toBe(cleanup);
      expect(failure.message).toContain(primary.message);
      expect(failure.message).toContain(cleanup.message);
      expect(observed.unregister).not.toHaveBeenCalled();
    } else {
      expect(failure).toBe(primary);
      expect(observed.unregister).toHaveBeenCalledTimes(1);
    }
  },
);

it.each(typedFailures)(
  "preserves typed $reply.kind errors after successful parent retirement",
  async ({ error, reply }) => {
    observed.run.mockResolvedValue({ ok: false, error: reply });
    const request = input();
    const failure: unknown = await withSessionHistoryWorkerDatabase(request.database, (owner) =>
      owner.readEntryPresence(request.scope),
    ).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(error.constructor);
    expect(failure).toMatchObject({ message: error.message });
    expect(observed.rotate).toHaveBeenCalledTimes(1);
  },
);

it.runIf(!process.versions.bun)(
  "retains aliases until native cleanup and preserves later read custody",
  async () => {
    const request = input();
    const candidates = [{ path: request.database.path, physicalPath: request.database.path }];
    const cleanupEntered = createDeferredCore();
    const cleanup = createDeferredCore();
    observed.run.mockResolvedValue({ ok: true, value: false });
    observed.closeResources.mockImplementation(() => {
      cleanupEntered.resolve();
      return cleanup.promise;
    });
    const discovery = withSessionHistoryWorkerReadCandidates(candidates, async (scope) => {
      observed.run.mockResolvedValueOnce({
        ok: true,
        value: {
          kind: "session-store-target",
          sourcePath: request.database.path,
          database: request.database,
        },
      });
      await scope.readStoreTarget({
        agentId: "main",
        storePath: request.database.path,
        candidates,
        env: {},
        registeredDatabases: [],
      });
      await withSessionHistoryWorkerDatabase(request.database, (owner) =>
        owner.readEntryPresence(request.scope),
      );
      candidates[0]!.physicalPath = "/synthetic/replacement.sqlite";
    });
    await cleanupEntered.promise;
    expect(observed.unregister).not.toHaveBeenCalled();
    expect(observed.rotate).not.toHaveBeenCalled();
    // This read is newer than the captured cleanup sequence, even on the same physical path.
    await withSessionHistoryWorkerDatabase(request.database, (owner) =>
      owner.readEntryPresence(request.scope),
    );
    cleanup.resolve();
    await discovery;
    expect(observed.closeResources).toHaveBeenCalledWith(
      JSON.stringify([{ path: request.database.path }]),
    );
    expect(observed.unregister).toHaveBeenCalledTimes(1);
    const retained = observed.resources.find((resource) => resource.agentId === "main");
    assert(retained);
    await retained.close();
    expect(observed.rotate).toHaveBeenCalledTimes(1);
  },
);

it.runIf(!process.versions.bun).each([false, true])(
  "joins candidate cleanup retirement and retains custody when retirement fails=%s",
  async (fails) => {
    const request = input();
    const candidates = [{ path: request.database.path, physicalPath: request.database.path }];
    const failure = new Error("candidate native close failed");
    const retirementEntered = createDeferredCore();
    const retirement = createDeferredCore();
    observed.run.mockResolvedValue({
      ok: true,
      value: {
        kind: "session-store-target",
        sourcePath: request.database.path,
        database: request.database,
      },
    });
    observed.closeResources.mockRejectedValue(failure);
    observed.rotate.mockImplementation(() => {
      retirementEntered.resolve();
      return retirement.promise;
    });
    const discovery = withSessionHistoryWorkerReadCandidates(candidates, async (scope) => {
      await scope.readStoreTarget({
        agentId: "main",
        storePath: request.database.path,
        candidates,
        env: {},
        registeredDatabases: [],
      });
    });
    const settled = discovery.catch((error: unknown) => error);
    await retirementEntered.promise;
    expect(observed.unregister).not.toHaveBeenCalled();
    if (fails) {
      const retirementFailure = new Error("candidate worker retirement failed");
      retirement.reject(retirementFailure);
      const error = await settled;
      assert(error instanceof AggregateError);
      expect(error.errors).toEqual([failure, retirementFailure]);
      expect(observed.unregister).not.toHaveBeenCalled();
    } else {
      retirement.resolve();
      expect(await settled).toBe(failure);
      expect(observed.unregister).toHaveBeenCalledTimes(1);
    }
  },
);

it("keeps native worker retirement for Bun candidate cleanup", async () => {
  const request = input();
  const candidates = [{ path: request.database.path, physicalPath: request.database.path }];
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
  if (!descriptor) {
    Object.defineProperty(process.versions, "bun", { value: "synthetic-bun", configurable: true });
  }
  observed.run.mockResolvedValue({
    ok: true,
    value: {
      kind: "session-store-target",
      sourcePath: request.database.path,
      database: request.database,
    },
  });
  try {
    await withSessionHistoryWorkerReadCandidates(candidates, async (scope) => {
      await scope.readStoreTarget({
        agentId: "main",
        storePath: request.database.path,
        candidates,
        env: {},
        registeredDatabases: [],
      });
    });
    expect(observed.closeResources).not.toHaveBeenCalled();
    expect(observed.rotate).toHaveBeenCalledTimes(1);
    expect(observed.unregister).toHaveBeenCalledTimes(1);
  } finally {
    if (!descriptor) {
      Reflect.deleteProperty(process.versions, "bun");
    }
  }
});

it("retires inventory workers when best-effort discovery reports a failed read", async () => {
  const request = input();
  const candidates = [{ path: request.database.path, physicalPath: request.database.path }];
  observed.run.mockResolvedValue({
    ok: true,
    value: {
      kind: "session-target-inventory",
      agents: [{ agentId: "main", result: { available: false, reason: "read-failed" }, reads: [] }],
    },
  });
  await withSessionHistoryWorkerReadCandidates(candidates, async (scope) => {
    await scope.readTargetInventory({
      config: {},
      agentIds: ["main"],
      env: {},
      paths: new Map(),
      candidates,
      registeredDatabases: [],
    });
  });
  expect(observed.closeResources).not.toHaveBeenCalled();
  expect(observed.rotate).toHaveBeenCalledTimes(1);
});

it.runIf(!process.versions.bun).each([false, true])(
  "keeps alias custody through overlapping retirement when retirement fails=%s",
  async (fails) => {
    const request = input();
    const candidates = [{ path: request.database.path, physicalPath: request.database.path }];
    const cleanupEntered = createDeferredCore();
    const cleanup = createDeferredCore();
    const retirementEntered = createDeferredCore();
    const retirement = createDeferredCore();
    observed.run.mockResolvedValue({
      ok: true,
      value: {
        kind: "session-store-target",
        sourcePath: request.database.path,
        database: request.database,
      },
    });
    observed.closeResources.mockImplementation(() => {
      cleanupEntered.resolve();
      return cleanup.promise;
    });
    observed.rotate.mockImplementation(() => {
      retirementEntered.resolve();
      return retirement.promise;
    });
    const discovery = withSessionHistoryWorkerReadCandidates(candidates, async (scope) => {
      await scope.readStoreTarget({
        agentId: "main",
        storePath: request.database.path,
        candidates,
        env: {},
        registeredDatabases: [],
      });
    });
    const result = discovery.catch((error: unknown) => error);
    await cleanupEntered.promise;
    const alias = observed.resources.find((resource) => !resource.agentId);
    assert(alias?.revoke);
    alias.revoke();
    const closing = alias.close().catch((error: unknown) => error);
    await retirementEntered.promise;
    try {
      cleanup.resolve();
      expect(await result).toMatchObject({ message: "Session target discovery was revoked" });
      expect(observed.unregister).not.toHaveBeenCalled();
      if (fails) {
        const failure = new Error("overlapping retirement failed");
        retirement.reject(failure);
        expect(await closing).toBe(failure);
        expect(observed.unregister).not.toHaveBeenCalled();
        observed.rotate.mockResolvedValueOnce(undefined);
        await alias.close();
      } else {
        retirement.resolve();
        await closing;
      }
      expect(observed.unregister).toHaveBeenCalledTimes(1);
    } finally {
      cleanup.resolve();
      retirement.resolve();
      await Promise.allSettled([discovery, closing]);
    }
  },
);
