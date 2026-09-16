// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  getPreparedModelRuntimeTestApi,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getPluginMetadataSnapshotCache,
  retirePluginCache,
} from "../plugins/plugin-cache.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

function replaceMetadata() {
  mocks.pluginMetadataSnapshot = { ...mocks.pluginMetadataSnapshot };
  bindPluginMetadataSnapshotCache(mocks.pluginMetadataSnapshot, createPluginCache());
}

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "retired-dispatch" });
  await resetPreparedModelRuntimeHarness(state);
  mocks.configuredAgentIds = ["general", "sibling"];
  replaceMetadata();
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

async function publish() {
  await refreshPreparedModelRuntimeSnapshots(
    {},
    {
      gatewayLifecycle: true,
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
    },
  );
  const runtime = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "general" });
  expect(runtime).toBeDefined();
  return runtime!;
}

it("admits a new turn after its published plugin cache retires out of band", async () => {
  const first = await publish();
  // The metadata loader supplies the successor cache after the plugin reload.
  replaceMetadata();
  await retirePluginCache(
    getPluginMetadataSnapshotCache(first.pluginGeneration.pluginMetadataSnapshot),
  );
  await nextTurn();
  const current = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "general" });
  expect(current).toBeDefined();
  await using lease = await acquireAgentRunPreparedModelRuntime(
    {
      config: current!.config,
      agentId: "general",
      agentDir: current!.agentDir,
      workspaceDir: current!.workspaceDir,
      allowGatewaySubagentBinding: true,
    },
    { catalogMode: "static", pluginGeneration: current!.pluginGeneration },
  );
  expect(current!.pluginGeneration).not.toBe(first.pluginGeneration);
  expect(lease.snapshot.isCurrent()).toBe(true);
  await expect(
    loadPublishedGatewayReplyDispatchRuntime({ agentId: "sibling" }),
  ).resolves.toMatchObject({ agentId: "sibling" });
});

it("does not republish a generation retired while process close is in progress", async () => {
  const first = await publish();
  const builds = mocks.prepareStaticCatalog.mock.calls.length;
  const closing = closePreparedModelRuntimeSnapshots();
  replaceMetadata();
  const retirement = retirePluginCache(
    getPluginMetadataSnapshotCache(first.pluginGeneration.pluginMetadataSnapshot),
  );
  await expect(closing).resolves.toBeUndefined();
  await retirement;
  await nextTurn();
  expect(getPreparedModelRuntimeTestApi().getPreparedModelRuntimeOwnerCountForTest()).toBe(0);
  expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(builds);
  await expect(
    loadPublishedGatewayReplyDispatchRuntime({ agentId: "general" }),
  ).resolves.toBeUndefined();
});

it("leaves a newer queued config replacement in charge after retirement", async () => {
  const first = await publish();
  replaceMetadata();
  const retirement = retirePluginCache(
    getPluginMetadataSnapshotCache(first.pluginGeneration.pluginMetadataSnapshot),
  );
  mocks.configuredAgentIds = ["sibling"];
  const committed = { plugins: { enabled: false } };
  await refreshPreparedModelRuntimeSnapshots(committed, {
    gatewayLifecycle: true,
    catalogMode: "static",
    allowGatewaySubagentBinding: true,
  });
  await retirement;
  await nextTurn();
  await expect(
    loadPublishedGatewayReplyDispatchRuntime({ agentId: "sibling" }),
  ).resolves.toMatchObject({
    config: committed,
  });
  await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "general" })).rejects.toThrow(
    "prepared reply dispatch runtime owner was not published for general",
  );
  expect(getPreparedModelRuntimeTestApi().getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
});

it("refreshes a retained idle run on demand after retirement without a Gateway republish", async () => {
  const input = { config: {}, agentId: "general", agentDir: state.agentDir("general") };
  const options = { catalogMode: "static" as const, retainIdleRunOwner: true };
  const first = await acquireAgentRunPreparedModelRuntime(input, options);
  await first[Symbol.asyncDispose]();
  const builds = mocks.prepareStaticCatalog.mock.calls.length;
  replaceMetadata();
  await retirePluginCache(
    getPluginMetadataSnapshotCache(first.pluginGeneration.pluginMetadataSnapshot),
  );
  await nextTurn();
  expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(builds);
  await using current = await acquireAgentRunPreparedModelRuntime(input, options);
  expect(current.pluginGeneration).not.toBe(first.pluginGeneration);
  expect(current.snapshot.isCurrent()).toBe(true);
});
