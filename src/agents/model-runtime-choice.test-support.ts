import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { buildInlineProviderModels } from "./embedded-agent-runner/model.inline-provider.js";
import { createPreparedConfiguredRuntimeModelLookup } from "./embedded-agent-runner/model.static-id.js";
import type { ModelRef } from "./model-ref-shared.js";
import {
  getPreparedModelRuntimeAuthStore,
  setPreparedModelRuntimeAuthStore,
} from "./prepared-model-runtime-auth.js";
import { prepareConfiguredModelAliases } from "./prepared-model-runtime.configured-completion.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";
import { buildConfiguredAgentSystemPrompt } from "./system-prompt-config.js";

const published = vi.hoisted((): { owner?: PreparedModelRuntimeSnapshot } => ({}));
export { published };
vi.mock("./prepared-model-catalog.js", () => ({
  getPublishedPreparedModelCatalogOwnerSnapshot: () => published.owner,
  preparePublishedModelCatalogOwnerSnapshot: () => Promise.resolve(published.owner),
  materializePreparedModelCatalogOwner: (owner: PreparedModelRuntimeSnapshot) => owner,
  withPreparedModelCatalogOwner: async <T>(
    _params: unknown,
    read: (owner: PreparedModelRuntimeSnapshot) => T | Promise<T>,
  ) => {
    if (!published.owner) {
      throw new Error("No published test model owner");
    }
    return await read(published.owner);
  },
}));

// Register the catalog owner mock before loading its runtime consumers.
const { prepareSessionExecutionSelection } =
  await import("../model-picker/apply-session-model-selection.js");

export const cfg: OpenClawConfig = { plugins: { enabled: false } };
export function publish(
  isCurrent = () => true,
  config = cfg,
  facts: Partial<
    Pick<
      PreparedModelRuntimeSnapshot,
      | "modelCatalog"
      | "configuredRuntimeModels"
      | "pluginRegistry"
      | "metadataSnapshot"
      | "agentDir"
      | "workspaceDir"
    >
  > = {},
) {
  const entry = { provider: "fixture", id: "model", name: "Model" };
  const configuredRuntimeModels = facts.configuredRuntimeModels ?? [];
  const metadataSnapshot = facts.metadataSnapshot ?? createPluginMetadataSnapshotFixture();
  const owner: PreparedModelRuntimeSnapshot = {
    config,
    observationConfig: config,
    catalogOwner: { agentId: "main", workspaceDir: facts.workspaceDir ?? "/tmp/runtime-choice" },
    agentId: "main",
    agentDir: "/tmp/runtime-choice/agent",
    workspaceDir: "/tmp/runtime-choice",
    activeProjectKeys: [],
    authModes: {},
    metadataSnapshot,
    isCurrent,
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: [entry], routeVariants: [entry] },
    configuredRuntimeModels,
    findConfiguredRuntimeModel: createPreparedConfiguredRuntimeModelLookup(
      configuredRuntimeModels,
      metadataSnapshot,
    ),
    inlineProviderModels: buildInlineProviderModels(config.models?.providers ?? {}, {
      providerMetadataOwners: facts.metadataSnapshot?.owners,
    }),
    createStores() {
      const authStorage = AuthStorage.inMemory({});
      return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
    },
    ...facts,
  };
  setPreparedModelRuntimeAuthStore(owner, {
    version: 1,
    profiles: Object.fromEntries(
      [...new Set(["fixture", ...Object.keys(config.models?.providers ?? {})])].map((provider) => [
        `${provider}:account`,
        { type: "api_key" as const, provider, key: "synthetic-credential" },
      ]),
    ),
  });
  published.owner = owner;
  return owner;
}

export function renderPublishedAliases(owner: PreparedModelRuntimeSnapshot) {
  const authStore = getPreparedModelRuntimeAuthStore(owner);
  if (!authStore) {
    throw new Error("Expected prepared fixture accounts");
  }
  const { authStorage, modelRegistry } = owner.createStores();
  const configuredModelAliases = prepareConfiguredModelAliases(
    {
      input: {
        config: owner.config,
        agentId: owner.agentId,
        agentDir: owner.agentDir,
        workspaceDir: owner.workspaceDir,
      },
      env: {},
      authStore,
      templateAuthStorage: authStorage,
      credentials: {},
      providerIds: [...new Set(owner.configuredRuntimeModels.map(({ provider }) => provider))],
      configuredModelRefs: owner.configuredRuntimeModels.map(({ provider, modelId }) => ({
        provider,
        modelId,
      })),
      configuredRuntimeModels: owner.configuredRuntimeModels,
      runtimeCapabilityModels: [],
      configuredGeneratedCatalogPluginIds: [],
    },
    {
      pluginMetadataSnapshot: owner.metadataSnapshot,
      pluginRegistry: owner.pluginRegistry,
      inlineProviderModels: [],
      configuredCatalogEntries: owner.modelCatalog.entries,
    },
    modelRegistry,
    owner.configuredRuntimeModels,
  );
  return buildConfiguredAgentSystemPrompt({
    config: owner.config,
    agentId: owner.agentId,
    workspaceDir: owner.workspaceDir ?? "/tmp/runtime-choice",
    preparedModelRuntime: { ...owner, configuredModelAliases },
  });
}

export async function prepareCreationForTest(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir?: string;
  raw: string;
  source: "override" | "automatic";
  resolvedRef?: ModelRef;
  fallbacks?: string[];
}) {
  return prepareSessionExecutionSelection({
    cfg: params.cfg,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    request:
      params.source === "automatic"
        ? { kind: "initialize" }
        : { kind: "model", model: { id: params.raw } },
    modelInput: { raw: params.raw, resolvedRef: params.resolvedRef, fallbacks: params.fallbacks },
  });
}
