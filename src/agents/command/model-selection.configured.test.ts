import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import * as harnessRuntime from "../harness/runtime-plugin.js";
import { loadManifestModelCatalog } from "../model-catalog.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";
import { publish } from "../model-runtime-choice.test-support.js";
import { buildConfiguredModelCatalog } from "../model-selection-shared.js";
import { setPreparedModelRuntimeAuthStore } from "../prepared-model-runtime-auth.js";
import * as sessionPersistence from "./attempt-execution.shared.js";
import { resolveEmbeddedModelSelection } from "./model-selection.js";
import * as runtimeLoaders from "./runtime-loaders.js";

vi.mock("../model-catalog.js", { spy: true });

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:subagent:configured-selection";

function configuredModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 1024,
  };
}

function catalogEntry(provider: string, id: string): ModelCatalogEntry {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: `https://${provider}.invalid/v1`,
    reasoning: false,
    input: ["text"],
  };
}

function automaticEntry(model = "child", provider = "custom"): SessionEntry {
  return {
    sessionId: "configured-child",
    updatedAt: 1,
    executionSelection: {
      state: "accepted",
      selection: {
        model: { provider, id: model },
        executor: { kind: "harness", id: "openclaw" },
      },
      fallbackPermission: "configured",
    },
  };
}

beforeEach(() => {
  vi.spyOn(harnessRuntime, "ensureSelectedAgentHarnessPlugin").mockResolvedValue(undefined);
  vi.spyOn(runtimeLoaders, "loadTranscriptResolveRuntime").mockResolvedValue({
    resolveSessionTranscriptFile: async (params) => ({
      sessionFile: path.join(
        path.dirname(params.storePath ?? "/unused/sessions.json"),
        "turn.jsonl",
      ),
      sessionEntry: params.sessionEntry,
    }),
  });
  // Keep persistence local while exercising the real selection compiler and prepared catalog.
  vi.spyOn(sessionPersistence, "persistAgentSession").mockImplementation(async (params) => {
    const saved = structuredClone(params.entry);
    params.sessionStore[params.sessionKey] = saved;
    return saved;
  });
});

afterEach(() => vi.restoreAllMocks());

function createFixture(options: { manifestOwner?: boolean } = {}) {
  const workspaceDir = tempDirs.make("command-configured-selection-");
  const defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {
    model: { primary: "custom/base" },
    modelPolicy: { allow: ["custom/manual"] },
  };
  const custom: ModelProviderConfig = {
    api: "openai-completions",
    baseUrl: "https://custom.invalid/v1",
    agentRuntime: { id: "openclaw" },
    models: [configuredModel("base"), configuredModel("child"), configuredModel("manual")],
  };
  const cfg: OpenClawConfig = {
    agents: {
      entries: { main: { workspace: workspaceDir } },
      defaults,
    },
    models: { providers: { custom } },
  };
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: options.manifestOwner
      ? [
          {
            id: "custom-catalog",
            providers: ["custom"],
            modelCatalog: {
              providers: { custom: { models: [{ id: "child", name: "Manifest child" }] } },
            },
          },
        ]
      : [],
  });
  const registry = createEmptyPluginRegistry();
  const store: Record<string, SessionEntry> = { [sessionKey]: automaticEntry() };
  const entry = () => expectDefined(store[sessionKey], "configured selection fixture session");
  const inventory = vi.mocked(loadManifestModelCatalog).mockImplementation(() => {
    throw new Error("Configured selection must not require unrelated manifest inventory");
  });
  let manifestCatalog: ModelCatalogEntry[] = [];
  const setCatalog = (catalog: ModelCatalogEntry[]) => {
    manifestCatalog = catalog;
    inventory.mockReturnValue(catalog);
  };
  const select = (overrides: Partial<Parameters<typeof resolveEmbeddedModelSelection>[0]> = {}) => {
    const configuredThinkingCatalog = buildConfiguredModelCatalog({
      cfg,
      manifestPlugins: metadataSnapshot,
    });
    const entries = [...configuredThinkingCatalog, ...manifestCatalog];
    const owner = publish(() => true, cfg, {
      workspaceDir,
      metadataSnapshot,
      pluginRegistry: registry,
      modelCatalog: { entries, routeVariants: entries },
    });
    setPreparedModelRuntimeAuthStore(owner, {
      version: 1,
      profiles: Object.fromEntries(
        [...new Set(entries.map(({ provider }) => provider))].map((provider) => [
          `${provider}:fixture`,
          { type: "api_key" as const, provider, key: "synthetic-fixture-key" },
        ]),
      ),
    });
    return withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry: registry }, () =>
      resolveEmbeddedModelSelection({
        cfg,
        opts: { message: "Select the configured child", allowModelOverride: false },
        sessionEntry: entry(),
        sessionStore: store,
        sessionKey,
        sessionId: entry().sessionId,
        storePath: path.join(workspaceDir, "sessions.json"),
        sessionAgentId: "main",
        workspaceDir,
        pluginsEnabled: true,
        manifestMetadataSnapshot: metadataSnapshot,
        modelManifestContext: { manifestPlugins: metadataSnapshot },
        configuredThinkingCatalog,
        isSubagentLane: true,
        suppressVisibleSessionEffects: false,
        runContext: {},
        ...overrides,
      }),
    );
  };
  return { cfg, defaults, custom, store, entry, setCatalog, select };
}

describe("command selection with configured model facts", () => {
  it("retains an accepted child outside manual policy without manifest inventory", async () => {
    const fixture = createFixture();
    const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });
    const selected = await fixture.select();

    expect(selected).toMatchObject({
      provider: "custom",
      model: "child",
      requestedRouteResolution: "resolved",
      effectiveTurnThinkLevel: "off",
      sessionEntry: automaticEntry(),
      sessionEntryForAttempt: automaticEntry(),
    });
    expect(selected.thinkingCatalog).toContainEqual(
      expect.objectContaining({
        provider: "custom",
        id: "child",
        reasoning: false,
        configuredReasoning: false,
        api: "openai-completions",
        baseUrl: "https://custom.invalid/v1",
      }),
    );
    expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
    expect(sessionPersistence.persistAgentSession).not.toHaveBeenCalled();
  });

  it("retains declared capabilities for an unrestricted unconfigured selection", async () => {
    const fixture = createFixture();
    delete fixture.defaults.modelPolicy;
    fixture.defaults.model = { primary: "remote/unconfigured" };
    delete fixture.cfg.models;
    fixture.store[sessionKey] = { sessionId: "configured-child", updatedAt: 1 };
    const declared: ModelCatalogEntry = {
      ...catalogEntry("remote", "unconfigured"),
      input: ["text", "image"],
    };
    fixture.setCatalog([declared]);
    const configBefore = structuredClone(fixture.cfg);

    const selected = await fixture.select({
      configuredThinkingCatalog: [],
      requestedThinkLevel: "off",
    });

    expect(selected).toMatchObject({
      provider: "remote",
      model: "unconfigured",
      effectiveTurnThinkLevel: "off",
    });
    expect(selected.thinkingCatalog).toContainEqual(expect.objectContaining(declared));
    expect(fixture.cfg).toEqual(configBefore);
    expect(fixture.entry().executionSelection).toMatchObject({
      state: "accepted",
      selection: {
        model: { provider: "remote", id: "unconfigured" },
        executor: { kind: "harness", id: "openclaw" },
      },
    });
  });

  it("keeps an accepted literal model when its name collides with an alias", async () => {
    const fixture = createFixture();
    fixture.defaults.modelPolicy = {
      allow: ["custom/base", "custom/alias", "custom/actual"],
    };
    fixture.defaults.models = { "custom/actual": { alias: "alias" } };
    fixture.custom.models.push(configuredModel("alias"), configuredModel("actual"));
    fixture.store[sessionKey] = automaticEntry("alias");
    const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });

    const selected = await fixture.select();

    expect(selected).toMatchObject({
      provider: "custom",
      model: "alias",
      requestedRouteResolution: "resolved",
    });
    expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
  });

  it.each([
    { permission: false, error: "Model override is not authorized for this caller." },
    { permission: true, error: 'Model override "custom/child" is not allowed' },
  ])(
    "does not convert accepted child selection into explicit override permission ($permission)",
    async ({ permission, error }) => {
      const fixture = createFixture();
      fixture.setCatalog([catalogEntry("custom", "child")]);
      const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });

      await expect(
        fixture.select({
          opts: {
            message: "Explicit override",
            provider: "custom",
            model: "child",
            allowModelOverride: permission,
          },
        }),
      ).rejects.toThrow(error);

      expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
    },
  );

  it("retains unqualified policy inference from the manifest catalog", async () => {
    const fixture = createFixture();
    delete fixture.defaults.modelPolicy;
    fixture.defaults.models = { shared: {} };
    fixture.store[sessionKey] = automaticEntry("shared", "remote");
    fixture.setCatalog([catalogEntry("remote", "shared")]);
    const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });

    const selected = await fixture.select();

    expect(selected).toMatchObject({
      provider: "remote",
      model: "shared",
      requestedRouteResolution: "resolved",
    });
    expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
  });

  it("retains manifest-owned donor facts for an accepted configured child", async () => {
    const fixture = createFixture({ manifestOwner: true });
    fixture.setCatalog([
      {
        ...catalogEntry("custom", "child"),
        baseUrl: "https://donor.invalid/v1",
        contextWindow: 32_768,
      },
    ]);
    const before = structuredClone({ cfg: fixture.cfg, store: fixture.store });

    const selected = await fixture.select();

    expect(selected).toMatchObject({
      provider: "custom",
      model: "child",
      requestedRouteResolution: "resolved",
      effectiveTurnThinkLevel: "off",
    });
    expect(selected.thinkingCatalog).toContainEqual(
      expect.objectContaining({
        provider: "custom",
        id: "child",
        baseUrl: "https://donor.invalid/v1",
        contextWindow: 32_768,
        configuredReasoning: false,
      }),
    );
    expect({ cfg: fixture.cfg, store: fixture.store }).toEqual(before);
  });
});
