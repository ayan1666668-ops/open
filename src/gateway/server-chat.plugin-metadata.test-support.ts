import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { rebasePluginMetadataSnapshotManifestRegistry } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

export function createGatewayPluginMetadataSnapshot(
  config: OpenClawConfig,
): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash(config);
  const index: PluginMetadataSnapshot["index"] = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash,
    generatedAtMs: 0,
    installRecords: {},
    // Matches the real isolated bundled snapshot: no installed-index rows,
    // with the selected bundled manifests supplied below.
    plugins: [],
    diagnostics: [],
  };
  const emptySnapshot: PluginMetadataSnapshot = {
    policyHash,
    index,
    registryIndex: index,
    registryDiagnostics: [],
    manifestRegistry: { plugins: [], diagnostics: [] },
    plugins: [],
    diagnostics: [],
    byPluginId: new Map(),
    normalizePluginId: (pluginId) => pluginId,
    declaredProviderOwners: new Map(),
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
      modelIdNormalizationPolicies: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 0,
    },
  };
  return rebasePluginMetadataSnapshotManifestRegistry(emptySnapshot, {
    plugins: [
      {
        id: "openai",
        channels: [],
        providers: ["openai"],
        cliBackends: [],
        syntheticAuthRefs: [],
        providerAuthChoices: [
          { provider: "openai", method: "oauth", choiceId: "openai" },
          {
            provider: "openai",
            method: "device-code",
            choiceId: "openai-device-code",
          },
          { provider: "openai", method: "api-key", choiceId: "openai-api-key" },
        ],
        modelSupport: { modelPrefixes: ["gpt-", "o1", "o3", "o4"] },
        skills: [],
        hooks: [],
        origin: "bundled",
        rootDir: "/test/openai",
        source: "/test/openai/index.ts",
        manifestPath: "/test/openai/openclaw.plugin.json",
      },
    ],
    diagnostics: [],
  });
}
