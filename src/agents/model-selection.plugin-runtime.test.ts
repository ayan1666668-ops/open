// Covers plugin-owned model id normalization through selection surfaces.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateSessionExecutionSelection } from "../commands/doctor/shared/session-execution-selection.js";
import { normalizePersistedSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
} from "../plugins/registry-lifecycle.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryVersion,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  getPreparedModelRuntimeAuthStore,
  setPreparedModelRuntimeAuthStore,
} from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

const normalizeProviderModelIdWithPluginMock = vi.fn();

function normalizeLegacyFixtureModel({
  provider,
  context,
}: {
  provider: string;
  context: { modelId?: string };
}) {
  return provider === "custom-provider" && context.modelId === "custom-legacy-model"
    ? "custom-modern-model"
    : undefined;
}

const emptyPluginMetadataSnapshot = {
  configFingerprint: "model-selection-plugin-runtime-test-empty-plugin-metadata",
  ...createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "google-model-normalizer",
        modelIdNormalization: {
          providers: {
            google: {
              aliases: {
                "gemini-3.1-pro": "gemini-3.1-pro-preview",
              },
            },
          },
        },
      },
    ],
  }),
};
const getCurrentPluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());
const loadPreparedModelCatalogSnapshotMock = vi.hoisted(() => vi.fn());
const publishedOwners = vi.hoisted(
  () => new WeakMap<OpenClawConfig, PreparedModelRuntimeSnapshot>(),
);

vi.mock("./prepared-model-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prepared-model-catalog.js")>()),
  getPublishedPreparedModelCatalogOwnerSnapshot: ({
    config,
    agentId,
    workspaceDir,
  }: { config?: OpenClawConfig; agentId?: string; workspaceDir?: string } = {}) => {
    const owner = config ? publishedOwners.get(config) : undefined;
    return owner &&
      (!agentId || agentId === owner.agentId) &&
      (!workspaceDir || workspaceDir === owner.workspaceDir) &&
      owner.isCurrent()
      ? owner
      : undefined;
  },
}));

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: unknown) =>
    normalizeProviderModelIdWithPluginMock(params),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: getCurrentPluginMetadataSnapshotMock,
}));

vi.mock("./model-catalog.runtime.js", () => ({
  loadManifestModelCatalog: () => [],
  loadProviderScopedThinkingCatalog: async () => [],
  readPreparedModelCatalog: async () => [],
  loadPreparedModelCatalogSnapshot: loadPreparedModelCatalogSnapshotMock,
}));

function publishRuntimeOwner(cfg: OpenClawConfig, modelIds: string[]) {
  const registry = getActivePluginRegistry();
  if (!registry) throw new Error("Expected the active fixture registry");
  const version = getActivePluginRegistryVersion();
  const epoch = capturePluginRegistryLifecycleEpoch(registry);
  const signal = capturePluginRegistryLifecycleSignal(registry, epoch);
  if (!signal) throw new Error("Expected the registry lifecycle signal");
  const entries = modelIds.map((id) => ({ provider: "custom-provider", id, name: id }));
  const authStore = Object.freeze({
    version: 1,
    profiles: Object.freeze({
      "custom-provider:fixture": Object.freeze({
        type: "api_key" as const,
        provider: "custom-provider",
        key: "synthetic-normalization-credential",
      }),
    }),
  });
  const owner: PreparedModelRuntimeSnapshot = {
    config: cfg,
    observationConfig: cfg,
    catalogOwner: { agentId: "main", workspaceDir: "/tmp/model-normalization" },
    agentId: "main",
    agentDir: "/tmp/model-normalization/agent",
    workspaceDir: "/tmp/model-normalization",
    activeProjectKeys: [],
    authModes: { "custom-provider": "api_key" },
    metadataSnapshot: emptyPluginMetadataSnapshot,
    pluginRegistry: registry,
    isCurrent: () =>
      publishedOwners.get(cfg) === owner &&
      getActivePluginRegistry() === registry &&
      getActivePluginRegistryVersion() === version &&
      !signal.aborted &&
      getPreparedModelRuntimeAuthStore(owner) === authStore,
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries, routeVariants: entries },
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    createStores() {
      const authStorage = AuthStorage.inMemory({});
      return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
    },
  };
  setPreparedModelRuntimeAuthStore(owner, authStore);
  publishedOwners.set(cfg, owner);
}

function migrateStoredModel(sessionId: string, model: string) {
  const migrated = migrateSessionExecutionSelection({
    entry: { sessionId, updatedAt: 1, providerOverride: "custom-provider", modelOverride: model },
    defaultProvider: "custom-provider",
    classifyExecutor: (id) => (id === "openclaw" ? "harness" : undefined),
  });
  const entry = normalizePersistedSessionEntryShape(migrated.entry);
  if (!entry) throw new Error("Expected Doctor's canonical session row");
  return entry;
}

let createModelSelectionStateForTest: typeof import("../auto-reply/reply/model-selection.js").createModelSelectionState;
let resolveSessionModelRef: typeof import("./session-model-ref.js").resolveSessionModelRef;

describe("model-selection plugin runtime normalization", () => {
  beforeAll(async () => {
    ({ createModelSelectionState: createModelSelectionStateForTest } =
      await import("../auto-reply/reply/model-selection.js"));
    ({ resolveSessionModelRef } = await import("./session-model-ref.js"));
  });

  afterEach(() => resetPluginRuntimeStateForTest());

  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    normalizeProviderModelIdWithPluginMock.mockReset();
    getCurrentPluginMetadataSnapshotMock.mockReset();
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(emptyPluginMetadataSnapshot);
    loadPreparedModelCatalogSnapshotMock.mockReset();
    loadPreparedModelCatalogSnapshotMock.mockResolvedValue({ entries: [], authoritative: true });
  });

  it("delegates provider-owned model id normalization to plugin runtime hooks", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);

    const { parseModelRef } = await import("./model-selection.js");

    expect(parseModelRef("custom-legacy-model", "custom-provider")).toEqual({
      provider: "custom-provider",
      model: "custom-modern-model",
    });
    expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalledWith({
      provider: "custom-provider",
      context: {
        provider: "custom-provider",
        modelId: "custom-legacy-model",
      },
    });
  });

  it("keeps static normalization while skipping plugin runtime hooks when disabled", async () => {
    const { parseModelRef } = await import("./model-selection.js");

    expect(
      parseModelRef("gemini-3.1-pro", "google", {
        allowPluginNormalization: false,
      }),
    ).toEqual({
      provider: "google",
      model: "gemini-3.1-pro-preview",
    });
    expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
  });

  it("keeps provider plugin normalization when inferring provider for bare defaults", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);

    const { resolveConfiguredModelRef } = await import("./model-selection.js");

    expect(
      resolveConfiguredModelRef({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "custom-legacy-model" },
              models: {
                "custom-provider/custom-legacy-model": {},
              },
            },
          },
        },
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
      }),
    ).toEqual({
      provider: "custom-provider",
      model: "custom-modern-model",
    });
  });

  it.each([
    ["keeps model visibility policy construction off plugin runtime hooks by default", undefined],
    [
      "propagates explicit plugin runtime normalization opt-in through model visibility policy",
      true,
    ],
  ] as const)("%s", async (_name, allowPluginNormalization) => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);
    const { createModelVisibilityPolicy } = await import("./model-visibility-policy.js");
    const policy = createModelVisibilityPolicy({
      cfg: {
        agents: { defaults: { models: { "custom-provider/custom-legacy-model": {} } } },
      },
      catalog: [],
      defaultProvider: "custom-provider",
      defaultModel: "custom-legacy-model",
      ...(allowPluginNormalization ? { allowPluginNormalization } : {}),
    });

    if (allowPluginNormalization) {
      expect(policy.allowedKeys.has("custom-provider/custom-modern-model")).toBe(true);
      expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalled();
    } else {
      expect(policy.allowedKeys.has("custom-provider/custom-legacy-model")).toBe(true);
      expect(policy.allowedKeys.has("custom-provider/custom-modern-model")).toBe(false);
      expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
    }
  });

  it("normalizes an unrestricted reply default before selecting it", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);
    const cfg = {
      agents: {
        defaults: { model: "custom-provider/custom-legacy-model", modelPolicy: { allow: [] } },
      },
    };
    publishRuntimeOwner(cfg, ["custom-modern-model"]);
    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      defaultProvider: "custom-provider",
      defaultModel: "custom-legacy-model",
      provider: "custom-provider",
      model: "custom-legacy-model",
      hasModelDirective: false,
    });

    expect({ provider: state.provider, model: state.model }).toEqual({
      provider: "custom-provider",
      model: "custom-modern-model",
    });
  });

  it("refuses a normalized reply after its prepared registry generation is replaced", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);
    const cfg = { agents: { defaults: { model: "custom-provider/custom-legacy-model" } } };
    publishRuntimeOwner(cfg, ["custom-modern-model"]);
    setActivePluginRegistry(createEmptyPluginRegistry());

    await expect(
      createModelSelectionStateForTest({
        cfg,
        agentCfg: cfg.agents.defaults,
        defaultProvider: "custom-provider",
        defaultModel: "custom-legacy-model",
        provider: "custom-provider",
        model: "custom-legacy-model",
        hasModelDirective: false,
      }),
    ).rejects.toThrow("Could not confirm support");
  });

  it("keeps plugin-normalized stored overrides allowed in auto-reply runtime selection", async () => {
    // Doctor resolves legacy model input before the reply consumes accepted intent.
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);

    const cfg = {
      agents: {
        defaults: {
          model: "custom-provider/custom-legacy-model",
          models: {
            "custom-provider/custom-legacy-model": {},
          },
        },
      },
    };
    const sessionKey = "agent:main:discord:channel:c1";
    publishRuntimeOwner(cfg, ["custom-modern-model"]);
    const sessionEntry = migrateStoredModel("plugin-normalized-stored", "custom-legacy-model");
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "custom-provider",
      defaultModel: "custom-legacy-model",
      provider: "custom-provider",
      model: "custom-legacy-model",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("custom-provider");
    expect(state.model).toBe("custom-modern-model");
    expect(sessionEntry.executionSelection).toEqual({
      state: "accepted",
      selection: {
        model: { provider: "custom-provider", id: "custom-modern-model" },
        executor: { kind: "harness", id: "openclaw" },
      },
      fallbackPermission: "explicit",
    });
  });

  it("keeps resolved persisted overrides off plugin runtime hooks", () => {
    normalizeProviderModelIdWithPluginMock.mockReturnValue("incorrectly-renormalized-model");

    expect(
      resolveSessionModelRef(
        {},
        {
          providerOverride: "custom-provider",
          modelOverride: "custom-modern-model",
          modelOverrideRouteResolution: "resolved",
        },
        "main",
      ),
    ).toEqual({
      provider: "custom-provider",
      model: "custom-modern-model",
    });
    expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
  });

  it("normalizes raw persisted overrides through plugin runtime hooks", () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(normalizeLegacyFixtureModel);

    expect(
      resolveSessionModelRef(
        {},
        {
          providerOverride: "custom-provider",
          modelOverride: "custom-legacy-model",
        },
        "main",
      ),
    ).toEqual({
      provider: "custom-provider",
      model: "custom-modern-model",
    });
    expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalledOnce();
  });

  it("reuses one lifecycle metadata snapshot across auto-reply model normalization", async () => {
    normalizeProviderModelIdWithPluginMock.mockReturnValue(undefined);
    const configuredRefs = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`custom-provider/model-${index}`, {}]),
    );
    const cfg = {
      agents: {
        defaults: {
          model: "custom-provider/model-0",
          modelPolicy: { allow: Object.keys(configuredRefs) },
          models: configuredRefs,
        },
      },
    };

    publishRuntimeOwner(
      cfg,
      Array.from({ length: 20 }, (_, index) => `model-${index}`),
    );
    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      defaultProvider: "custom-provider",
      defaultModel: "model-0",
      provider: "custom-provider",
      model: "model-0",
      hasModelDirective: false,
    });

    expect(state.allowedModelCatalog).toHaveLength(20);
    // Credential-placeholder discovery is process-scoped and may cold-load independently.
    const scopedMetadataReads = getCurrentPluginMetadataSnapshotMock.mock.calls.filter(
      ([lookup]) => lookup.config === cfg,
    );
    expect(scopedMetadataReads).toEqual([[{ config: cfg, allowWorkspaceScopedSnapshot: true }]]);
  });

  it("keeps concurrent model-policy runs isolated while sharing metadata", async () => {
    normalizeProviderModelIdWithPluginMock.mockReturnValue(undefined);
    let signalFirstCatalogLoad: (() => void) | undefined;
    let releaseFirstCatalogLoad: (() => void) | undefined;
    const firstCatalogLoadStarted = new Promise<void>((resolve) => {
      signalFirstCatalogLoad = resolve;
    });
    const firstCatalogLoadRelease = new Promise<void>((resolve) => {
      releaseFirstCatalogLoad = resolve;
    });
    loadPreparedModelCatalogSnapshotMock
      .mockImplementationOnce(async () => {
        signalFirstCatalogLoad?.();
        await firstCatalogLoadRelease;
        return { entries: [], authoritative: true };
      })
      .mockResolvedValue({ entries: [], authoritative: true });
    const createConfig = (model: string) => ({
      agents: {
        defaults: {
          modelPolicy: { allow: [`custom-provider/${model}`] },
          models: { [`custom-provider/${model}`]: {} },
        },
      },
    });
    const firstConfig = createConfig("first");
    const secondConfig = createConfig("second");

    const select = (cfg: ReturnType<typeof createConfig>, model: string) =>
      createModelSelectionStateForTest({
        cfg,
        agentCfg: cfg.agents.defaults,
        defaultProvider: "custom-provider",
        defaultModel: model,
        provider: "custom-provider",
        model,
        hasModelDirective: true,
      });

    const firstPromise = select(firstConfig, "first");
    await firstCatalogLoadStarted;
    const secondPromise = select(secondConfig, "second");
    await vi.waitFor(() => expect(loadPreparedModelCatalogSnapshotMock).toHaveBeenCalledTimes(2));
    releaseFirstCatalogLoad?.();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect([...first.allowedModelKeys]).toContain("custom-provider/first");
    expect([...first.allowedModelKeys]).not.toContain("custom-provider/second");
    expect([...second.allowedModelKeys]).toContain("custom-provider/second");
    expect([...second.allowedModelKeys]).not.toContain("custom-provider/first");
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledTimes(2);
    expect(getCurrentPluginMetadataSnapshotMock.mock.calls).toEqual([
      [{ config: firstConfig, allowWorkspaceScopedSnapshot: true }],
      [{ config: secondConfig, allowWorkspaceScopedSnapshot: true }],
    ]);
  });

  it("preserves runtime discovery fallback across configured, stored, and fallback refs", async () => {
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(undefined);
    const aliases = new Map([
      ["configured-legacy", "configured-modern"],
      ["stored-legacy", "stored-modern"],
      ["fallback-legacy", "fallback-modern"],
    ]);
    normalizeProviderModelIdWithPluginMock.mockImplementation(({ context }) => {
      const modelId = (context as { modelId?: string }).modelId ?? "";
      return aliases.get(modelId);
    });
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "custom-provider/configured-legacy",
            fallbacks: ["custom-provider/fallback-legacy"],
          },
          modelPolicy: {
            allow: ["custom-provider/configured-legacy", "custom-provider/stored-legacy"],
          },
          models: {
            "custom-provider/configured-legacy": {},
            "custom-provider/stored-legacy": {},
          },
        },
      },
    };
    const sessionKey = "agent:main:discord:channel:c1";
    publishRuntimeOwner(cfg, ["configured-modern", "stored-modern", "fallback-modern"]);
    const sessionEntry = migrateStoredModel("plugin-discovery-stored", "stored-legacy");

    const state = await createModelSelectionStateForTest({
      cfg,
      agentCfg: cfg.agents.defaults,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      defaultProvider: "custom-provider",
      defaultModel: "configured-legacy",
      provider: "custom-provider",
      model: "configured-legacy",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("custom-provider");
    expect(state.model).toBe("stored-modern");
    expect([...state.allowedModelKeys]).toEqual(
      expect.arrayContaining([
        "custom-provider/configured-modern",
        "custom-provider/stored-modern",
      ]),
    );
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledWith({
      config: cfg,
      allowWorkspaceScopedSnapshot: true,
    });
    expect(
      normalizeProviderModelIdWithPluginMock.mock.calls.map(
        ([call]) => (call as { context?: { modelId?: string } }).context?.modelId,
      ),
    ).toEqual(expect.arrayContaining(["configured-legacy", "stored-legacy", "fallback-legacy"]));
  });
});
