import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectConfiguredAgentModelProviderIds,
  manifestOwnsConfiguredModelProvider,
} from "./gateway-startup-plugin-providers.js";
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

  it("keeps a configured CLI backend provider whose model reuses a core built-in api", () => {
    // A plugin-owned CLI backend carries a core built-in api name because the
    // config schema has no cli transport value. The manifest still owns the id,
    // so the Gateway has to load the plugin or dispatch fails with
    // "Unknown CLI backend".
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
            api: "openai-completions",
            models: [{ id: "auto", name: "Auto" }],
          },
        },
      },
      agents: { defaults: { model: { primary: "cursor-cli/auto" } } },
    } as unknown as OpenClawConfig;

    expect(collectConfiguredAgentModelProviderIds(config, registry)).toEqual(
      new Set(["cursor-cli"]),
    );
  });

  it("keeps a configured CLI backend whose id differs from the plugin's provider ids", () => {
    // The bundled google manifest shape: the CLI runtime id is declared only in
    // cliBackends while providers lists the HTTP provider ids.
    const registry = createManifestRegistry([
      {
        id: "google",
        providers: ["google", "google-vertex"],
        cliBackends: ["google-gemini-cli"],
      },
    ]);
    const config = {
      models: {
        providers: {
          "google-gemini-cli": {
            baseUrl: "cli://gemini",
            api: "openai-completions",
            models: [{ id: "auto", name: "Auto" }],
          },
        },
      },
      agents: { defaults: { model: { primary: "google-gemini-cli/auto" } } },
    } as unknown as OpenClawConfig;

    expect(collectConfiguredAgentModelProviderIds(config, registry)).toEqual(
      new Set(["google-gemini-cli"]),
    );
  });

  it("keeps an HTTP provider lazy when the manifest declares no CLI backend for it", () => {
    // Plain manifest-owned HTTP providers keep the existing startup behavior.
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
            baseUrl: "https://example.test/v1",
            api: "openai-completions",
            models: [{ id: "auto", name: "Auto" }],
          },
        },
      },
      agents: { defaults: { model: { primary: "core-api-provider/auto" } } },
    } as unknown as OpenClawConfig;

    expect(collectConfiguredAgentModelProviderIds(config, registry)).toEqual(new Set());
  });

  it("does not load a plugin that does not own a core built-in api name", () => {
    // The api name belongs to core, not to the manifest list, so no plugin load
    // is warranted for this provider id.
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

  it("matches a plugin that owns the configured id only through cliBackends", () => {
    const manifest = createManifestRecord({
      id: "google",
      providers: ["google"],
      cliBackends: ["google-gemini-cli"],
    });

    expect(
      manifestOwnsConfiguredModelProvider({
        manifest,
        configuredModelProviderIds: new Set(["google-gemini-cli"]),
      }),
    ).toBe(true);
    expect(
      manifestOwnsConfiguredModelProvider({
        manifest,
        configuredModelProviderIds: new Set(["google"]),
      }),
    ).toBe(true);
    expect(
      manifestOwnsConfiguredModelProvider({
        manifest,
        configuredModelProviderIds: new Set(["someone-else"]),
      }),
    ).toBe(false);
  });
});
