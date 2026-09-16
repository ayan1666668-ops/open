// Tests model selection resolution from directives, config, and session state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getContextWindowCaches,
  providerContextTokenCacheKey,
} from "../../agents/context-cache.js";
import {
  loadManifestModelCatalog,
  loadProviderScopedThinkingCatalog,
  readPreparedModelCatalog as loadModelCatalogLocal,
} from "../../agents/model-catalog.runtime.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { evaluatePublishedModelRuntimeChoice } from "../../agents/model-runtime-choice.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import * as activeThinkingPolicy from "../../plugins/provider-thinking-active.js";
import { prepareModelCatalogThinkingPolicies } from "../../plugins/provider-thinking.js";
import { isThinkingLevelSupported } from "../thinking.js";
import {
  createModelSelectionState as createModelSelectionStateOwner,
  resolveContextTokens,
} from "./model-selection.js";

const runtimeChoiceFixture = vi.hoisted(() => ({ generation: 0 }));
vi.mock("../../agents/model-runtime-choice.js", () => ({
  evaluatePublishedModelRuntimeChoice: vi.fn(),
}));
beforeEach(() => {
  runtimeChoiceFixture.generation++;
  vi.mocked(evaluatePublishedModelRuntimeChoice)
    .mockReset()
    .mockImplementation(async ({ provider, model }) => {
      const generation = runtimeChoiceFixture.generation;
      return {
        kind: "ready",
        entry: { provider, id: model },
        validate: () =>
          generation === runtimeChoiceFixture.generation
            ? undefined
            : "The model catalog changed. Try again.",
      };
    });
});

function createModelSelectionState(params: Parameters<typeof createModelSelectionStateOwner>[0]) {
  const defaults = params.cfg.agents?.defaults;
  const cfg =
    params.hasModelDirective || defaults?.model
      ? params.cfg
      : {
          ...params.cfg,
          agents: {
            ...params.cfg.agents,
            defaults: {
              ...defaults,
              model: { primary: params.defaultProvider + "/" + params.defaultModel },
            },
          },
        };
  return createModelSelectionStateOwner({ ...params, cfg });
}

type PersistReplySessionEntry =
  (typeof import("./session-entry-persistence.js"))["persistReplySessionEntry"];

const DEFAULT_MOCK_CATALOG_ENTRIES = vi.hoisted(() => [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.5" },
  { provider: "inferencer", id: "deepseek-v3-4bit-mlx", name: "DeepSeek V3" },
  { provider: "kimi", id: "kimi-code", name: "Kimi Code" },
  { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  { provider: "xai", id: "grok-4", name: "Grok 4" },
  { provider: "xai", id: "grok-4.20-reasoning", name: "Grok 4.20 (Reasoning)" },
]);

const cliBackendsMocks = vi.hoisted(() => ({
  resolveCliRuntimeCanonicalProvider: vi.fn(({ runtime }: { runtime: string }) =>
    runtime === "claude-cli" ? "anthropic" : undefined,
  ),
}));

const sessionPersistenceMocks = vi.hoisted(() => ({
  persistReplySessionEntry: vi.fn<PersistReplySessionEntry>(),
}));

const catalogRuntimeMocks = vi.hoisted(() => {
  const loadModelCatalog = vi.fn(
    async (_params?: unknown): Promise<unknown[]> => DEFAULT_MOCK_CATALOG_ENTRIES,
  );
  return {
    loadModelCatalog,
    // Delegate to the entries mock so per-test `loadModelCatalog.mockResolvedValueOnce`
    // still drives selection; tests that need a degraded snapshot override this directly.
    loadModelCatalogSnapshot: vi.fn(async (params?: unknown) => {
      const entries = await loadModelCatalog(params as never);
      return { entries, routeVariants: entries, authoritative: true };
    }),
  };
});

vi.mock("../../agents/cli-backends.js", () => ({
  resolveCliRuntimeCanonicalProvider: cliBackendsMocks.resolveCliRuntimeCanonicalProvider,
}));

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadManifestModelCatalog: vi.fn(() => []),
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: catalogRuntimeMocks.loadModelCatalog,
  loadPreparedModelCatalogSnapshot: catalogRuntimeMocks.loadModelCatalogSnapshot,
}));

vi.mock("../../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));

vi.mock("../../channels/plugins/session-conversation.js", () => ({
  resolveSessionParentSessionKey: (sessionKey?: string) =>
    sessionKey?.replace(/:thread:[^:]+$/, "").replace(/:topic:[^:]+$/, "") ?? null,
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () =>
    createPluginMetadataSnapshotFixture({
      plugins: [{ id: "fixture-runtime", activation: { onAgentHarnesses: ["codex"] } }],
    }),
}));

vi.mock("./session-entry-persistence.js", () => ({
  persistReplySessionEntry: sessionPersistenceMocks.persistReplySessionEntry,
}));

const authProfileStoreMock = vi.hoisted(() => {
  let store = { version: 1, profiles: {} } as {
    version: 1;
    profiles: Record<string, { type: "api_key"; provider: string; key: string }>;
  };
  const ensureAuthProfileStore = vi.fn(() => store);
  return {
    get store() {
      return store;
    },
    set store(next) {
      store = next;
    },
    ensureAuthProfileStore,
    reset() {
      store = { version: 1, profiles: {} };
      ensureAuthProfileStore.mockClear();
    },
  };
});

vi.mock("../../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore: authProfileStoreMock.ensureAuthProfileStore,
}));

// Alias-aware stub: mirrors the real isStoredCredentialCompatibleWithAuthProvider
// but inlines the claude-cli->anthropic alias so tests don't need live plugin metadata.
vi.mock("../../agents/auth-profiles/order.js", () => ({
  isStoredCredentialCompatibleWithAuthProvider: ({
    provider,
    credential,
  }: {
    provider: string;
    credential: { type: string; provider: string };
  }) => {
    const normalize = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const resolveAuthKey = (v: string) => {
      const n = normalize(v);
      // claude-cli is a deprecated choice id that resolves to the anthropic auth key
      if (n === "claudecli") {
        return "anthropic";
      }
      return n;
    };
    const providerKey = resolveAuthKey(provider);
    const credentialKey = resolveAuthKey(credential.provider);
    if (credentialKey === providerKey) {
      return true;
    }
    // OpenAI Codex compat: openai api_key credential works for openai-codex provider
    if (providerKey === "openaiapicodex" || providerKey === "openaicodex") {
      return credentialKey === "openai" && credential.type === "api_key";
    }
    return false;
  },
}));

afterEach(() => {
  getContextWindowCaches().discoveredTokenCache.clear();
  cliBackendsMocks.resolveCliRuntimeCanonicalProvider.mockClear();
  sessionPersistenceMocks.persistReplySessionEntry.mockReset();
  vi.mocked(loadManifestModelCatalog).mockReset();
  vi.mocked(loadManifestModelCatalog).mockReturnValue([]);
  authProfileStoreMock.reset();
  vi.mocked(loadProviderScopedThinkingCatalog).mockReset().mockResolvedValue([]);
});

const makeConfiguredModel = (overrides: Record<string, unknown> = {}) => ({
  id: "gpt-5.4",
  name: "GPT-5.4",
  reasoning: true,
  input: ["text"] as Array<"text">,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
  ...overrides,
});

describe("createModelSelectionState catalog loading", () => {
  function createInitialState(
    cfg: OpenClawConfig,
    provider: string,
    model: string,
    options: Partial<Parameters<typeof createModelSelectionState>[0]> = {},
  ) {
    return createModelSelectionState({
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultProvider: provider,
      defaultModel: model,
      provider,
      model,
      hasModelDirective: false,
      ...options,
    });
  }
  it.each(["user", "user-link", undefined] as const)(
    "preserves a missing explicit account (%s) while a model directive is prepared",
    async (source) => {
      const entry: SessionEntry = {
        sessionId: "qa-session",
        updatedAt: 1,
        authProfileOverride: "qa-provider:missing-account",
        authProfileOverrideSource: source,
        executionSelection: {
          state: "accepted",
          fallbackPermission: "explicit",
          selection: {
            model: { provider: "qa-provider", id: "qa-model" },
            executor: { kind: "harness", id: "openclaw" },
          },
        },
      };
      const initial = structuredClone(entry);
      const cfg: OpenClawConfig = {};
      const sessionStore = { main: entry };
      await createModelSelectionState({
        cfg,
        agentCfg: undefined,
        sessionEntry: entry,
        sessionStore,
        sessionKey: "main",
        defaultProvider: "qa-provider",
        defaultModel: "qa-model",
        provider: "qa-provider",
        model: "qa-model",
        hasModelDirective: true,
      });
      expect(entry).toEqual(initial);
      expect(sessionStore.main.authProfileOverride).toBe("qa-provider:missing-account");
      expect(authProfileStoreMock.ensureAuthProfileStore).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "retains automatic-primary reasoning from prepared=%s metadata outside manual policy",
    async (prepared) => {
      const automatic = {
        provider: "fixture",
        id: "automatic",
        name: "Automatic",
        api: "openai-completions" as const,
        baseUrl: "https://fixture.invalid/v1",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["xhigh"] },
      };
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: "fixture/automatic",
            modelPolicy: { allow: ["fixture/manual"] },
          },
        },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "https://fixture.invalid/v1",
              models: [makeConfiguredModel({ id: "manual", name: "Manual", reasoning: false })],
            },
          },
        },
      };
      vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValue([automatic]);
      const state = await createInitialState(
        cfg,
        "fixture",
        "automatic",
        prepared
          ? { preparedModelCatalog: { entries: [automatic], routeVariants: [] } }
          : undefined,
      );
      expect(state.modelPolicy.allows({ provider: "fixture", model: "automatic" })).toBe(false);
      expect(
        isThinkingLevelSupported({
          provider: "fixture",
          model: "automatic",
          level: "xhigh",
          catalog: await state.resolveThinkingCatalog(),
        }),
      ).toBe(true);
      await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
    },
  );

  it("skips full catalog loading for ordinary allowlist-backed turns", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    const cfg = {
      agents: {
        defaults: {
          thinkingDefault: "low",
          models: {
            "openai/gpt-5.4": {},
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [makeConfiguredModel()],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createInitialState(cfg, "openai", "gpt-5.4");

    expect(state.allowedModelKeys.has("openai/gpt-5.4")).toBe(true);
    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("low");
    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
  });

  it.each([
    { thinking: "high", agentThinking: undefined, expected: "high" },
    { thinking: "ultra", agentThinking: undefined, expected: "ultra" },
    { thinking: "high", agentThinking: false, expected: "off" },
    { thinking: "low", agentThinking: "high", expected: "high" },
    { thinking: "low", agentThinking: "extra-high", expected: "xhigh" },
  ] as const)(
    "resolves per-model thinking (shared=$thinking, agent=$agentThinking) ahead of global defaults",
    async ({ thinking, agentThinking, expected }) => {
      vi.mocked(loadModelCatalogLocal).mockClear();
      const cfg = {
        agents: {
          defaults: {
            thinkingDefault: "low",
            models: {
              "fixture/reasoning-model": {
                params: { thinking },
              },
            },
          },
          entries: {
            alpha: {
              models: {
                "fixture/reasoning-model": { params: { thinking: agentThinking } },
              },
            },
          },
        },
        models: {
          providers: {
            fixture: {
              baseUrl: "https://fixture.invalid/v1",
              models: [makeConfiguredModel({ id: "reasoning-model" })],
            },
          },
        },
      } as OpenClawConfig;

      const state = await createInitialState(cfg, "fixture", "reasoning-model", {
        agentId: "alpha",
      });

      await expect(state.resolveDefaultThinkingLevel()).resolves.toBe(expected);
      expect(loadModelCatalogLocal).not.toHaveBeenCalled();
    },
  );

  it("keeps per-model disabled params.thinking ahead of global thinkingDefault", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    const cfg = {
      agents: {
        defaults: {
          thinkingDefault: "low",
          models: {
            "deepseek/deepseek-v4-pro": {
              params: { thinking: false },
            },
          },
        },
      },
      models: {
        providers: {
          deepseek: {
            baseUrl: "https://api.deepseek.com/v1",
            models: [makeConfiguredModel({ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" })],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createInitialState(cfg, "deepseek", "deepseek-v4-pro");

    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("off");
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
  });

  it("uses the implicit model default when no global thinking default is configured", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": {},
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [makeConfiguredModel()],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createInitialState(cfg, "openai", "gpt-5.4");

    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("medium");
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
  });

  it.each([
    { reasoning: undefined, agentRuntime: undefined },
    { reasoning: false, agentRuntime: "codex" },
  ])(
    "hydrates thinking for its runtime (reasoning=$reasoning, runtime=$agentRuntime)",
    async ({ reasoning, agentRuntime }) => {
      vi.mocked(loadModelCatalogLocal).mockClear();
      vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValueOnce([
        { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
      ]);
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
            models: {
              "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [makeConfiguredModel({ reasoning: undefined })],
            },
          },
        },
      } as OpenClawConfig;

      const state = await createInitialState(cfg, "openai", "gpt-5.4", {
        preparedModelCatalog: agentRuntime
          ? {
              entries: [{ provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning }],
              routeVariants: [],
            }
          : undefined,
      });

      if (agentRuntime) {
        await state.resolveThinkingCatalog({
          provider: "openai",
          model: "gpt-5.4",
          agentRuntime: "openclaw",
        });
      }
      await expect(
        state.resolveDefaultThinkingLevel({ provider: "openai", model: "gpt-5.4", agentRuntime }),
      ).resolves.toBe("medium");
      expect(loadModelCatalogLocal).not.toHaveBeenCalled();
      expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledWith({
        config: cfg,
        agentId: undefined,
        provider: "openai",
        model: "gpt-5.4",
        agentRuntime: agentRuntime ?? "openclaw",
      });
    },
  );

  it("reloads embedded thinking metadata when clearing a native runtime pin", async () => {
    const embedded = {
      provider: "openai",
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
    };
    const sessionEntry = { agentRuntimeOverride: "codex" };
    vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValueOnce([embedded]);

    const prepared = await prepareModelSelectionRuntime({
      cfg: {
        agents: {
          defaults: { models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } } },
        },
      },
      agentId: "main",
      provider: "openai",
      model: "gpt-5.4",
      rawRuntime: "default",
      sessionEntry,
      catalog: [{ ...embedded, nativeRuntime: "codex", reasoning: true }],
    });

    expect(prepared).toMatchObject({ status: "ready", runtime: { kind: "clear" } });
    if (prepared.status !== "ready") {
      throw new Error(prepared.message);
    }
    expect(prepared.catalog).toEqual([embedded]);
    expect(sessionEntry.agentRuntimeOverride).toBe("codex");
    expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agentId: "main", agentRuntime: "openclaw" }),
    );
  });

  it.each([
    ["fixture-primary", 872_000],
    ["fixture-secondary", 922_000],
  ] as const)(
    "uses prepared prompt budgets without an authored %s provider row",
    async (provider, expected) => {
      vi.mocked(loadModelCatalogLocal).mockClear();
      catalogRuntimeMocks.loadModelCatalogSnapshot.mockClear();
      const entries = [
        {
          provider: "fixture-secondary",
          id: "shared-model",
          name: "Shared model",
          reasoning: false,
          contextWindow: 1_050_000,
          contextTokens: 922_000,
        },
        {
          provider: "fixture-primary",
          id: "shared-model",
          name: "Shared model",
          reasoning: false,
          contextWindow: 1_000_000,
          contextTokens: 872_000,
        },
      ];
      const cfg: OpenClawConfig = {
        agents: { defaults: { models: { [`${provider}/shared-model`]: {} } } },
      };
      const state = await createInitialState(cfg, provider, "shared-model", {
        preparedModelCatalog: { entries, routeVariants: entries, authoritative: true },
      });
      expect(
        resolveContextTokens({
          cfg,
          provider: state.provider,
          model: state.model,
          modelContextTokens: state.modelContextTokens,
          modelContextWindow: state.modelContextWindow,
        }),
      ).toBe(expected);
      // Thinking metadata retains automatic candidates outside the manual selection policy.
      expect(await state.resolveThinkingCatalog()).toEqual(entries);
      expect(loadModelCatalogLocal).not.toHaveBeenCalled();
      expect(catalogRuntimeMocks.loadModelCatalogSnapshot).not.toHaveBeenCalled();
      expect(loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["m", 1_000_000, false],
    ["fixture/m", 64_000, false],
    ["m", 1_000_000, true],
    ["fixture/m", 64_000, true],
  ] as const)(
    "preserves literal catalog identity for %s (%i tokens, reversed=%s)",
    async (model, expectedContextWindow, reversed) => {
      // Both literal rows must survive regardless of their shared display key or order.
      const models = [
        makeConfiguredModel({ id: "m", contextWindow: 1_000_000 }),
        makeConfiguredModel({ id: "fixture/m", contextWindow: 64_000 }),
      ];
      if (reversed) {
        models.reverse();
      }
      const cfg: OpenClawConfig = {
        agents: { defaults: { modelPolicy: { allow: [] } } },
        models: {
          providers: {
            fixture: {
              api: "openai-responses",
              baseUrl: "https://models.example/v1",
              models,
            },
          },
        },
      };
      const entries = [{ provider: "unrelated", id: "other", name: "Other" }];
      const state = await createInitialState(cfg, "fixture", model, {
        preparedModelCatalog: { entries, routeVariants: entries, authoritative: true },
      });

      expect(state.modelContextWindow).toBe(expectedContextWindow);
      expect(state.allowedModelCatalog).toEqual([
        ...models.map(({ id, contextWindow }) =>
          expect.objectContaining({ provider: "fixture", id, contextWindow }),
        ),
        entries[0],
      ]);
      expect(
        resolveContextTokens({
          cfg,
          provider: state.provider,
          model: state.model,
          modelContextWindow: state.modelContextWindow,
          modelContextTokens: state.modelContextTokens,
        }),
      ).toBe(expectedContextWindow);
    },
  );

  it("uses the prepared gateway owner catalog without an exact-generation reload", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    catalogRuntimeMocks.loadModelCatalogSnapshot.mockClear();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": {},
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [makeConfiguredModel({ reasoning: undefined })],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createInitialState(cfg, "openai", "gpt-5.4", {
      preparedModelCatalog: {
        entries: [{ provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true }],
        routeVariants: [],
        authoritative: true,
      },
    });

    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("medium");
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
    expect(catalogRuntimeMocks.loadModelCatalogSnapshot).not.toHaveBeenCalled();
  });

  it("carries prepared runtime thinking policy into ordinary configured turns", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    catalogRuntimeMocks.loadModelCatalogSnapshot.mockClear();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-mythos-5": {},
          },
        },
      },
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            models: [
              makeConfiguredModel({
                id: "claude-mythos-5",
                name: "Claude Mythos 5",
                reasoning: false,
              }),
            ],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createInitialState(cfg, "anthropic", "claude-mythos-5", {
      preparedModelCatalog: {
        entries: [
          {
            provider: "anthropic",
            id: "claude-mythos-5",
            name: "Claude Mythos 5",
            reasoning: false,
            configuredReasoning: false,
            thinkingPolicyProvider: "claude-cli",
          },
        ],
        routeVariants: [],
        authoritative: true,
      },
    });

    await expect(state.resolveThinkingCatalog()).resolves.toEqual([
      expect.objectContaining({
        provider: "anthropic",
        id: "claude-mythos-5",
        thinkingPolicyProvider: "claude-cli",
      }),
    ]);
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
    expect(catalogRuntimeMocks.loadModelCatalogSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    { hasModelDirective: false, capturedPolicy: true, expected: "ultra" },
    { hasModelDirective: true, capturedPolicy: true, expected: "ultra" },
    { hasModelDirective: false, capturedPolicy: false, expected: "medium" },
    { hasModelDirective: true, capturedPolicy: false, expected: "medium" },
    { hasModelDirective: false, capturedPolicy: true, expected: "ultra", unrestricted: true },
    { hasModelDirective: false, capturedPolicy: false, expected: "medium", unrestricted: true },
  ])(
    "keeps prepared thinking ownership through reply selection (directive=$hasModelDirective policy=$capturedPolicy unrestricted=$unrestricted)",
    async ({ hasModelDirective, capturedPolicy, expected, unrestricted }) => {
      const provider = "fixture-provider";
      const model = "fixture-model";
      const cfg: OpenClawConfig = {
        agents: unrestricted
          ? undefined
          : { defaults: { models: { [`${provider}/${model}`]: { alias: "Fixture" } } } },
        models: {
          providers: {
            [provider]: {
              baseUrl: "https://fixture.invalid/v1",
              models: [makeConfiguredModel({ id: model })],
            },
          },
        },
      };
      const preparedModelCatalog: ModelCatalogSnapshot = {
        entries: [{ provider, id: model, name: "Fixture", reasoning: true }],
        routeVariants: [],
      };
      prepareModelCatalogThinkingPolicies({
        catalog: preparedModelCatalog,
        metadataSnapshot: createPluginMetadataSnapshotFixture(),
        providers: [
          {
            provider: {
              id: provider,
              ...(capturedPolicy
                ? {
                    resolveThinkingProfile: () => ({
                      levels: [{ id: "off" }, { id: "max" }, { id: "ultra" }],
                      defaultLevel: "ultra",
                    }),
                  }
                : {}),
            },
          },
        ],
      });
      const ambient = vi
        .spyOn(activeThinkingPolicy, "resolveActiveProviderThinkingProfile")
        .mockReturnValue({ levels: [{ id: "off" }], defaultLevel: "off" });
      try {
        const state = await createInitialState(cfg, provider, model, {
          hasModelDirective,
          preparedModelCatalog,
        });
        await expect(
          state.resolveDefaultThinkingLevel({ provider, model, agentRuntime: "codex" }),
        ).resolves.toBe(expected);
        expect(ambient).not.toHaveBeenCalled();
      } finally {
        ambient.mockRestore();
      }
    },
  );

  it("uses published metadata without a second manifest inventory", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadManifestModelCatalog).mockClear();
    vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValueOnce([
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5", reasoning: true },
    ]);
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {},
          },
        },
      },
    } as OpenClawConfig;

    const state = await createInitialState(cfg, "openai", "gpt-5.5");

    await expect(state.resolveThinkingCatalog()).resolves.toEqual([
      expect.objectContaining({ provider: "openai", id: "gpt-5.5", reasoning: true }),
    ]);
    expect(loadManifestModelCatalog).not.toHaveBeenCalled();
    expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledOnce();
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
  });

  it("keeps configured compat in published thinking metadata", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadManifestModelCatalog).mockReturnValueOnce([
      { provider: "vllm", id: "Qwen/Qwen3-8B", name: "Qwen3", reasoning: true },
    ]);
    const cfg = {
      agents: {
        defaults: {
          models: {
            "vllm/Qwen/Qwen3-8B": {},
          },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "http://localhost:9000/v1",
            models: [
              makeConfiguredModel({
                id: "Qwen/Qwen3-8B",
                name: "Qwen3",
                compat: { thinkingFormat: "qwen-chat-template" },
              }),
            ],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createInitialState(cfg, "vllm", "Qwen/Qwen3-8B");

    await expect(state.resolveThinkingCatalog()).resolves.toEqual([
      expect.objectContaining({
        provider: "vllm",
        id: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      }),
    ]);
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
  });

  it("uses only configured compat for a custom route when the catalog is loaded", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([
      {
        provider: "vllm",
        id: "Qwen/Qwen3-8B",
        name: "Qwen3",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["xhigh"] },
      },
    ]);
    const cfg = {
      agents: {
        defaults: {
          models: {
            "vllm/Qwen/Qwen3-8B": {},
          },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "http://localhost:9000/v1",
            models: [
              makeConfiguredModel({
                id: "Qwen/Qwen3-8B",
                name: "Qwen3",
                compat: { thinkingFormat: "qwen-chat-template" },
              }),
            ],
          },
        },
      },
    } as OpenClawConfig;

    const state = await createInitialState(cfg, "vllm", "Qwen/Qwen3-8B", {
      hasModelDirective: true,
    });

    await expect(state.resolveThinkingCatalog()).resolves.toEqual([
      expect.objectContaining({
        provider: "vllm",
        id: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      }),
    ]);
    expect(loadModelCatalogLocal).toHaveBeenCalledOnce();
  });

  it("prefers per-agent thinkingDefault over model and global defaults", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    const cfg = {
      agents: {
        defaults: {
          thinkingDefault: "low",
          models: {
            "openai/gpt-5.4": {
              params: { thinking: "high" },
            },
          },
        },
        list: [
          {
            id: "alpha",
            thinkingDefault: "minimal",
          },
        ],
      },
    } as OpenClawConfig;

    const state = await createInitialState(cfg, "openai", "gpt-5.4", {
      agentId: "alpha",
    });

    await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("minimal");
  });

  it("reads published catalog for explicit model directives", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4o": {},
          },
        },
      },
    } as OpenClawConfig;

    const state = await createInitialState(cfg, "openai", "gpt-4o", {
      hasModelDirective: true,
    });

    expect(loadModelCatalogLocal).toHaveBeenCalledOnce();
    expect(vi.mocked(loadModelCatalogLocal).mock.calls[0]?.[0]).toHaveProperty("readOnly", true);
    expect(state.allowedModelCatalog).toContainEqual(
      expect.objectContaining({ provider: "openai", id: "gpt-4o" }),
    );
  });

  it("carries catalog context limits into cold model selection", async () => {
    vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        contextWindow: 1_000_000,
        contextTokens: 272_000,
      },
    ]);

    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: {},
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      hasModelDirective: true,
    });

    expect(
      resolveContextTokens({
        cfg: {} as OpenClawConfig,
        provider: state.provider,
        model: state.model,
        modelContextWindow: state.modelContextWindow,
        modelContextTokens: state.modelContextTokens,
      }),
    ).toBe(272_000);
  });

  it.each([
    ["anthropic", "claude-opus-4-5", "openai/*", "anthropic", "claude-opus-4-5", 1, false],
    ["openai/team", "claude-opus-4-5", "openai/*", "openai", "team/claude-opus-4-5", 1, true],
    ["openai", "openai/team/Reader", "openai/team/*", "openai", "team/Reader", 1, true],
    ["openai", "team/Reader", "openai/team/*", "openai", "team/Reader", 0, true],
  ] as const)(
    "initializes configured %s/%s without substituting a browse match for wildcard %s",
    async (
      defaultProvider,
      defaultModel,
      allow,
      selectedProvider,
      selectedModel,
      catalogLoads,
      manualAllowed,
    ) => {
      vi.mocked(loadModelCatalogLocal).mockClear();
      if (catalogLoads) {
        vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([
          { provider: defaultProvider, id: defaultModel, name: "Configured primary" },
          { provider: "openai", id: "team/browse-match", name: "Allowed model" },
          { provider: "vllm", id: "qwen3-local", name: "Qwen3 Local" },
        ]);
      }
      const cfg = {
        agents: {
          defaults: {
            model: { primary: `${defaultProvider}/${defaultModel}` },
            models: { [allow]: {}, "vllm/*": {} },
          },
        },
      } as OpenClawConfig;

      const state = await createInitialState(cfg, defaultProvider, defaultModel);

      expect(state.provider).toBe(selectedProvider);
      expect(state.model).toBe(selectedModel);
      expect(state.modelPolicy.allows({ provider: state.provider, model: state.model })).toBe(
        manualAllowed,
      );
      expect(loadModelCatalogLocal).toHaveBeenCalledTimes(catalogLoads);
    },
  );

  it("does not reject wildcard-only policy before an explicit model directive is resolved", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([]);
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {
            "vllm/*": {},
          },
        },
      },
    } as OpenClawConfig;

    const state = await createInitialState(cfg, "anthropic", "claude-opus-4-5", {
      hasModelDirective: true,
    });

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-5");
    expect(state.allowedModelKeys.has("vllm/*")).toBe(true);
    expect(loadModelCatalogLocal).toHaveBeenCalledOnce();
  });

  it("keeps a stored dynamic provider wildcard model when the catalog has no rows yet", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([]);
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {
            "vllm/*": {},
          },
        },
      },
    } as OpenClawConfig;
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      executionSelection: {
        state: "accepted",
        selection: {
          model: { provider: "vllm", id: "new-local-model" },
          executor: { kind: "harness", id: "openclaw" },
        },
        fallbackPermission: "explicit",
      },
    };
    const sessionStore = { main: sessionEntry };

    const state = await createInitialState(cfg, "anthropic", "claude-opus-4-5", {
      sessionEntry,
      sessionStore,
      sessionKey: "main",
    });

    expect(state.provider).toBe("vllm");
    expect(state.model).toBe("new-local-model");
    expect(state.requestedRouteResolution).toBe("resolved");
    expect(sessionStore.main.executionSelection).toMatchObject({
      state: "accepted",
      selection: { model: { provider: "vllm", id: "new-local-model" } },
    });
    expect(loadModelCatalogLocal).toHaveBeenCalledOnce();
  });

  it("preserves OpenAI API-key session auth when model policy explicitly pins OpenClaw", async () => {
    authProfileStoreMock.store = {
      version: 1,
      profiles: {
        "openai:work": { type: "api_key", provider: "openai", key: "sk-test" },
      },
    };
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: 1,
      authProfileOverride: "openai:work",
    };
    const sessionStore = { main: sessionEntry };

    await createModelSelectionState({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "openclaw" },
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      agentCfg: undefined,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      hasModelDirective: false,
      sessionEntry,
      sessionStore,
      sessionKey: "main",
    });

    expect(sessionEntry.authProfileOverride).toBe("openai:work");
    expect(sessionStore.main.authProfileOverride).toBe("openai:work");
  });
});

describe("resolveContextTokens", () => {
  it("prefers provider-qualified cache keys over bare model ids", () => {
    getContextWindowCaches().discoveredTokenCache.set("gemini-3.1-pro-preview", 200_000);
    getContextWindowCaches().discoveredTokenCache.set(
      providerContextTokenCacheKey("google-gemini-cli", "gemini-3.1-pro-preview"),
      1_000_000,
    );

    const result = resolveContextTokens({
      cfg: {} as OpenClawConfig,
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
    });

    expect(result).toBe(1_000_000);
  });
});

function acceptedEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "selection-session",
    lifecycleRevision: "selection-generation",
    updatedAt: 1,
    executionSelection: {
      state: "accepted",
      selection: {
        model: { provider: "fixture", id: "selected" },
        executor: { kind: "harness", id: "openclaw" },
      },
      fallbackPermission: "explicit",
    },
    ...overrides,
  };
}

function prepareAcceptedState(
  entry: SessionEntry,
  overrides: Partial<Parameters<typeof createModelSelectionState>[0]> = {},
) {
  const cfg: OpenClawConfig = { agents: { defaults: { model: "fixture/default" } } };
  return createModelSelectionState({
    cfg,
    agentCfg: cfg.agents?.defaults,
    sessionEntry: entry,
    sessionStore: { "agent:main:selection": entry },
    sessionKey: "agent:main:selection",
    defaultProvider: "fixture",
    defaultModel: "default",
    provider: "fixture",
    model: "default",
    hasModelDirective: false,
    ...overrides,
  });
}

describe("createModelSelectionState accepted selection", () => {
  it("uses the accepted pair instead of observed output or a changed configured default", async () => {
    const entry = acceptedEntry({
      modelProvider: "observation",
      model: "fallback",
      agentHarnessId: "previous-app",
    });
    const before = structuredClone(entry);
    const state = await prepareAcceptedState(entry);
    expect(state).toMatchObject({
      provider: "fixture",
      model: "selected",
      executionSelection: {
        model: { provider: "fixture", id: "selected" },
        executor: { kind: "harness", id: "openclaw" },
      },
    });
    expect(entry).toEqual(before);
    expect(cliBackendsMocks.resolveCliRuntimeCanonicalProvider).not.toHaveBeenCalled();
  });

  it("initializes one configured pair without pinning later configured changes", async () => {
    const entry: SessionEntry = { sessionId: "new-selection", updatedAt: 1 };
    const first = await prepareAcceptedState(entry);
    expect(first).toMatchObject({ provider: "fixture", model: "default" });
    expect(entry.executionSelection).toMatchObject({
      state: "accepted",
      selection: { model: { provider: "fixture", id: "default" }, executor: { id: "openclaw" } },
      fallbackPermission: "configured",
    });
    const before = structuredClone(entry);
    const cfg: OpenClawConfig = { agents: { defaults: { model: "fixture/later-default" } } };
    const later = await prepareAcceptedState(entry, {
      cfg,
      agentCfg: cfg.agents?.defaults,
      defaultModel: "later-default",
      model: "later-default",
    });
    expect(later.model).toBe("default");
    expect(entry).toEqual(before);
  });

  it("retains a locked accepted pair outside the manual picker policy", async () => {
    const entry = acceptedEntry({ modelSelectionLocked: true });
    const before = structuredClone(entry);
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { model: "fixture/default", modelPolicy: { allow: ["fixture/default"] } },
      },
    };
    const state = await prepareAcceptedState(entry, { cfg, agentCfg: cfg.agents?.defaults });
    expect(state.modelPolicy.allows({ provider: "fixture", model: "selected" })).toBe(false);
    expect(state.executionSelection).toEqual(
      before.executionSelection?.state === "accepted"
        ? before.executionSelection.selection
        : undefined,
    );
    expect(entry).toEqual(before);
  });

  it("retains a locked CLI selection, its binding and its compatible account", async () => {
    authProfileStoreMock.store = {
      version: 1,
      profiles: { "anthropic:cli": { type: "api_key", provider: "anthropic", key: "synthetic" } },
    };
    const entry = acceptedEntry({
      executionSelection: {
        state: "accepted",
        selection: {
          model: { provider: "anthropic", id: "selected" },
          executor: { kind: "cli", id: "claude-cli" },
        },
        fallbackPermission: "explicit",
      },
      modelSelectionLocked: true,
      pluginOwnerId: "anthropic",
      cliSessionBindings: {
        "claude-cli": { sessionId: "native-session", forceReuse: true, forkNextResume: true },
      },
      authProfileOverride: "anthropic:cli",
      authProfileOverrideSource: "user",
    });
    const before = structuredClone(entry);
    const state = await prepareAcceptedState(entry);
    expect(state).toMatchObject({
      provider: "anthropic",
      model: "selected",
      executionSelection: { executor: { kind: "cli", id: "claude-cli" } },
    });
    expect(entry).toEqual(before);
    expect(cliBackendsMocks.resolveCliRuntimeCanonicalProvider).not.toHaveBeenCalled();
    expect(authProfileStoreMock.ensureAuthProfileStore).not.toHaveBeenCalled();
  });

  it("keeps canonical nested model identity ahead of a colliding alias", async () => {
    const entry = acceptedEntry({
      executionSelection: {
        state: "accepted",
        selection: {
          model: { provider: "fixture", id: "namespace/selected" },
          executor: { kind: "harness", id: "openclaw" },
        },
        fallbackPermission: "explicit",
      },
    });
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "fixture/default",
          models: { "other/alternative": { alias: "namespace/selected" } },
        },
      },
    };
    const state = await prepareAcceptedState(entry, { cfg, agentCfg: cfg.agents?.defaults });
    expect(state).toMatchObject({
      provider: "fixture",
      model: "namespace/selected",
      requestedRouteResolution: "resolved",
    });
    expect(entry.executionSelection).toMatchObject({
      selection: { model: { provider: "fixture", id: "namespace/selected" } },
    });
  });

  it.each(["heartbeat", "recovery", "one-turn"] as const)(
    "keeps the human pair and account unchanged for a %s choice",
    async (kind) => {
      const entry = acceptedEntry({
        authProfileOverride: "fixture:account",
        authProfileOverrideSource: "user",
      });
      const before = structuredClone(entry);
      const state = await prepareAcceptedState(entry, {
        model: "temporary",
        ...(kind === "heartbeat"
          ? { isHeartbeat: true, hasResolvedHeartbeatModelOverride: true }
          : kind === "recovery"
            ? { skipStoredModelOverride: true }
            : { hasOneTurnModelOverride: true }),
      });
      expect(state).toMatchObject({
        provider: "fixture",
        model: "temporary",
        executionSelection: {
          model: { provider: "fixture", id: "temporary" },
          executor: { kind: "harness", id: "openclaw" },
        },
      });
      expect(entry).toEqual(before);
    },
  );

  it.each(["user", "user-link", undefined] as const)(
    "retains a missing explicit account (%s) on an accepted pair",
    async (source) => {
      const entry = acceptedEntry({
        authProfileOverride: "fixture:missing",
        authProfileOverrideSource: source,
      });
      const before = structuredClone(entry);
      await prepareAcceptedState(entry);
      expect(entry).toEqual(before);
      expect(authProfileStoreMock.ensureAuthProfileStore).not.toHaveBeenCalled();
    },
  );

  it.each(["unknown", "unavailable", "forbidden"] as const)(
    "refuses %s evaluation without silently replacing accepted intent",
    async (kind) => {
      const entry = acceptedEntry();
      const before = structuredClone(entry);
      vi.mocked(evaluatePublishedModelRuntimeChoice).mockResolvedValueOnce({
        kind,
        message: "Selection is not available.",
      });
      await expect(prepareAcceptedState(entry)).rejects.toThrow();
      expect(entry).toEqual(before);
      expect(sessionPersistenceMocks.persistReplySessionEntry).not.toHaveBeenCalled();
    },
  );

  it("does not clear a pair merely because the catalog is degraded", async () => {
    const entry = acceptedEntry({ modelSelectionLocked: true });
    const before = structuredClone(entry);
    const state = await prepareAcceptedState(entry, {
      preparedModelCatalog: { entries: [], routeVariants: [], authoritative: false },
    });
    expect(state.model).toBe("selected");
    expect(entry).toEqual(before);
  });

  it("preserves the session when its generation changes during initial persistence", async () => {
    const entry: SessionEntry = {
      sessionId: "initial-session",
      lifecycleRevision: "initial-generation",
      updatedAt: 1,
    };
    const before = structuredClone(entry);
    sessionPersistenceMocks.persistReplySessionEntry.mockResolvedValueOnce({
      status: "lifecycle-invalidated",
      error: "Session changed while starting work. Retry.",
      entry: { ...entry, sessionId: "replacement-session" },
    });
    await expect(
      prepareAcceptedState(entry, { storePath: "/synthetic/selection-store" }),
    ).rejects.toThrow(/changed while starting work/i);
    expect(sessionPersistenceMocks.persistReplySessionEntry).toHaveBeenCalledOnce();
    const request = sessionPersistenceMocks.persistReplySessionEntry.mock.calls[0]?.[0];
    expect(request?.initialEntry).toEqual(before);
    expect(request?.entry.executionSelection).toMatchObject({
      state: "accepted",
      selection: { model: { provider: "fixture", id: "default" } },
    });
    expect(entry).toEqual(before);
  });

  it("passes the published generation validator into the session transaction", async () => {
    const entry: SessionEntry = { sessionId: "pending-session", updatedAt: 1 };
    const before = structuredClone(entry);
    sessionPersistenceMocks.persistReplySessionEntry.mockImplementationOnce(
      async ({ validateCommit }) => {
        runtimeChoiceFixture.generation++;
        const error = validateCommit?.();
        expect(error).toBe("The model catalog changed. Try again.");
        if (!error) throw new Error("Expected the published generation to reject commit");
        return { status: "commit-rejected", error, entry: before };
      },
    );
    await expect(
      prepareAcceptedState(entry, { storePath: "/synthetic/selection-store" }),
    ).rejects.toThrow("The model catalog changed. Try again.");
    expect(entry).toEqual(before);
  });
});

describe("createModelSelectionState resolveDefaultReasoningLevel", () => {
  it("uses published reasoning without a second manifest inventory", async () => {
    vi.mocked(loadModelCatalogLocal).mockClear();
    vi.mocked(loadManifestModelCatalog).mockClear();
    vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValueOnce([
      { provider: "local", id: "fast-reasoner", name: "Fast Reasoner", reasoning: true },
    ]);
    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      defaultProvider: "local",
      defaultModel: "fast-reasoner",
      provider: "local",
      model: "fast-reasoner",
      hasModelDirective: false,
    });

    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
    expect(loadManifestModelCatalog).not.toHaveBeenCalled();
    expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledOnce();
    expect(loadModelCatalogLocal).not.toHaveBeenCalled();
  });

  it("returns on when catalog model has reasoning true", async () => {
    vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValueOnce([
      { provider: "openrouter", id: "x-ai/grok-4.1-fast", name: "Grok", reasoning: true },
    ]);
    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      defaultProvider: "openrouter",
      defaultModel: "x-ai/grok-4.1-fast",
      provider: "openrouter",
      model: "x-ai/grok-4.1-fast",
      hasModelDirective: false,
    });
    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
  });

  it("returns off when catalog model has no reasoning", async () => {
    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      provider: "openai",
      model: "gpt-4o-mini",
      hasModelDirective: false,
    });
    await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("off");
  });
});
