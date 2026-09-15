import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "./gateway-startup-plugin-plan.js";
import {
  collectConfiguredAgentModelProviderIds,
  manifestOwnsConfiguredModelProvider,
} from "./gateway-startup-plugin-providers.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";

function createManifestRecord(
  plugin: Pick<PluginManifestRecord, "id"> & Partial<PluginManifestRecord>,
): PluginManifestRecord {
  return {
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: `/tmp/plugins/${plugin.id}`,
    source: `/tmp/plugins/${plugin.id}/index.ts`,
    manifestPath: `/tmp/plugins/${plugin.id}/openclaw.plugin.json`,
    ...plugin,
  };
}

function createManifestRegistry(
  plugins: Array<Pick<PluginManifestRecord, "id"> & Partial<PluginManifestRecord>>,
): PluginManifestRegistry {
  return { plugins: plugins.map(createManifestRecord), diagnostics: [] };
}

describe("configured Gateway model provider ownership", () => {
  it("does not inspect model catalogs when no agent model refs are configured", () => {
    const registry = createManifestRegistry([
      {
        id: "unused",
        providers: ["unused"],
        modelCatalog: {
          providers: {
            unused: {
              get models(): never {
                throw new Error("unconfigured catalog was inspected");
              },
            },
          },
        },
      },
    ]);

    expect(collectConfiguredAgentModelProviderIds({}, registry)).toEqual(new Set());
  });

  it("does not normalize unrelated rows in a large catalog", () => {
    let unrelatedNormalizationReads = 0;
    const unrelatedModels = Array.from({ length: 10_000 }, (_, index) => ({
      id: `unrelated-${index}`,
      get name() {
        unrelatedNormalizationReads += 1;
        return `Unrelated ${index}`;
      },
    }));
    const registry = createManifestRegistry([
      {
        id: "selected",
        providers: ["selected"],
        modelCatalog: {
          providers: {
            selected: {
              api: "bedrock-converse-stream",
              models: [{ id: "requested" }, ...unrelatedModels],
            },
          },
        },
      },
      {
        id: "unrelated",
        providers: ["unrelated"],
        modelCatalog: {
          providers: {
            unrelated: { models: unrelatedModels },
          },
        },
      },
    ]);
    const config = {
      agents: { defaults: { model: "selected/requested" } },
    } as OpenClawConfig;

    expect(collectConfiguredAgentModelProviderIds(config, registry)).toEqual(new Set(["selected"]));
    expect(unrelatedNormalizationReads).toBe(0);
  });

  it("retains configured CLI backend providers even when model API is a core built-in", () => {
    const registry = createManifestRegistry([
      {
        id: "cursor-cli",
        providers: ["cursor-cli"],
        cliBackends: ["cursor-cli"],
        modelCatalog: {
          providers: {
            "cursor-cli": {
              api: "openai-completions",
              models: [{ id: "auto" }],
            },
          },
        },
      },
    ]);
    const config = {
      models: {
        providers: {
          "cursor-cli": {
            baseUrl: "cli://cursor-agent",
            api: "openai-completions",
            models: [{ id: "auto", name: "Auto" }],
          },
        },
      },
      agents: { defaults: { model: "cursor-cli/auto" } },
    } as unknown as OpenClawConfig;

    expect(collectConfiguredAgentModelProviderIds(config, registry)).toEqual(
      new Set(["cursor-cli"]),
    );
  });
  it("keeps an HTTP provider lazy when the manifest declares no CLI backend for it", () => {
    const registry = createManifestRegistry([
      {
        id: "http-owner",
        providers: ["ordinary-http"],
      },
    ]);
    const config = {
      models: {
        providers: {
          "ordinary-http": {
            baseUrl: "https://provider.invalid/v1",
            api: "openai-completions",
            models: [{ id: "model", name: "Model" }],
          },
        },
      },
      agents: { defaults: { model: "ordinary-http/model" } },
    } as unknown as OpenClawConfig;

    expect(collectConfiguredAgentModelProviderIds(config, registry)).toEqual(new Set());
  });

  it("does not load a plugin that does not own the configured provider id", () => {
    const registry = createManifestRegistry([
      {
        id: "unrelated-plugin",
        providers: ["unrelated"],
        cliBackends: ["unrelated"],
      },
    ]);
    const config = {
      models: {
        providers: {
          "core-api-provider": {
            api: "anthropic-messages",
            models: [{ id: "auto", name: "Auto" }],
          },
        },
      },
      agents: { defaults: { model: { primary: "core-api-provider/auto" } } },
    } as unknown as OpenClawConfig;

    expect(collectConfiguredAgentModelProviderIds(config, registry)).toEqual(new Set());
  });

  it("retains a CLI backend whose id differs from the plugin provider ids", () => {
    const registry = createManifestRegistry([
      {
        id: "acme-plugin",
        providers: ["acme"],
        cliBackends: ["acme-cli"],
      },
    ]);
    const config = {
      models: {
        providers: {
          "acme-cli": {
            baseUrl: "cli://acme",
            api: "openai-completions",
            models: [{ id: "model", name: "Model" }],
          },
        },
      },
      agents: { defaults: { model: "acme-cli/model" } },
    } as unknown as OpenClawConfig;
    const configuredModelProviderIds = collectConfiguredAgentModelProviderIds(config, registry);

    expect(configuredModelProviderIds).toEqual(new Set(["acme-cli"]));
    expect(
      manifestOwnsConfiguredModelProvider({
        manifest: registry.plugins[0],
        configuredModelProviderIds,
      }),
    ).toBe(true);
  });

  it("recognizes CLI backend ownership from manifest cliBackends and setup.cliBackends", () => {
    const manifestFromTopLevel = createManifestRecord({
      id: "acme-cli",
      cliBackends: ["acme-cli"],
    });
    expect(
      manifestOwnsConfiguredModelProvider({
        manifest: manifestFromTopLevel,
        configuredModelProviderIds: new Set(["acme-cli"]),
      }),
    ).toBe(true);

    const manifestFromSetup = createManifestRecord({
      id: "setup-cli",
      setup: {
        cliBackends: ["setup-cli"],
      },
    });
    expect(
      manifestOwnsConfiguredModelProvider({
        manifest: manifestFromSetup,
        configuredModelProviderIds: new Set(["setup-cli"]),
      }),
    ).toBe(true);
  });

  it("retains a setup-only CLI backend whose model reuses a core built-in api", () => {
    const registry = createManifestRegistry([
      {
        id: "setup-cli",
        setup: { cliBackends: ["setup-cli"] },
      },
    ]);
    const config = {
      models: {
        providers: {
          "setup-cli": {
            baseUrl: "cli://setup",
            api: "openai-completions",
            models: [{ id: "auto", name: "Auto" }],
          },
        },
      },
      agents: { defaults: { model: "setup-cli/auto" } },
    } as unknown as OpenClawConfig;
    const configuredModelProviderIds = collectConfiguredAgentModelProviderIds(config, registry);

    expect(configuredModelProviderIds).toEqual(new Set(["setup-cli"]));
    expect(
      manifestOwnsConfiguredModelProvider({
        manifest: registry.plugins[0],
        configuredModelProviderIds,
      }),
    ).toBe(true);
  });

  it("retains a CLI backend when only the model entry reuses a core built-in api", () => {
    const registry = createManifestRegistry([
      {
        id: "cursor-cli",
        providers: ["cursor-cli"],
        cliBackends: ["cursor-cli"],
      },
    ]);
    const config = {
      models: {
        providers: {
          "cursor-cli": {
            baseUrl: "cli://cursor-agent",
            models: [{ id: "auto", name: "Auto", api: "openai-completions" }],
          },
        },
      },
      agents: { defaults: { model: "cursor-cli/auto" } },
    } as unknown as OpenClawConfig;

    expect(collectConfiguredAgentModelProviderIds(config, registry)).toEqual(
      new Set(["cursor-cli"]),
    );
  });

  it("loads only the selected CLI backend alongside an ordinary HTTP provider", () => {
    const registry = createManifestRegistry([
      { id: "cli-owner", cliBackends: ["selected-cli"] },
      { id: "http-owner", providers: ["ordinary-http"] },
    ]);
    const config = {
      models: {
        providers: {
          "ordinary-http": {
            baseUrl: "https://provider.invalid/v1",
            api: "openai-completions",
            models: [{ id: "model", name: "Model" }],
          },
          "selected-cli": {
            baseUrl: "cli://selected",
            api: "openai-completions",
            models: [{ id: "model", name: "Model" }],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "ordinary-http/model", fallbacks: ["selected-cli/model"] },
        },
      },
    } as unknown as OpenClawConfig;
    const configuredModelProviderIds = collectConfiguredAgentModelProviderIds(config, registry);

    expect(configuredModelProviderIds).toEqual(new Set(["selected-cli"]));
    expect(
      manifestOwnsConfiguredModelProvider({
        manifest: registry.plugins[0],
        configuredModelProviderIds,
      }),
    ).toBe(true);
    expect(
      manifestOwnsConfiguredModelProvider({
        manifest: registry.plugins[1],
        configuredModelProviderIds,
      }),
    ).toBe(false);
  });
});

describe("CLI backend startup plan", () => {
  function createStartupManifest(
    plugin: Pick<PluginManifestRecord, "id"> & Partial<PluginManifestRecord>,
  ): PluginManifestRecord {
    return {
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      origin: "workspace",
      rootDir: `/tmp/plugins/${plugin.id}`,
      source: `/tmp/plugins/${plugin.id}/index.cjs`,
      manifestPath: `/tmp/plugins/${plugin.id}/openclaw.plugin.json`,
      ...plugin,
    } as PluginManifestRecord;
  }

  function createStartupIndex(manifests: PluginManifestRecord[]): InstalledPluginIndex {
    return {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "test",
      generatedAtMs: 0,
      installRecords: {},
      plugins: manifests.map((manifest) => ({
        pluginId: manifest.id,
        manifestPath: manifest.manifestPath,
        manifestHash: `${manifest.id}-hash`,
        rootDir: manifest.rootDir,
        origin: manifest.origin ?? "workspace",
        enabled: true,
        startup: { sidecar: false, memory: false, agentHarnesses: [], configPaths: [] },
        compat: [],
      })),
      diagnostics: [],
    };
  }

  it("plans the configured CLI backend owner with a core built-in api", () => {
    const manifests = [
      createStartupManifest({
        id: "cursor-cli",
        providers: ["cursor-cli"],
        cliBackends: ["cursor-cli"],
        activation: { onStartup: false },
        modelCatalog: {
          providers: { "cursor-cli": { api: "openai-completions", models: [{ id: "auto" }] } },
        },
      }),
    ];
    const registry = { plugins: manifests, diagnostics: [] } as PluginManifestRegistry;
    const index = createStartupIndex(manifests);
    const config = {
      channels: {},
      models: {
        providers: {
          "cursor-cli": {
            baseUrl: "cli://cursor-agent",
            api: "openai-completions",
            models: [{ id: "auto", name: "Auto" }],
          },
        },
      },
      agents: { defaults: { model: { primary: "cursor-cli/auto" } } },
      plugins: { entries: { "cursor-cli": { enabled: true } } },
    } as unknown as OpenClawConfig;
    expect(
      resolveGatewayStartupPluginPlanFromRegistry({
        config,
        env: {},
        index,
        manifestRegistry: registry,
      }).pluginIds,
    ).toContain("cursor-cli");
  });
  it("keeps a disabled CLI backend owner out of the startup plan", () => {
    const manifests = [
      createStartupManifest({
        id: "cursor-cli",
        providers: ["cursor-cli"],
        cliBackends: ["cursor-cli"],
        activation: { onStartup: false },
      }),
    ];
    const registry = { plugins: manifests, diagnostics: [] } as PluginManifestRegistry;
    const index = createStartupIndex(manifests);
    const config = {
      channels: {},
      models: {
        providers: {
          "cursor-cli": {
            baseUrl: "cli://cursor-agent",
            api: "openai-completions",
            models: [{ id: "auto", name: "Auto" }],
          },
        },
      },
      agents: { defaults: { model: { primary: "cursor-cli/auto" } } },
      plugins: { entries: { "cursor-cli": { enabled: false } } },
    } as unknown as OpenClawConfig;
    expect(
      resolveGatewayStartupPluginPlanFromRegistry({
        config,
        env: {},
        index,
        manifestRegistry: registry,
      }).pluginIds,
    ).not.toContain("cursor-cli");
  });
});
