import { vi, type Mock } from "vitest";
import { getRuntimeAuthProfileStoreCredentialsRevision } from "../../agents/auth-profiles/runtime-snapshots.js";
import { evaluatePublishedModelRuntimeChoice } from "../../agents/model-runtime-choice.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getActivePluginRegistry, getActivePluginRegistryVersion } from "../../plugins/runtime.js";

export const selectionMetadata = createPluginMetadataSnapshotFixture({
  plugins: [
    { id: "cron-harness", activation: { onAgentHarnesses: ["codex"] } },
    { id: "cron-cli", cliBackends: ["claude-cli", "test-cli"] },
  ],
});
const selectionRoutes: Record<string, readonly string[]> = {
  openai: ["openclaw", "codex", "claude-cli", "test-cli"],
  anthropic: ["openclaw", "codex", "claude-cli"],
  "claude-cli": ["claude-cli"],
  "test-cli": ["test-cli"],
  "rooted-only": ["codex"],
  google: ["openclaw"],
  gateway: ["openclaw"],
  deepseek: ["openclaw"],
  ollama: ["openclaw"],
  openrouter: ["openclaw"],
  vllm: ["openclaw"],
  custom: ["openclaw"],
  fixture: ["openclaw"],
  mock: ["openclaw"],
  "test-provider": ["openclaw"],
  "fallback-provider": ["openclaw"],
};
let selectionGeneration = 0;

/** Installs the catalog and backend registrations consumed by the real selection/preflight owners. */
export function resetCronModelRuntimeFixture(params: {
  loadModelCatalog: Mock;
  loadModelCatalogOwner: Mock;
  loadPublishedReplyDispatchRuntime: Mock;
  acquirePreparedModelRuntime: Mock;
  preparedRunPluginRegistry: Mock;
  resolveAgentWorkspaceDir: Mock;
}): void {
  selectionGeneration++;
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: "cron-harness",
    source: "test",
    harness: {
      id: "codex",
      label: "Cron native harness fixture",
      supports: ({ provider }) => ({
        supported: selectionRoutes[provider]?.includes("codex") === true,
      }),
      runAttempt: async () => {
        throw new Error("Cron orchestration fixtures execute through runEmbeddedAgentMock.");
      },
    },
  });
  for (const [id, modelProvider] of [
    ["claude-cli", "anthropic"],
    ["test-cli", "openai"],
  ] as const) {
    registry.cliBackends.push({
      pluginId: "cron-cli",
      source: "test",
      backend: { id, modelProvider, config: { command: "fixture-cli" } },
    });
  }
  params.preparedRunPluginRegistry.mockReturnValue(registry);
  params.loadModelCatalog.mockResolvedValue([]);
  params.loadPublishedReplyDispatchRuntime.mockResolvedValue(undefined);
  params.acquirePreparedModelRuntime.mockImplementation(async (input, options) => {
    const preparedRegistry = params.preparedRunPluginRegistry();
    const metadata =
      options?.pluginGeneration?.pluginMetadataSnapshot ??
      options?.pluginMetadataSnapshot ??
      selectionMetadata;
    return {
      snapshot: { ...input, metadataSnapshot: metadata, pluginRegistry: preparedRegistry },
      pluginGeneration: {
        ...options?.pluginGeneration,
        pluginMetadataSnapshot: metadata,
        pluginRegistry: preparedRegistry,
      },
      [Symbol.asyncDispose]: vi.fn(async () => {}),
    };
  });
  params.loadModelCatalogOwner.mockImplementation(
    async (input: {
      agentId?: string;
      agentDir?: string;
      config: object;
      workspaceDir?: string;
    }) => {
      const agentId = input.agentId ?? "default";
      return {
        agentId,
        agentDir: input.agentDir ?? "/tmp/agent-dir",
        workspaceDir: input.workspaceDir ?? params.resolveAgentWorkspaceDir(input.config, agentId),
        config: input.config,
        modelCatalog: { entries: await params.loadModelCatalog(input), routeVariants: [] },
      };
    },
  );
  vi.mocked(evaluatePublishedModelRuntimeChoice).mockImplementation(
    async ({ provider, model, runtimeId }) => {
      if (!["openclaw", "codex", "claude-cli", "test-cli"].includes(runtimeId)) {
        return { kind: "unknown", message: "The test runtime is not registered." };
      }
      const supportedExecutors = selectionRoutes[provider.toLowerCase()];
      if (!supportedExecutors) {
        return { kind: "unknown", message: "The test route is not registered." };
      }
      if (!supportedExecutors.includes(runtimeId)) {
        return {
          kind: "unsupported",
          message: "This test executor cannot run the selected route.",
        };
      }
      const generation = selectionGeneration;
      const activeRegistry = getActivePluginRegistry();
      const registryVersion = getActivePluginRegistryVersion();
      const authRevision = getRuntimeAuthProfileStoreCredentialsRevision();
      const catalogResult = params.loadModelCatalogOwner.mock.results.at(-1);
      const catalogOwner = catalogResult?.type === "return" ? await catalogResult.value : undefined;
      const dispatchResult = params.loadPublishedReplyDispatchRuntime.mock.results.at(-1);
      const dispatchOwner =
        dispatchResult?.type === "return" ? await dispatchResult.value : undefined;
      const loadCatalog = params.loadModelCatalog.getMockImplementation();
      const catalog = catalogOwner?.modelCatalog;
      return {
        kind: "ready",
        entry: { provider, id: model, name: model },
        validate: () =>
          generation === selectionGeneration &&
          activeRegistry === getActivePluginRegistry() &&
          registryVersion === getActivePluginRegistryVersion() &&
          authRevision === getRuntimeAuthProfileStoreCredentialsRevision() &&
          catalogResult === params.loadModelCatalogOwner.mock.results.at(-1) &&
          dispatchResult === params.loadPublishedReplyDispatchRuntime.mock.results.at(-1) &&
          loadCatalog === params.loadModelCatalog.getMockImplementation() &&
          catalog === catalogOwner?.modelCatalog &&
          catalogOwner?.isCurrent?.() !== false &&
          dispatchOwner?.isCurrent?.() !== false
            ? undefined
            : "The model catalog changed. Try again.",
      };
    },
  );
}
