import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnAcpForPluginResult } from "../agents/subagents/spawn/acp-spawn-plugin.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { withPluginSubagentRequesterContext } from "../plugins/runtime/subagent-requester-context.js";
import {
  type PluginAcpObserveEvent,
  PluginAcpRuntimeError,
  resolvePluginAcpOwnerKey,
} from "../plugins/runtime/types-acp.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";
import * as inProcessDispatch from "./server-plugin-in-process-dispatch.js";

const PLUGIN_ID = "factory-adapter";
const OTHER_PLUGIN_ID = "other-plugin";
const OWNER_KEY = resolvePluginAcpOwnerKey(PLUGIN_ID);

const hoisted = vi.hoisted(() => ({
  spawnAcpForPluginMock: vi.fn(),
  listTasksForOwnerKeyMock: vi.fn(),
  cancelDetachedTaskRunByIdMock: vi.fn(),
  loadSessionEntryMock: vi.fn(),
  readAcpSessionMetaMock: vi.fn(),
}));

vi.mock("../agents/subagents/spawn/acp-spawn-plugin.js", () => ({
  spawnAcpForPlugin: hoisted.spawnAcpForPluginMock,
}));
vi.mock(import("../tasks/task-registry-query.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  listTasksForOwnerKey: hoisted.listTasksForOwnerKeyMock,
}));
vi.mock(import("../tasks/task-executor.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  cancelDetachedTaskRunById: hoisted.cancelDetachedTaskRunByIdMock,
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: hoisted.loadSessionEntryMock,
}));
vi.mock("../acp/runtime/session-meta.js", () => ({
  readAcpSessionMeta: hoisted.readAcpSessionMetaMock,
}));

const { createGatewayAcpRuntime } = await import("./server-plugin-acp-runtime.js");

let config: OpenClawConfig;
let context: GatewayRequestContext | undefined;
let lifetime: AbortController;
let tasks: TaskRecord[];

function createRuntime(
  resolveGatewayContext: (() => GatewayRequestContext | undefined) | undefined = () => context,
) {
  return createGatewayAcpRuntime(resolveGatewayContext, lifetime.signal);
}

function task(overrides: Partial<TaskRecord> & { taskId: string }): TaskRecord {
  return {
    runtime: "subagent",
    requesterSessionKey: OWNER_KEY,
    ownerKey: OWNER_KEY,
    scopeKind: "session",
    childSessionKey: `agent:codex:acp:plugin:${PLUGIN_ID}:${overrides.taskId}`,
    runId: `run-${overrides.taskId}`,
    task: "do work",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: 1_000,
    ...overrides,
  };
}

function acceptedSpawn(overrides?: Partial<SpawnAcpForPluginResult>): SpawnAcpForPluginResult {
  return {
    status: "accepted",
    childSessionKey: `agent:codex:acp:plugin:${PLUGIN_ID}:child-1`,
    runId: "run-1",
    mode: "run",
    runTimeoutSeconds: 900,
    expectsCompletionMessage: false,
    targetAgentId: "codex",
    ...overrides,
  } as SpawnAcpForPluginResult;
}

type ScopeOverrides = {
  client?: GatewayRequestOptions["client"];
  pluginId?: string;
  pluginOrigin?: "bundled" | "global" | "workspace";
};

function scoped<T>(run: () => T, overrides: ScopeOverrides = {}): T {
  return withPluginRuntimeGatewayRequestScope(
    {
      pluginId: overrides.pluginId ?? PLUGIN_ID,
      pluginOrigin: overrides.pluginOrigin ?? "bundled",
      isWebchatConnect: () => false,
      ...(overrides.client ? { client: overrides.client } : {}),
    },
    run,
  );
}

const requestClient = {
  connect: { scopes: ["operator.write"] },
} as unknown as NonNullable<GatewayRequestOptions["client"]>;

async function expectAcpError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof PluginAcpRuntimeError)) {
    throw new Error(`Expected PluginAcpRuntimeError ${code}, got ${String(error)}`);
  }
  expect(error.code).toBe(code);
  return error;
}

beforeEach(() => {
  resetAgentEventsForTest();
  config = {
    acp: { enabled: true },
    plugins: { entries: { [PLUGIN_ID]: { acp: { allowDetachedSpawn: true } } } },
  };
  context = { getRuntimeConfig: () => config } as GatewayRequestContext;
  lifetime = new AbortController();
  tasks = [];
  hoisted.listTasksForOwnerKeyMock
    .mockReset()
    .mockImplementation((ownerKey: string) => tasks.filter((entry) => entry.ownerKey === ownerKey));
  hoisted.spawnAcpForPluginMock.mockReset().mockResolvedValue(acceptedSpawn());
  hoisted.cancelDetachedTaskRunByIdMock.mockReset();
  hoisted.loadSessionEntryMock.mockReset().mockReturnValue(undefined);
  hoisted.readAcpSessionMetaMock.mockReset().mockReturnValue(undefined);
});

afterEach(() => {
  lifetime.abort();
  vi.restoreAllMocks();
});

describe("plugin ACP runtime principal", () => {
  it("fails closed without a plugin principal", async () => {
    const runtime = createRuntime();
    await expectAcpError(runtime.spawn({ task: "x" }), "ACP_PLUGIN_PRINCIPAL_REQUIRED");
    await expectAcpError(runtime.listRuns(), "ACP_PLUGIN_PRINCIPAL_REQUIRED");
    await expect(runtime.isAvailable()).resolves.toMatchObject({
      ok: false,
      code: "ACP_PLUGIN_PRINCIPAL_REQUIRED",
    });
    expect(hoisted.spawnAcpForPluginMock).not.toHaveBeenCalled();
  });

  it("fails closed without an in-process Gateway context", async () => {
    context = undefined;
    const runtime = createRuntime();
    await expectAcpError(
      scoped(() => runtime.spawn({ task: "x" })),
      "ACP_PLUGIN_GATEWAY_REQUIRED",
    );
    await expect(scoped(() => runtime.isAvailable())).resolves.toMatchObject({
      ok: false,
      code: "ACP_PLUGIN_GATEWAY_REQUIRED",
    });
  });

  it("closes retained method closures after the runtime lifetime ends", async () => {
    const runtime = createRuntime();
    const spawn = runtime.spawn;
    lifetime.abort();
    await expectAcpError(
      scoped(() => spawn({ task: "x" })),
      "ACP_PLUGIN_RUNTIME_CLOSED",
    );
    await expectAcpError(
      scoped(() => runtime.getRun({ runId: "run-1" })),
      "ACP_PLUGIN_RUNTIME_CLOSED",
    );
    expect(hoisted.spawnAcpForPluginMock).not.toHaveBeenCalled();
  });
});

describe("plugin ACP spawn authority", () => {
  it("denies detached spawns by default", async () => {
    config.plugins = {};
    const runtime = createRuntime();
    await expectAcpError(
      scoped(() => runtime.spawn({ task: "x" })),
      "ACP_PLUGIN_DETACHED_FORBIDDEN",
    );
    await expect(scoped(() => runtime.isAvailable())).resolves.toMatchObject({
      ok: false,
      code: "ACP_PLUGIN_DETACHED_FORBIDDEN",
    });
    expect(hoisted.spawnAcpForPluginMock).not.toHaveBeenCalled();
  });

  it("denies detached spawns for untrusted plugins even with the flag", async () => {
    const runtime = createRuntime();
    await expectAcpError(
      scoped(() => runtime.spawn({ task: "x" }), { pluginOrigin: "workspace" }),
      "ACP_PLUGIN_DETACHED_FORBIDDEN",
    );
    expect(hoisted.spawnAcpForPluginMock).not.toHaveBeenCalled();
  });

  it("accepts detached spawns for trusted plugins with the flag and binds the plugin principal", async () => {
    const runtime = createRuntime();
    await expect(scoped(() => runtime.isAvailable())).resolves.toEqual({
      ok: true,
      mode: "detached",
    });
    tasks.push(task({ taskId: "t1", runId: "run-1" }));
    const result = await scoped(() => runtime.spawn({ task: "Run it", cwd: "/repo" }));
    expect(result).toEqual({
      runId: "run-1",
      taskId: "t1",
      sessionKey: `agent:codex:acp:plugin:${PLUGIN_ID}:child-1`,
      agentId: "codex",
      runTimeoutSeconds: 900,
    });
    const [input, principal] = hoisted.spawnAcpForPluginMock.mock.calls[0] ?? [];
    expect(input).toMatchObject({ task: "Run it", cwd: "/repo" });
    expect(principal).toMatchObject({ pluginId: PLUGIN_ID, ownerKey: OWNER_KEY });
    expect(typeof principal.assertActive).toBe("function");
  });

  it("treats a live request or requester context as request-scoped without inheriting it", async () => {
    config.plugins = {};
    const runtime = createRuntime();
    await expect(scoped(() => runtime.isAvailable(), { client: requestClient })).resolves.toEqual({
      ok: true,
      mode: "request",
    });
    await scoped(() => runtime.spawn({ task: "x" }), { client: requestClient });
    await withPluginSubagentRequesterContext(
      { sessionKey: "agent:main:main", origin: { channel: "telegram", to: "telegram:1" } },
      () => scoped(() => runtime.spawn({ task: "y" })),
    );
    expect(hoisted.spawnAcpForPluginMock).toHaveBeenCalledTimes(2);
    for (const call of hoisted.spawnAcpForPluginMock.mock.calls) {
      expect(call[1]).toMatchObject({ pluginId: PLUGIN_ID, ownerKey: OWNER_KEY });
      expect(call[1]).not.toHaveProperty("requesterSessionKey");
      expect(call[0]).not.toHaveProperty("requesterSessionKey");
      expect(call[0]).not.toHaveProperty("completionDelivery");
    }
  });

  it("reports ACP disabled through isAvailable", async () => {
    config.acp = { enabled: false };
    await expect(scoped(() => createRuntime().isAvailable())).resolves.toMatchObject({
      ok: false,
      code: "ACP_PLUGIN_DISABLED",
    });
  });
});

describe("plugin ACP spawn input", () => {
  it.each([
    ["mode", "session"],
    ["thread", true],
    ["streamTo", "parent"],
    ["resumeSessionId", "abc"],
    ["sandbox", "require"],
    ["completionDelivery", "current-requester"],
    ["steer", "x"],
    ["setMode", "plan"],
  ])("rejects unsupported option %s", async (option, value) => {
    const runtime = createRuntime();
    const error = await expectAcpError(
      scoped(() =>
        runtime.spawn({ task: "x", [option]: value } as Parameters<
          PluginRuntime["acp"]["spawn"]
        >[0]),
      ),
      "ACP_PLUGIN_UNSUPPORTED_OPTION",
    );
    expect(error.detailCode).toBe(option);
    expect(hoisted.spawnAcpForPluginMock).not.toHaveBeenCalled();
  });

  it("validates task, cwd, timeout, cleanup, and attachments", async () => {
    const runtime = createRuntime();
    await expectAcpError(
      scoped(() => runtime.spawn({ task: "  " })),
      "ACP_PLUGIN_INVALID_INPUT",
    );
    await expectAcpError(
      scoped(() => runtime.spawn({ task: "x", cwd: "relative/dir" })),
      "ACP_PLUGIN_INVALID_INPUT",
    );
    await expectAcpError(
      scoped(() => runtime.spawn({ task: "x", runTimeoutSeconds: -1 })),
      "ACP_PLUGIN_INVALID_INPUT",
    );
    await expectAcpError(
      scoped(() => runtime.spawn({ task: "x", cleanup: "purge" as unknown as "keep" })),
      "ACP_PLUGIN_INVALID_INPUT",
    );
    await expectAcpError(
      scoped(() =>
        runtime.spawn({
          task: "x",
          attachments: [{ mediaType: "image/png" } as { mediaType: string; data: string }],
        }),
      ),
      "ACP_PLUGIN_INVALID_INPUT",
    );
    expect(hoisted.spawnAcpForPluginMock).not.toHaveBeenCalled();
  });

  it("maps owner-side spawn failures to the plugin error taxonomy", async () => {
    const runtime = createRuntime();
    const cases: Array<[string, string]> = [
      ["acp_disabled", "ACP_PLUGIN_DISABLED"],
      ["agent_forbidden", "ACP_PLUGIN_AGENT_FORBIDDEN"],
      ["subagent_policy", "ACP_PLUGIN_ADMISSION_REJECTED"],
      ["cwd_resolution_failed", "ACP_PLUGIN_INVALID_INPUT"],
      ["dispatch_failed", "ACP_PLUGIN_SPAWN_FAILED"],
    ];
    for (const [errorCode, expected] of cases) {
      hoisted.spawnAcpForPluginMock.mockResolvedValueOnce({
        status: "forbidden",
        errorCode,
        error: `owner said ${errorCode}`,
      } as SpawnAcpForPluginResult);
      const error = await expectAcpError(
        scoped(() => runtime.spawn({ task: "x" })),
        expected,
      );
      expect(error.detailCode).toBe(errorCode);
      expect(error.message).toBe(`owner said ${errorCode}`);
    }
  });
});

describe("plugin ACP spawn idempotency", () => {
  it("replays the accepted result for the same key and canonical input", async () => {
    const runtime = createRuntime();
    const first = await scoped(() =>
      runtime.spawn({ task: "same", idempotencyKey: "k1", label: "a" }),
    );
    const second = await scoped(() =>
      runtime.spawn({ task: "same", idempotencyKey: "k1", label: "a" }),
    );
    expect(first.replayed).toBeUndefined();
    expect(second).toEqual({ ...first, replayed: true });
    expect(hoisted.spawnAcpForPluginMock).toHaveBeenCalledTimes(1);
  });

  it("does not alias a changed input under the same key", async () => {
    const runtime = createRuntime();
    hoisted.spawnAcpForPluginMock
      .mockResolvedValueOnce(acceptedSpawn({ runId: "run-a" }))
      .mockResolvedValueOnce(acceptedSpawn({ runId: "run-b" }));
    const first = await scoped(() => runtime.spawn({ task: "one", idempotencyKey: "k2" }));
    const second = await scoped(() => runtime.spawn({ task: "two", idempotencyKey: "k2" }));
    expect(first.runId).toBe("run-a");
    expect(second.runId).toBe("run-b");
    expect(second.replayed).toBeUndefined();
    expect(hoisted.spawnAcpForPluginMock).toHaveBeenCalledTimes(2);
  });

  it("scopes replay to the calling plugin", async () => {
    const runtime = createRuntime();
    config.plugins = {
      entries: {
        [PLUGIN_ID]: { acp: { allowDetachedSpawn: true } },
        [OTHER_PLUGIN_ID]: { acp: { allowDetachedSpawn: true } },
      },
    };
    await scoped(() => runtime.spawn({ task: "same", idempotencyKey: "k3" }));
    await scoped(() => runtime.spawn({ task: "same", idempotencyKey: "k3" }), {
      pluginId: OTHER_PLUGIN_ID,
    });
    expect(hoisted.spawnAcpForPluginMock).toHaveBeenCalledTimes(2);
  });

  it("evicts failed admission or launch so the next attempt runs again", async () => {
    const runtime = createRuntime();
    hoisted.spawnAcpForPluginMock.mockResolvedValueOnce({
      status: "forbidden",
      errorCode: "subagent_policy",
      error: "too many",
    } as SpawnAcpForPluginResult);
    await expectAcpError(
      scoped(() => runtime.spawn({ task: "x", idempotencyKey: "k4" })),
      "ACP_PLUGIN_ADMISSION_REJECTED",
    );
    const retry = await scoped(() => runtime.spawn({ task: "x", idempotencyKey: "k4" }));
    expect(retry.replayed).toBeUndefined();
    expect(hoisted.spawnAcpForPluginMock).toHaveBeenCalledTimes(2);
  });
});

describe("plugin ACP run inspection", () => {
  beforeEach(() => {
    tasks.push(
      task({ taskId: "mine-active", runId: "run-mine-active", createdAt: 3_000 }),
      task({
        taskId: "mine-done",
        runId: "run-mine-done",
        status: "succeeded",
        createdAt: 2_000,
      }),
      task({
        taskId: "foreign",
        runId: "run-foreign",
        ownerKey: resolvePluginAcpOwnerKey(OTHER_PLUGIN_ID),
        requesterSessionKey: resolvePluginAcpOwnerKey(OTHER_PLUGIN_ID),
        childSessionKey: `agent:codex:acp:plugin:${OTHER_PLUGIN_ID}:x`,
      }),
      task({
        taskId: "agent-owned",
        runId: "run-agent",
        ownerKey: "agent:main:main",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:codex:acp:s1",
      }),
    );
  });

  it("returns only the caller's runs from getRun and listRuns", async () => {
    const runtime = createRuntime();
    await expect(scoped(() => runtime.getRun({ runId: "run-mine-active" }))).resolves.toMatchObject(
      {
        id: "mine-active",
      },
    );
    await expect(scoped(() => runtime.getRun({ taskId: "mine-done" }))).resolves.toMatchObject({
      id: "mine-done",
    });
    await expect(scoped(() => runtime.getRun({ runId: "run-foreign" }))).resolves.toBeUndefined();
    await expect(scoped(() => runtime.getRun({ taskId: "agent-owned" }))).resolves.toBeUndefined();
    await expect(
      scoped(() => runtime.getRun({ runId: "run-foreign" }), { pluginId: OTHER_PLUGIN_ID }),
    ).resolves.toMatchObject({ id: "foreign" });

    const active = await scoped(() => runtime.listRuns());
    expect(active.map((run) => run.id)).toEqual(["mine-active"]);
    const all = await scoped(() => runtime.listRuns({ includeTerminal: true, limit: 1 }));
    expect(all.map((run) => run.id)).toEqual(["mine-active"]);
    const everything = await scoped(() => runtime.listRuns({ includeTerminal: true }));
    expect(everything.map((run) => run.id)).toEqual(["mine-active", "mine-done"]);
  });

  it("waits only for owned runs through the Gateway agent.wait owner", async () => {
    const dispatch = vi
      .spyOn(inProcessDispatch, "dispatchGatewayMethodInProcess")
      .mockResolvedValue({ status: "completed", runId: "run-mine-active" });
    const runtime = createRuntime();
    await expect(
      scoped(() => runtime.waitForRun({ runId: "run-mine-active", timeoutMs: 50 })),
    ).resolves.toEqual({ status: "ok", runId: "run-mine-active" });
    expect(dispatch).toHaveBeenCalledWith(
      "agent.wait",
      { runId: "run-mine-active", timeoutMs: 50 },
      expect.objectContaining({ resolveGatewayContext: expect.any(Function) }),
    );
    await expectAcpError(
      scoped(() => runtime.waitForRun({ runId: "run-foreign" })),
      "ACP_PLUGIN_RUN_NOT_FOUND",
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("hides foreign and missing sessions identically in getSession", async () => {
    const mine = `agent:codex:acp:plugin:${PLUGIN_ID}:child-1`;
    const foreign = `agent:codex:acp:plugin:${OTHER_PLUGIN_ID}:child-2`;
    hoisted.loadSessionEntryMock.mockImplementation((scope: { sessionKey: string }) => {
      if (scope.sessionKey === mine) {
        return {
          sessionId: "s1",
          updatedAt: 5,
          createdAt: 4,
          label: `plugin:${PLUGIN_ID}`,
          pluginOwnerId: PLUGIN_ID,
        } as SessionEntry;
      }
      if (scope.sessionKey === foreign) {
        return { sessionId: "s2", updatedAt: 5, pluginOwnerId: OTHER_PLUGIN_ID } as SessionEntry;
      }
      return undefined;
    });
    hoisted.readAcpSessionMetaMock.mockReturnValue({
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "rt",
      mode: "oneshot",
      cwd: "/repo",
      state: "running",
      lastActivityAt: 6,
      identity: { acpxSessionId: "secret" },
      runtimeOptions: { model: "m" },
    });
    const runtime = createRuntime();
    const detail = await scoped(() => runtime.getSession({ sessionKey: mine }));
    expect(detail).toEqual({
      sessionKey: mine,
      agentId: "codex",
      backend: "acpx",
      mode: "oneshot",
      cwd: "/repo",
      state: "running",
      lastActivityAt: 6,
      label: `plugin:${PLUGIN_ID}`,
      createdAt: 4,
      updatedAt: 5,
    });
    await expect(
      scoped(() => runtime.getSession({ sessionKey: foreign })),
    ).resolves.toBeUndefined();
    await expect(
      scoped(() => runtime.getSession({ sessionKey: "agent:codex:acp:plugin:nobody:none" })),
    ).resolves.toBeUndefined();
    await expect(
      scoped(() => runtime.getSession({ sessionKey: "agent:main:main" })),
    ).resolves.toBeUndefined();
    expect(hoisted.readAcpSessionMetaMock).toHaveBeenCalledTimes(1);
  });
});

describe("plugin ACP cancellation", () => {
  it("rereads ownership and cancels through the canonical task owner", async () => {
    tasks.push(task({ taskId: "mine", runId: "run-mine" }));
    hoisted.cancelDetachedTaskRunByIdMock.mockResolvedValue({
      found: true,
      cancelled: true,
      task: task({ taskId: "mine", runId: "run-mine", status: "cancelled" }),
    });
    const runtime = createRuntime();
    await expect(
      scoped(() => runtime.cancel({ runId: "run-mine", reason: "operator stop" })),
    ).resolves.toMatchObject({ found: true, cancelled: true, task: { id: "mine" } });
    expect(hoisted.cancelDetachedTaskRunByIdMock).toHaveBeenCalledWith({
      cfg: config,
      taskId: "mine",
      reason: "operator stop",
    });
  });

  it("reports foreign runs as not found without touching the task owner", async () => {
    tasks.push(
      task({
        taskId: "foreign",
        runId: "run-foreign",
        ownerKey: resolvePluginAcpOwnerKey(OTHER_PLUGIN_ID),
        requesterSessionKey: resolvePluginAcpOwnerKey(OTHER_PLUGIN_ID),
      }),
    );
    const runtime = createRuntime();
    await expect(scoped(() => runtime.cancel({ runId: "run-foreign" }))).resolves.toEqual({
      found: false,
      cancelled: false,
      reason: "Task not found.",
    });
    expect(hoisted.cancelDetachedTaskRunByIdMock).not.toHaveBeenCalled();
  });
});

describe("plugin ACP observe", () => {
  const RUN_ID = "run-observe";

  beforeEach(() => {
    tasks.push(task({ taskId: "observe", runId: RUN_ID }));
  });

  it("filters streams, delivers in order, and unsubscribes on the terminal event", async () => {
    const runtime = createRuntime();
    const events: PluginAcpObserveEvent[] = [];
    await scoped(() => runtime.observe({ runId: RUN_ID }, (event) => events.push(event)));
    emitAgentEvent({ runId: RUN_ID, stream: "assistant", data: { text: "hidden" } });
    emitAgentEvent({ runId: RUN_ID, stream: "acp", data: { phase: "runtime_event" } });
    emitAgentEvent({ runId: RUN_ID, stream: "tool", data: { name: "shell" } });
    emitAgentEvent({ runId: RUN_ID, stream: "lifecycle", data: { phase: "end", endedAt: 1 } });
    emitAgentEvent({ runId: RUN_ID, stream: "acp", data: { phase: "late" } });
    expect(events.map((event) => [event.stream, event.data.phase ?? event.data.name])).toEqual([
      ["acp", "runtime_event"],
      ["tool", "shell"],
      ["lifecycle", "end"],
    ]);
    expect(events.every((event) => event.runId === RUN_ID && !event.truncated)).toBe(true);
  });

  it("marks the last event truncated at maxEvents and stops", async () => {
    const runtime = createRuntime();
    const events: PluginAcpObserveEvent[] = [];
    await scoped(() =>
      runtime.observe({ runId: RUN_ID, maxEvents: 2 }, (event) => events.push(event)),
    );
    for (let index = 0; index < 4; index += 1) {
      emitAgentEvent({ runId: RUN_ID, stream: "acp", data: { index } });
    }
    expect(events.map((event) => event.data.index)).toEqual([0, 1]);
    expect(events[1]?.truncated).toBe(true);
  });

  it("unsubscribes on abort signal and on runtime shutdown", async () => {
    const runtime = createRuntime();
    const aborted: PluginAcpObserveEvent[] = [];
    const retained: PluginAcpObserveEvent[] = [];
    const abort = new AbortController();
    await scoped(() =>
      runtime.observe({ runId: RUN_ID, signal: abort.signal }, (event) => aborted.push(event)),
    );
    const unsubscribe = await scoped(() =>
      runtime.observe({ runId: RUN_ID }, (event) => retained.push(event)),
    );
    emitAgentEvent({ runId: RUN_ID, stream: "acp", data: { n: 1 } });
    abort.abort();
    emitAgentEvent({ runId: RUN_ID, stream: "acp", data: { n: 2 } });
    expect(aborted.map((event) => event.data.n)).toEqual([1]);
    expect(retained.map((event) => event.data.n)).toEqual([1, 2]);
    lifetime.abort();
    emitAgentEvent({ runId: RUN_ID, stream: "acp", data: { n: 3 } });
    expect(retained.map((event) => event.data.n)).toEqual([1, 2]);
    expect(() => unsubscribe()).not.toThrow();
  });

  it("rejects foreign runs and returns a no-op for terminal runs", async () => {
    tasks.push(
      task({ taskId: "done", runId: "run-done", status: "succeeded" }),
      task({
        taskId: "foreign",
        runId: "run-foreign",
        ownerKey: resolvePluginAcpOwnerKey(OTHER_PLUGIN_ID),
        requesterSessionKey: resolvePluginAcpOwnerKey(OTHER_PLUGIN_ID),
      }),
    );
    const runtime = createRuntime();
    await expectAcpError(
      scoped(() => runtime.observe({ runId: "run-foreign" }, () => {})),
      "ACP_PLUGIN_RUN_NOT_FOUND",
    );
    const seen: PluginAcpObserveEvent[] = [];
    const stop = await scoped(() =>
      runtime.observe({ runId: "run-done" }, (event) => seen.push(event)),
    );
    emitAgentEvent({ runId: "run-done", stream: "acp", data: {} });
    expect(seen).toEqual([]);
    stop();
  });
});
