import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { registerAgentHarness } from "../agents/harness/registry.js";
import type { SessionEntry } from "../config/sessions.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { commitSessionExecutionSelection } from "../model-picker/apply-session-model-selection.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import type { GatewaySessionRow } from "./session-utils.types.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
let originalRegistry: ReturnType<typeof getActivePluginRegistry>;
beforeEach(() => {
  originalRegistry = getActivePluginRegistry();
  setActivePluginRegistry(createEmptyPluginRegistry());
  registerAgentHarness({
    id: "repository-device",
    label: "Repository device",
    autoSelection: { providerIds: ["repository-provider"] },
    supports: () => ({ supported: true }),
    cloudPlacement: {
      mode: "remote-exec",
      devicePlacement: {
        requiredNodeCommands: ["runtime.repository.v1"],
        consumesWorkerSlot: false,
      },
    },
    runAttempt: async () => {
      throw new Error("selection must not execute the runtime");
    },
  });
});
afterEach(() => {
  if (originalRegistry) {
    setActivePluginRegistry(originalRegistry);
  }
});

test("sessions.dispatch admits the child's accepted runtime after its parent changes model", async () => {
  const { storePath } = await createSessionStoreDir();
  const client = createOperatorWsClient();
  const parentKey = "agent:main:main";
  const childKey = "agent:main:repository-child";
  const parent: SessionEntry = {
    sessionId: "placement-parent",
    updatedAt: 1,
    executionSelection: {
      state: "accepted",
      selection: {
        model: { provider: "repository-provider", id: "repository-model" },
        executor: { kind: "harness", id: "repository-device" },
      },
      fallbackPermission: "explicit",
    },
  };
  await writeSessionStore({ entries: { [parentKey]: parent } });
  const configModule = await getGatewayConfigModule();
  const config = {
    ...configModule.getRuntimeConfig(),
    cloudWorkers: { profiles: { test: { provider: "fake" } } },
  };
  configModule.setRuntimeConfigSnapshot(config);
  const created = await directSessionReq(
    "sessions.create",
    {
      key: childKey,
      parentSessionKey: parentKey,
      repository: { url: "https://github.com/openclaw/openclaw" },
    },
    { client },
  );
  expect(created.ok).toBe(true);
  expect(loadSessionEntry({ storePath, sessionKey: childKey })?.executionSelection).toEqual(
    parent.executionSelection,
  );
  await patchSessionEntryCore(
    { storePath, sessionKey: parentKey },
    (entry) => {
      const next = { ...expectDefined(entry, "parent session") };
      commitSessionExecutionSelection(next, {
        model: { provider: "parent-api", id: "worker-model" },
        executor: { kind: "harness", id: "openclaw" },
      });
      return next;
    },
    { skipMaintenance: true, replaceEntry: true },
  );
  expect(loadSessionEntry({ storePath, sessionKey: parentKey })?.executionSelection).toMatchObject({
    state: "accepted",
    selection: { executor: { id: "openclaw" }, model: { id: "worker-model" } },
  });
  expect(loadSessionEntry({ storePath, sessionKey: childKey })?.executionSelection).toEqual(
    parent.executionSelection,
  );
  const listed = await directSessionReq<{ sessions: GatewaySessionRow[] }>(
    "sessions.list",
    {},
    { client },
  );
  const child = listed.payload?.sessions.find((row) => row.key === childKey);
  expect(child).toMatchObject({
    modelProvider: "repository-provider",
    model: "repository-model",
    agentRuntime: { id: "repository-device", cloudPlacementSupported: true },
  });
  const dispatch = vi
    .fn<NonNullable<GatewayRequestContext["workerPlacementDispatchService"]>["dispatch"]>()
    .mockRejectedValue(new Error("admitted to placement service"));
  const result = await directSessionReq(
    "sessions.dispatch",
    { key: childKey, profileId: "test" },
    {
      client,
      context: {
        getRuntimeConfig: () => config,
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
        workerEnvironmentService: { supportsExecutionMode: () => true },
      },
    },
  );
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionKey: childKey,
      executionMode: "remote-exec",
      profileId: "test",
    }),
    expect.any(Function),
    undefined,
    undefined,
  );
  expect(result.error?.message).toBe("admitted to placement service");
});

test("sessions.list searches the displayed accepted runtime before applying pagination", async () => {
  await createSessionStoreDir();
  const entries: Record<string, SessionEntry> = {};
  for (let index = 0; index < 3; index++) {
    entries[`agent:main:selection-${index}`] = {
      sessionId: `selection-${index}`,
      updatedAt: index + 1,
      executionSelection: {
        state: "accepted",
        selection: {
          model: { provider: "repository-provider", id: "repository-model" },
          executor: { kind: "harness", id: "repository-device" },
        },
        fallbackPermission: "configured",
      },
    };
  }
  entries["agent:main:unrelated"] = {
    sessionId: "unrelated",
    updatedAt: 10,
    executionSelection: {
      state: "accepted",
      selection: {
        model: { provider: "fixture", id: "other" },
        executor: { kind: "harness", id: "openclaw" },
      },
      fallbackPermission: "configured",
    },
  };
  await writeSessionStore({ entries });
  const first = await directSessionReq<{
    sessions: GatewaySessionRow[];
    totalCount: number;
    nextOffset: number;
  }>("sessions.list", { search: "repository-device", limit: 1 });
  expect(first.ok).toBe(true);
  expect(first.payload?.totalCount).toBe(3);
  expect(first.payload?.sessions.map((row) => row.key)).toEqual(["agent:main:selection-2"]);
  const second = await directSessionReq<{ sessions: GatewaySessionRow[]; totalCount: number }>(
    "sessions.list",
    { search: "repository-device", limit: 1, offset: first.payload?.nextOffset },
  );
  expect(second.payload?.totalCount).toBe(3);
  expect(second.payload?.sessions.map((row) => row.key)).toEqual(["agent:main:selection-1"]);
  expect(second.payload?.sessions[0]?.agentRuntime?.id).toBe("repository-device");
});

test("sessions.dispatch refuses deferred reset intent before choosing placement", async () => {
  const { storePath } = await createSessionStoreDir();
  const configModule = await getGatewayConfigModule();
  const base = configModule.getRuntimeConfig();
  const config = {
    ...base,
    cloudWorkers: { profiles: { test: { provider: "fake" } } },
  };
  const key = "agent:main:placement-reset";
  const entry: SessionEntry = {
    sessionId: "placement-reset",
    lifecycleRevision: "placement-reset-generation",
    updatedAt: 1,
    executionSelection: {
      state: "deferred",
      request: {},
      fallbackPermission: "configured",
      previous: {
        model: { provider: "fixture", id: "previous-model" },
        executor: { kind: "harness", id: "openclaw" },
      },
    },
  };
  await writeSessionStore({ entries: { [key]: entry } });
  configModule.setRuntimeConfigSnapshot(config);
  const before = loadSessionEntry({ storePath, sessionKey: key });
  const dispatch =
    vi.fn<NonNullable<GatewayRequestContext["workerPlacementDispatchService"]>["dispatch"]>();
  await expect(
    directSessionReq(
      "sessions.dispatch",
      { key, profileId: "test" },
      {
        client: createOperatorWsClient(),
        context: {
          getRuntimeConfig: () => config,
          workerPlacementDispatchService: { dispatch },
          workerSessionPlacementService: { getMany: () => new Map() },
          workerEnvironmentService: { supportsExecutionMode: () => true },
        },
      },
    ),
  ).rejects.toThrow("Prepare a model selection before choosing session placement.");
  expect(dispatch).not.toHaveBeenCalled();
  expect(loadSessionEntry({ storePath, sessionKey: key })).toEqual(before);
});
