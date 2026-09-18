import path from "node:path";
import { afterEach, expect, onTestFinished, test } from "vitest";
import {
  listCliRuntimeModelBackendBindings,
  resolveCliRuntimeCanonicalProvider,
} from "../../agents/cli-backends.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { createSessionModelCatalogFixture } from "../../agents/test-helpers/session-model-catalog.test-support.js";
import { migrateSessionExecutionSelection } from "../../commands/doctor/shared/session-execution-selection.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { adoptPersistedSessionSnapshot } from "../../config/sessions/session-snapshot.js";
import { normalizePersistedSessionEntryShape } from "../../config/sessions/store-entry-shape.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  commitStoredSessionExecutionSelection,
  resolveExecutionSelectionExecutorKind,
} from "../../model-picker/apply-session-model-selection.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { resolveStoredModelOverrideCore } from "../../sessions/stored-model-overrides.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createModelSelectionState } from "./model-selection.js";

afterEach(() => resetPluginRuntimeStateForTest());

const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "fixture",
      providers: ["custom", "custom/team", "demo-cli"],
      cliBackends: ["demo-cli"],
      modelIdNormalization: {
        providers: { custom: { aliases: { latest: "middle", middle: "final" } } },
      },
    },
  ],
});

function migrateEntry(
  cfg: OpenClawConfig,
  input: Record<string, unknown>,
  cliRuntimeProviders: ReadonlyMap<string, string>,
): SessionEntry {
  const migrated = migrateSessionExecutionSelection({
    entry: { sessionId: "resolved-pin", updatedAt: 1, ...input },
    defaultProvider: "custom",
    classifyExecutor: (id) => resolveExecutionSelectionExecutorKind(cfg, id),
    cliRuntimeProviders,
  });
  const entry = normalizePersistedSessionEntryShape(migrated.entry);
  if (!entry) {
    throw new Error("Expected Doctor's canonical session row");
  }
  return entry;
}

async function withPreparedFixture(
  cfg: OpenClawConfig,
  entries: ModelCatalogEntry[],
  run: (fixture: {
    storePath: string;
    catalog: ModelCatalogSnapshot;
    cliRuntimeProviders: ReadonlyMap<string, string>;
  }) => Promise<void>,
) {
  const state = await createOpenClawTestState({ scenario: "minimal" });
  onTestFinished(() => state.cleanup());
  const registry = createEmptyPluginRegistry();
  registry.cliBackends.push({
    pluginId: "fixture",
    source: "fixture",
    backend: {
      id: "demo-cli",
      modelProvider: "custom",
      config: { command: "false", input: "arg", output: "text" },
    },
  });
  setActivePluginRegistry(registry);
  const catalog: ModelCatalogSnapshot = {
    entries: entries.map((entry): ModelCatalogEntry => ({
      api: "openai-responses",
      baseUrl: "https://fixture.invalid/v1",
      reasoning: false,
      ...entry,
    })),
    routeVariants: [],
    authoritative: true,
  };
  await withPluginRuntimeGenerationScope(
    { metadataSnapshot, pluginRegistry: registry },
    async () => {
      createSessionModelCatalogFixture().publish({
        config: cfg,
        agentId: "main",
        catalog,
        plugins: metadataSnapshot.plugins,
        profiles: {
          "custom:work": { type: "api_key", provider: "custom", key: "synthetic-test-key" },
          "custom/team:work": {
            type: "api_key",
            provider: "custom/team",
            key: "synthetic-test-key",
          },
        },
        runtimeAuthModes: { "demo-cli": "oauth" },
      });
      const cliRuntimeProviders = new Map(
        listCliRuntimeModelBackendBindings({ config: cfg, includeSetupRegistry: true }).map(
          ({ runtime, provider }) => [runtime, provider],
        ),
      );
      await run({
        storePath: path.join(state.sessionsDir(), "sessions.json"),
        catalog,
        cliRuntimeProviders,
      });
    },
  );
}

async function seedEntry(storePath: string, sessionKey: string, entry: SessionEntry) {
  const persisted = await replaceSessionEntry({ storePath, sessionKey }, entry);
  if (!persisted) {
    throw new Error("Expected the initial session row to be persisted");
  }
  adoptPersistedSessionSnapshot(entry, persisted);
}

test("keeps thinking defaults separate for distinct literal model IDs", async () => {
  const cfg: OpenClawConfig = {
    plugins: { entries: { fixture: { enabled: true } } },
    agents: {
      defaults: {
        model: "custom/model",
      },
    },
  };
  await withPreparedFixture(
    cfg,
    [
      { provider: "custom", id: "model", name: "Plain", reasoning: false },
      { provider: "custom", id: "custom/model", name: "Namespaced", reasoning: true },
    ],
    async ({ catalog }) => {
      const selection = await createModelSelectionState({
        cfg,
        agentId: "main",
        agentCfg: cfg.agents?.defaults,
        defaultProvider: "custom",
        defaultModel: "model",
        provider: "custom",
        model: "model",
        hasModelDirective: false,
        prepareExecution: true,
        preparedModelCatalog: catalog,
      });
      expect(
        await selection.resolveDefaultThinkingLevel({
          provider: "custom",
          model: "model",
          agentRuntime: "openclaw",
        }),
      ).toBe("off");
      expect(
        await selection.resolveDefaultThinkingLevel({
          provider: "custom",
          model: "custom/model",
          agentRuntime: "openclaw",
        }),
      ).toBe("medium");
    },
  );
});

test.each(["origin", "notice"] as const)(
  "keeps migrated %s intent when a heartbeat uses another literal model",
  async (source) => {
    const cfg: OpenClawConfig = {
      plugins: { entries: { fixture: { enabled: true } } },
      agents: { defaults: { model: "custom/custom/model" } },
    };
    await withPreparedFixture(
      cfg,
      ["model", "custom/model", "fallback"].map((id) => ({ provider: "custom", id, name: id })),
      async ({ storePath, catalog, cliRuntimeProviders }) => {
        const entry = migrateEntry(
          cfg,
          {
            sessionId: "heartbeat",
            providerOverride: "custom",
            modelOverride: "fallback",
            modelOverrideSource: "auto",
            modelOverrideRouteResolution: "resolved",
            ...(source === "origin"
              ? {
                  modelOverrideFallbackOriginProvider: "custom",
                  modelOverrideFallbackOriginModel: "model",
                }
              : {
                  fallbackNotice: {
                    kind: "active",
                    selectedModel: "custom/model",
                    activeModel: "custom/fallback",
                  },
                }),
          },
          cliRuntimeProviders,
        );
        const humanModel = source === "origin" ? "model" : "fallback";
        expect(entry.executionSelection).toEqual({
          state: "deferred",
          request: { model: { provider: "custom", id: humanModel } },
          fallbackPermission: "configured",
        });
        const sessionKey = "agent:main:heartbeat";
        await seedEntry(storePath, sessionKey, entry);
        const params = {
          cfg,
          agentId: "main",
          agentCfg: cfg.agents?.defaults,
          sessionEntry: entry,
          sessionStore: { [sessionKey]: entry },
          sessionKey,
          storePath,
          defaultProvider: "custom",
          defaultModel: "custom/model",
          provider: "custom",
          model: "custom/model",
          hasModelDirective: false,
          prepareExecution: true,
          preparedModelCatalog: catalog,
        };
        const human = await createModelSelectionState(params);
        expect(human.executionSelection).toEqual({
          model: { provider: "custom", id: humanModel },
          executor: { kind: "harness", id: "openclaw" },
        });
        const before = structuredClone(entry);
        const heartbeat = await createModelSelectionState({
          ...params,
          hasResolvedHeartbeatModelOverride: true,
        });
        expect(heartbeat.executionSelection).toEqual({
          model: { provider: "custom", id: "custom/model" },
          executor: { kind: "harness", id: "openclaw" },
        });
        expect(entry).toEqual(before);
        expect(loadSessionEntryReadOnly({ storePath, sessionKey })).toEqual(before);
        if (source === "notice") {
          expect(entry.fallbackNotice).toEqual({
            kind: "active",
            selectedModel: "custom/model",
            activeModel: "custom/fallback",
          });
        }
      },
    );
  },
);

type SelectionCase = {
  name: string;
  pin: string;
  provider?: string;
  allow?: string[];
  readerModel?: string;
  raw?: boolean;
  inherited?: boolean;
  locked?: boolean;
  configuredProvider?: boolean;
  heartbeat?: boolean;
  oneTurn?: boolean;
  cli?: boolean;
  missingAuthPin?: boolean;
} & (
  | { expected: string; rejection?: undefined }
  | { rejection: "forbidden" | "unavailable"; expected?: never }
);

test.each<SelectionCase>([
  { name: "resolved provider-prefixed model", pin: "custom/model", expected: "custom/model" },
  { name: "resolved alias-like model", pin: "middle", expected: "middle" },
  { name: "legacy raw model normalized once", pin: "latest", expected: "middle", raw: true },
  { name: "disallowed pin", pin: "denied", rejection: "forbidden" },
  { name: "explicit heartbeat override", pin: "middle", expected: "heartbeat", heartbeat: true },
  { name: "one-turn override", pin: "middle", expected: "once", oneTurn: true },
  { name: "bound CLI provider", pin: "cli-model", expected: "cli-model", cli: true },
  { name: "missing auth pin", pin: "plain-model", rejection: "unavailable", missingAuthPin: true },
  {
    name: "resolved prefix rejected by a colliding exact allowlist",
    pin: "custom/model",
    allow: ["custom/default", "custom/model"],
    rejection: "forbidden",
  },
  {
    name: "inherited resolved prefix rejected by a colliding exact allowlist",
    pin: "custom/model",
    allow: ["custom/default", "custom/model"],
    rejection: "forbidden",
    inherited: true,
  },
  {
    name: "raw prefix allowed as the plain model",
    pin: "custom/model",
    expected: "model",
    readerModel: "model",
    allow: ["custom/default", "custom/model"],
    raw: true,
  },
  {
    name: "locked resolved prefix outside the exact allowlist",
    pin: "custom/model",
    expected: "custom/model",
    allow: ["custom/default", "custom/model"],
    locked: true,
  },
  {
    name: "resolved prefix allowed by the provider wildcard",
    pin: "custom/model",
    expected: "custom/model",
    allow: ["custom/*"],
  },
  {
    name: "inherited resolved prefix allowed by its namespace wildcard",
    pin: "custom/model",
    expected: "custom/model",
    allow: ["custom/default", "custom/custom/*"],
    inherited: true,
  },
  {
    name: "namespace wildcard rejects a different model prefix",
    pin: "customness/model",
    allow: ["custom/default", "custom/custom/*"],
    rejection: "forbidden",
  },
  {
    name: "exact model namespace does not authorize another provider",
    provider: "custom/team",
    pin: "Reader",
    allow: ["custom/default", "custom/team/Reader"],
    rejection: "forbidden",
  },
  {
    name: "provider wildcard does not authorize another provider",
    provider: "custom/team",
    pin: "Reader",
    allow: ["custom/*"],
    rejection: "forbidden",
  },
  {
    name: "resolved prefix allowed by its exact configured ref",
    pin: "custom/model",
    expected: "custom/model",
    allow: ["custom/default", "custom/custom/model"],
    configuredProvider: true,
  },
  {
    name: "exact configured prefix does not authorize the plain model",
    pin: "model",
    allow: ["custom/default", "custom/custom/model"],
    configuredProvider: true,
    rejection: "forbidden",
  },
])("selects $name through the reply owner", async (fixture) => {
  const allow =
    fixture.allow ?? (fixture.rejection === "forbidden" ? ["custom/default"] : undefined);
  const cfg: OpenClawConfig = {
    plugins: { entries: { fixture: { enabled: true } } },
    agents: {
      entries: { main: {} },
      defaults: {
        model: "custom/default",
        ...(allow ? { modelPolicy: { allow } } : {}),
      },
    },
    ...(fixture.configuredProvider
      ? {
          models: {
            providers: {
              custom: { api: "openai-responses", baseUrl: "https://custom.example/v1", models: [] },
            },
          },
        }
      : {}),
  };
  const entries = [
    "default",
    "model",
    "custom/model",
    "customness/model",
    "team/Reader",
    "middle",
    "final",
    "denied",
    "cli-model",
    "plain-model",
    "heartbeat",
    "once",
  ].map((id) => ({ provider: "custom", id, name: id }));
  entries.push({ provider: "custom/team", id: "Reader", name: "Other provider" });
  await withPreparedFixture(cfg, entries, async ({ storePath, catalog, cliRuntimeProviders }) => {
    if (fixture.cli) {
      expect(
        resolveCliRuntimeCanonicalProvider({
          runtime: "demo-cli",
          config: cfg,
          includeSetupRegistry: true,
        }),
      ).toBe("custom");
    }
    const provider = fixture.provider ?? (fixture.cli ? "demo-cli" : "custom");
    const pinnedEntry = migrateEntry(
      cfg,
      {
        providerOverride: provider,
        modelOverride: fixture.pin,
        modelOverrideSource: "user",
        ...(!fixture.raw ? { modelOverrideRouteResolution: "resolved" } : {}),
        ...(fixture.missingAuthPin
          ? { authProfileOverride: "missing-test-profile", authProfileOverrideSource: "user" }
          : {}),
        ...(fixture.cli
          ? { cliSessionBindings: { "demo-cli": { sessionId: "fixture-session" } } }
          : {}),
        ...(fixture.locked ? { modelSelectionLocked: true } : {}),
      },
      cliRuntimeProviders,
    );
    const readerModel = fixture.readerModel ?? (fixture.raw ? "middle" : fixture.pin);
    const canonicalProvider = fixture.cli ? "custom" : provider;
    expect(
      resolveStoredModelOverrideCore({ sessionEntry: pinnedEntry, defaultProvider: "custom" }),
    ).toEqual({
      provider: canonicalProvider,
      model: readerModel,
      source: "session",
      routeResolution: "resolved",
    });
    const entry: SessionEntry = fixture.inherited
      ? { sessionId: "child", updatedAt: 1 }
      : pinnedEntry;
    if (fixture.inherited) {
      commitStoredSessionExecutionSelection(entry, {
        state: "deferred",
        request: { defaultSelection: "inherit" },
        fallbackPermission: "configured",
      });
    }
    const sessionKey = "agent:main:resolved-pin";
    const parentSessionKey = "agent:main:parent-pin";
    if (fixture.inherited) {
      await seedEntry(storePath, parentSessionKey, pinnedEntry);
    }
    await seedEntry(storePath, sessionKey, entry);
    const before = structuredClone(entry);
    const pinnedBefore = structuredClone(pinnedEntry);
    const pending = createModelSelectionState({
      cfg,
      agentId: "main",
      agentCfg: cfg.agents?.defaults,
      sessionEntry: entry,
      sessionStore: { [sessionKey]: entry },
      sessionKey,
      storePath,
      parentSessionKey: fixture.inherited ? parentSessionKey : undefined,
      defaultProvider: "custom",
      defaultModel: "default",
      provider: "custom",
      model: fixture.oneTurn ? "once" : fixture.heartbeat ? "heartbeat" : "default",
      hasModelDirective: false,
      prepareExecution: true,
      hasOneTurnModelOverride: fixture.oneTurn,
      hasResolvedHeartbeatModelOverride: fixture.heartbeat,
      preparedModelCatalog: catalog,
    });
    if (fixture.rejection) {
      await expect(pending).rejects.toThrow(
        fixture.rejection === "forbidden"
          ? "This model is not available for this agent."
          : "Could not change models. Sign in to OpenClaw, then try again.",
      );
      expect(entry).toEqual(before);
    } else {
      const selection = await pending;
      const expectedSelection = {
        model: { provider: "custom", id: fixture.expected },
        executor: fixture.cli
          ? { kind: "cli", id: "demo-cli" }
          : { kind: "harness", id: "openclaw" },
      };
      expect(selection).toMatchObject({
        provider: "custom",
        model: fixture.expected,
        executionSelection: expectedSelection,
      });
      if (fixture.heartbeat || fixture.oneTurn) {
        expect(entry).toEqual(before);
      } else {
        expect(entry.executionSelection).toEqual({
          state: "accepted",
          fallbackPermission: "explicit",
          selection: expectedSelection,
        });
      }
    }
    expect(loadSessionEntryReadOnly({ storePath, sessionKey })).toEqual(entry);
    if (fixture.inherited) {
      expect(pinnedEntry).toEqual(pinnedBefore);
      expect(loadSessionEntryReadOnly({ storePath, sessionKey: parentSessionKey })).toEqual(
        pinnedBefore,
      );
    }
    if (fixture.locked) {
      expect(entry.modelSelectionLocked).toBe(true);
    }
    if (fixture.cli) {
      expect(entry.cliSessionBindings).toEqual({ "demo-cli": { sessionId: "fixture-session" } });
    }
    if (fixture.missingAuthPin) {
      expect(entry).toMatchObject({
        authProfileOverride: "missing-test-profile",
        authProfileOverrideSource: "user",
      });
    }
  });
});
