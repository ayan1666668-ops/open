/**
 * End-to-end proof for requester-bound plugin ACP cancellation: a real plugin spawn with
 * `completionDelivery: "current-requester"` registers the run and task row, the plugin
 * cancels through `api.runtime.acp.cancel`, and the canonical task -> subagent kill path
 * compares the plugin's task owner rather than the captured completion requester.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpInitializeSessionInput } from "../acp/control-plane/manager.types.js";
import { killSubagentRunAdmin } from "../agents/subagents/registry/subagent-control-kill.js";
import {
  killAllControlledSubagentRuns,
  resolveSubagentController,
} from "../agents/subagents/registry/subagent-control.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "../agents/subagents/registry/subagent-lifecycle-events.js";
import {
  getSubagentRunByChildSessionKey,
  listSubagentRunsForRequester,
} from "../agents/subagents/registry/subagent-registry-read.js";
import {
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { withPluginSubagentRequesterContext } from "../plugins/runtime/subagent-requester-context.js";
import { resolvePluginAcpOwnerKey } from "../plugins/runtime/types-acp.js";
import { getTaskById, listTasksForOwnerKey } from "../tasks/task-registry-query.js";
import {
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
} from "../tasks/task-runtime.test-helpers.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import type { InternalAgentTurnFacade } from "./agent-turn/internal-facade.types.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const PLUGIN_ID = "factory-adapter";
const OTHER_PLUGIN_ID = "other-plugin";
const OWNER_KEY = resolvePluginAcpOwnerKey(PLUGIN_ID);
const RUN_ID = "run-plugin-requester-bound";
const REQUESTER = {
  sessionKey: "agent:main:telegram:group:42",
  origin: { channel: "telegram", to: "telegram:42", accountId: "acct-1", threadId: "7" },
} as const;

type ControlRuntime = typeof import("../agents/subagents/registry/subagent-control.runtime.js");

const hoisted = vi.hoisted(() => ({
  state: { cfg: {} as OpenClawConfig },
  callGatewayMock: vi.fn(),
  agentDispatchMock: vi.fn(),
  initializeSessionMock: vi.fn(),
  cleanupFailedAcpSpawnMock: vi.fn(),
  abortEmbeddedAgentRun: vi.fn<ControlRuntime["abortEmbeddedAgentRun"]>(() => true),
  isEmbeddedAgentRunActive: vi.fn<ControlRuntime["isEmbeddedAgentRunActive"]>(() => false),
  clearSessionQueues: vi.fn<ControlRuntime["clearSessionQueues"]>(() => ({
    followupCleared: 0,
    laneCleared: 0,
    keys: [],
  })),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => hoisted.state.cfg,
}));
vi.mock("../gateway/call.js", () => ({
  callGateway: hoisted.callGatewayMock,
}));
vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    initializeSession: async (params: AcpInitializeSessionInput) =>
      await hoisted.initializeSessionMock(params),
  }),
}));
vi.mock("../acp/control-plane/spawn.js", () => ({
  cleanupFailedAcpSpawn: hoisted.cleanupFailedAcpSpawnMock,
}));
// The embedded-run abort seam is the underlying kill effect this file proves is reached.
vi.mock("../agents/subagents/registry/subagent-control.runtime.js", () => ({
  abortEmbeddedAgentRun: hoisted.abortEmbeddedAgentRun,
  isEmbeddedAgentRunActive: hoisted.isEmbeddedAgentRunActive,
  clearSessionQueues: hoisted.clearSessionQueues,
}));

const { createGatewayAcpRuntime } = await import("./server-plugin-acp-runtime.js");

function scoped<T>(run: () => T, pluginId = PLUGIN_ID): T {
  return withPluginRuntimeGatewayRequestScope(
    { pluginId, pluginOrigin: "bundled", isWebchatConnect: () => false },
    run,
  );
}

async function withCancelHarness(
  run: (harness: {
    cfg: OpenClawConfig;
    runtime: ReturnType<typeof createGatewayAcpRuntime>;
    tempRoot: string;
  }) => Promise<void>,
) {
  await withStateDirEnv("openclaw-plugin-acp-cancel-", async ({ tempRoot }) => {
    const cfg: OpenClawConfig = {
      acp: { enabled: true, backend: "acpx", allowedAgents: ["codex"], defaultAgent: "codex" },
      agents: {
        defaults: {
          subagents: { allowAgents: ["codex"], maxSpawnDepth: 2, maxChildrenPerAgent: 2 },
        },
      },
      session: {
        mainKey: "main",
        scope: "per-sender",
        store: path.join(tempRoot, "sessions.json"),
      },
      plugins: { entries: { [PLUGIN_ID]: { acp: { allowDetachedSpawn: true } } } },
    };
    hoisted.state.cfg = cfg;
    // In-process plugin spawns launch the child turn through the captured host's facade;
    // the child run is accepted and left pending so cancellation has a live run to kill.
    const agentTurnFacade: InternalAgentTurnFacade = {
      dispatch: async <T>(request: AgentRunRequest) => {
        hoisted.agentDispatchMock(request);
        return { runId: RUN_ID } as T;
      },
      dispatchRaw: async () => {
        throw new Error("dispatchRaw is not used by plugin ACP spawn");
      },
      wait: async <T>() => ({ status: "pending" }) as T,
    };
    const hostContext: Partial<GatewayRequestContext> = {
      getRuntimeConfig: () => cfg,
      createAgentTurnFacade: () => agentTurnFacade,
    };
    const context = hostContext as GatewayRequestContext;
    const lifetime = new AbortController();
    resetAgentEventsForTest();
    resetTaskRegistryControlRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetSubagentRegistryForTests({ persist: false });
    // The real subagent kill owner serves task cancellation; nothing here is stubbed.
    setTaskRegistryControlRuntimeForTests({
      cancelActiveCronTaskRun: () => false,
      getAcpSessionManager: () => {
        throw new Error("plugin ACP runs cancel through the subagent task owner, not raw ACP");
      },
      killSubagentRunAdmin,
    });
    subagentRegistryTesting.setDepsForTest({
      // The registry waiter stays parked so the child run remains live until it is killed.
      callGateway: async (request) => {
        if (request.method !== "agent.wait") {
          throw new Error(`Unexpected registry RPC ${request.method}`);
        }
        return await new Promise<never>(() => {});
      },
      cleanupBrowserSessionsForLifecycleEnd: async () => {},
      ensureContextEnginesInitialized: () => {},
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      persistSubagentRunsToDisk: () => {},
      persistSubagentRunsToDiskOrThrow: () => {},
      restoreSubagentRunsFromDisk: () => 0,
    });
    try {
      await run({
        cfg,
        runtime: createGatewayAcpRuntime(() => context, lifetime.signal),
        tempRoot,
      });
    } finally {
      lifetime.abort();
      subagentRegistryTesting.setDepsForTest();
      resetSubagentRegistryForTests({ persist: false });
      resetTaskRegistryControlRuntimeForTests();
      resetTaskRegistryForTests({ persist: false });
    }
  });
}

async function spawnRequesterBoundRun(
  runtime: ReturnType<typeof createGatewayAcpRuntime>,
  tempRoot: string,
) {
  const spawned = await withPluginSubagentRequesterContext(REQUESTER, () =>
    scoped(() =>
      runtime.spawn({
        task: "Report back to the requester",
        cwd: tempRoot,
        completionDelivery: "current-requester",
      }),
    ),
  );
  expect(spawned.runId).toBe(RUN_ID);
  expect(spawned.sessionKey).toMatch(new RegExp(`^agent:codex:acp:plugin:${PLUGIN_ID}:`));
  return spawned;
}

function expectRunStillRunning(childSessionKey: string) {
  expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
    runId: RUN_ID,
    execution: { status: "running" },
  });
  expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.endedAt).toBeUndefined();
  expect(hoisted.abortEmbeddedAgentRun).not.toHaveBeenCalled();
}

beforeEach(() => {
  setActivePluginRegistry(createTestRegistry());
  hoisted.callGatewayMock.mockReset().mockImplementation(async (request: { method?: string }) => {
    throw new Error(`unexpected out-of-process gateway call: ${String(request.method)}`);
  });
  hoisted.agentDispatchMock.mockReset();
  hoisted.cleanupFailedAcpSpawnMock.mockReset().mockResolvedValue(undefined);
  hoisted.abortEmbeddedAgentRun.mockClear();
  hoisted.isEmbeddedAgentRunActive.mockClear();
  hoisted.clearSessionQueues.mockClear();
  hoisted.initializeSessionMock
    .mockReset()
    .mockImplementation(async (params: AcpInitializeSessionInput) => ({
      closeRuntimeOnFailure: vi.fn().mockResolvedValue(undefined),
      runtime: { close: vi.fn().mockResolvedValue(undefined) },
      handle: { sessionKey: params.sessionKey, backend: "acpx", runtimeSessionName: "rt" },
      meta: {
        backend: "acpx",
        agent: params.agent,
        runtimeSessionName: "rt",
        mode: params.mode,
        state: "idle",
        lastActivityAt: Date.now(),
      },
    }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("plugin ACP requester-bound cancellation", () => {
  it("cancels a requester-bound run through the canonical task owner down to the kill path", async () => {
    await withCancelHarness(async ({ cfg, runtime, tempRoot }) => {
      const spawned = await spawnRequesterBoundRun(runtime, tempRoot);
      const childSessionKey = spawned.sessionKey;

      // Registration keeps the plugin as task/control owner and the captured session as
      // the announce target; the task row is owner-scoped to the plugin.
      const registered = getSubagentRunByChildSessionKey(childSessionKey);
      expect(registered).toMatchObject({
        runId: RUN_ID,
        controllerSessionKey: OWNER_KEY,
        taskOwnerKey: OWNER_KEY,
        requesterSessionKey: REQUESTER.sessionKey,
        requesterOrigin: REQUESTER.origin,
        expectsCompletionMessage: true,
        execution: { status: "running" },
      });
      const [taskRow] = listTasksForOwnerKey(OWNER_KEY);
      expect(taskRow).toMatchObject({
        runId: RUN_ID,
        ownerKey: OWNER_KEY,
        childSessionKey,
        status: "running",
        deliveryStatus: "not_applicable",
      });
      expect(spawned.taskId).toBe(taskRow?.taskId);
      const childEntry = loadSessionEntry({
        storePath: cfg.session!.store!,
        sessionKey: childSessionKey,
        agentId: "codex",
      });
      expect(childEntry?.pluginOwnerId).toBe(PLUGIN_ID);
      expect(childEntry?.sessionId).toBeTypeOf("string");

      const cancelled = await scoped(() =>
        runtime.cancel({ runId: RUN_ID, reason: "plugin stop" }),
      );
      expect(cancelled).toMatchObject({ found: true, cancelled: true });

      // The owned cancellation reached the embedded-run abort and every downstream owner.
      expect(hoisted.abortEmbeddedAgentRun).toHaveBeenCalledWith(childEntry?.sessionId);
      expect(getTaskById(taskRow!.taskId)).toMatchObject({
        status: "cancelled",
        error: "plugin stop",
        ownerKey: OWNER_KEY,
      });
      expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
        runId: RUN_ID,
        endedReason: SUBAGENT_ENDED_REASON_KILLED,
        requesterSessionKey: REQUESTER.sessionKey,
        taskOwnerKey: OWNER_KEY,
      });
      expect(
        loadSessionEntry({
          storePath: cfg.session!.store!,
          sessionKey: childSessionKey,
          agentId: "codex",
        })?.abortedLastRun,
      ).toBe(true);
    });
  });

  it("refuses the captured requester and foreign owners without effects", async () => {
    await withCancelHarness(async ({ cfg, runtime, tempRoot }) => {
      const { sessionKey: childSessionKey } = await spawnRequesterBoundRun(runtime, tempRoot);

      // The requester's own control path sees the run but does not own it.
      const requesterController = resolveSubagentController({
        cfg,
        agentSessionKey: REQUESTER.sessionKey,
      });
      const requesterRuns = listSubagentRunsForRequester(REQUESTER.sessionKey);
      expect(requesterRuns.map((entry) => entry.runId)).toEqual([RUN_ID]);
      await expect(
        killAllControlledSubagentRuns({
          cfg,
          controller: requesterController,
          runs: requesterRuns,
        }),
      ).resolves.toEqual({ status: "ok", killed: 0, labels: [] });
      expectRunStillRunning(childSessionKey);

      // The completion requester key alone cannot pass the canonical owner fence.
      await expect(
        killSubagentRunAdmin({
          cfg,
          sessionKey: childSessionKey,
          expectedTaskRunId: RUN_ID,
          expectedOwnerKey: REQUESTER.sessionKey,
        }),
      ).resolves.toEqual({ found: false, killed: false });
      // Neither can another plugin's owner key, through the runtime or the kill owner.
      await expect(
        scoped(() => runtime.cancel({ runId: RUN_ID }), OTHER_PLUGIN_ID),
      ).resolves.toEqual({ found: false, cancelled: false, reason: "Task not found." });
      await expect(
        killSubagentRunAdmin({
          cfg,
          sessionKey: childSessionKey,
          expectedTaskRunId: RUN_ID,
          expectedOwnerKey: resolvePluginAcpOwnerKey(OTHER_PLUGIN_ID),
        }),
      ).resolves.toEqual({ found: false, killed: false });
      expectRunStillRunning(childSessionKey);
      expect(getTaskById(listTasksForOwnerKey(OWNER_KEY)[0]!.taskId)?.status).toBe("running");
    });
  });

  it("reports not found without effects once the child session is re-owned", async () => {
    await withCancelHarness(async ({ cfg, runtime, tempRoot }) => {
      const { sessionKey: childSessionKey } = await spawnRequesterBoundRun(runtime, tempRoot);
      await patchSessionEntryCore(
        { storePath: cfg.session!.store!, sessionKey: childSessionKey, agentId: "codex" },
        () => ({ pluginOwnerId: OTHER_PLUGIN_ID }),
      );

      await expect(scoped(() => runtime.cancel({ runId: RUN_ID }))).resolves.toEqual({
        found: false,
        cancelled: false,
        reason: "Task not found.",
      });
      expectRunStillRunning(childSessionKey);
      expect(getTaskById(listTasksForOwnerKey(OWNER_KEY)[0]!.taskId)?.status).toBe("running");
    });
  });
});
