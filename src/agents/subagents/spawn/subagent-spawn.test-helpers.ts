// Subagent spawn test helpers install mocked runtime seams so sessions_spawn
// tests can exercise orchestration without real gateway/session-store effects.
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { expect, vi } from "vitest";
import type { ModelProviderConfig } from "../../../config/types.models.js";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "../../../gateway/method-scopes.js";
import type { SubagentLifecycleHookRunner } from "../../../plugins/hooks.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.types.js";

type MockFn = (...args: unknown[]) => unknown;
type MockImplementationTarget = {
  mockImplementation: (implementation: (opts: { method?: string }) => Promise<unknown>) => unknown;
};
type SessionStore = Record<string, Record<string, unknown>>;
type SessionStoreMutator = (store: SessionStore) => unknown;
type HookRunner = Pick<SubagentLifecycleHookRunner, "hasHooks"> &
  Partial<
    Pick<
      SubagentLifecycleHookRunner,
      "runSubagentSpawned" | "runSubagentProgress" | "runSubagentEnded"
    >
  >;
type SubagentSpawnModuleForTest = Awaited<typeof import("./subagent-spawn.js")> & {
  resetSubagentRegistryForTests: MockFn;
};

/** Shared published facts for orchestration mocks; generation replacement invalidates prepared commits. */
export async function installSpawnModelCatalogFixture(defaultWorkspaceDir?: string) {
  let generation = 0;
  const resetSubagentRegistryForTests = vi.fn(() => {
    generation += 1;
  });
  const { setPreparedModelRuntimeAuthStore } = await import("../../prepared-model-runtime-auth.js");
  const { AuthStorage, ModelRegistry } = await import("../../sessions/index.js");
  const { getActivePluginRegistry, getActivePluginRegistryVersion } =
    await import("../../../plugins/runtime.js");
  const { getRuntimeAuthProfileStoreCredentialsRevision } =
    await import("../../auth-profiles/runtime-snapshots.js");
  const { capturePluginRegistryLifecycleEpoch, capturePluginRegistryLifecycleSignal } =
    await import("../../../plugins/registry-lifecycle.js");
  const registry = createEmptyPluginRegistry();
  const publishedModels = {
    openai: ["gpt-4", "gpt-5.4", "gpt-5.5", "gpt-5.6-luna"],
    anthropic: ["claude-opus-4-7", "claude-sonnet-4-6"],
    custom: ["custom/model", "middle", "final"],
    "plugin-provider": ["new-model"],
  };
  const entries = Object.entries(publishedModels).flatMap(([provider, models]) =>
    models.map((id) => ({
      provider,
      id,
      name: id,
      api: "openai-completions" as const,
      baseUrl: "https://models.example.invalid/v1",
    })),
  );
  const catalogRuntime = await import("../../prepared-model-catalog.js");
  vi.spyOn(catalogRuntime, "getPublishedPreparedModelCatalogOwnerSnapshot").mockImplementation(
    ({ config, agentId = "main", workspaceDir } = {}) => {
      if (!config) {
        return undefined;
      }
      const capturedGeneration = generation;
      const capturedRegistry = getActivePluginRegistry();
      const registryVersion = getActivePluginRegistryVersion();
      const registrySignal = capturedRegistry
        ? capturePluginRegistryLifecycleSignal(
            capturedRegistry,
            capturePluginRegistryLifecycleEpoch(capturedRegistry),
            { scopedRuntime: true },
          )
        : undefined;
      const authRevision = getRuntimeAuthProfileStoreCredentialsRevision();
      const workspace = workspaceDir ?? defaultWorkspaceDir ?? os.tmpdir();
      const owner: PreparedModelRuntimeSnapshot = {
        config,
        observationConfig: config,
        catalogOwner: { agentId, workspaceDir: workspace },
        agentId,
        agentDir: path.join(workspace, "agent"),
        workspaceDir: workspace,
        activeProjectKeys: [],
        authModes: {},
        metadataSnapshot: createPluginMetadataSnapshotFixture(),
        pluginRegistry: capturedRegistry ?? registry,
        isCurrent: () =>
          generation === capturedGeneration &&
          capturedRegistry === getActivePluginRegistry() &&
          (!capturedRegistry || (registrySignal !== undefined && !registrySignal.aborted)) &&
          registryVersion === getActivePluginRegistryVersion() &&
          authRevision === getRuntimeAuthProfileStoreCredentialsRevision(),
        allowGatewaySubagentBinding: false,
        modelCatalog: { entries, routeVariants: entries },
        configuredRuntimeModels: [],
        inlineProviderModels: [],
        createStores() {
          const authStorage = AuthStorage.inMemory({});
          return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
        },
      };
      setPreparedModelRuntimeAuthStore(owner, {
        version: 1,
        profiles: Object.fromEntries(
          [
            ...new Set([
              ...Object.keys(publishedModels),
              ...Object.keys(config.models?.providers ?? {}),
            ]),
          ].map(
            (provider) =>
              [
                `${provider}:test-profile`,
                {
                  type: "api_key" as const,
                  provider,
                  key: "synthetic-spawn-credential",
                },
              ] as const,
          ),
        ),
      });
      return owner;
    },
  );
  vi.spyOn(catalogRuntime, "materializePreparedModelCatalogOwner").mockImplementation(
    (owner) => owner,
  );

  return resetSubagentRegistryForTests;
}

/** Orchestration fixtures provide the complete prepared boundary; support policy uses real owner tests. */
export async function supportedSpawnExecutionSelection(
  params: Parameters<
    typeof import("../../../model-picker/apply-session-model-selection.js").prepareSessionExecutionSelection
  >[0],
): ReturnType<
  typeof import("../../../model-picker/apply-session-model-selection.js").prepareSessionExecutionSelection
> {
  const { resolveModelRefFromString, buildModelAliasIndex, resolveDefaultModelForAgent } =
    await import("../../model-selection.js");
  const { resolveEffectiveAgentRuntimeCore } = await import("../../thinking-runtime.js");
  const { resolveExecutionSelectionExecutorKind } =
    await import("../../../model-picker/apply-session-model-selection.js");
  const { getPublishedPreparedModelCatalogOwnerSnapshot } =
    await import("../../prepared-model-catalog.js");
  const input = params.modelInput;
  if (!input) {
    throw new Error("Expected the creation model input.");
  }
  const defaults = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  const options = { cfg: params.cfg, agentId: params.agentId, defaultProvider: defaults.provider };
  const selected = input.resolvedRef
    ? { ref: input.resolvedRef }
    : resolveModelRefFromString({
        ...options,
        raw: input.raw,
        aliasIndex: buildModelAliasIndex(options),
      });
  if (!selected) {
    throw new Error("Invalid test model " + input.raw);
  }
  const ref = selected.ref;
  const id = resolveEffectiveAgentRuntimeCore({
    cfg: params.cfg,
    agentScope: { kind: "prepared", agentId: params.agentId },
    provider: ref.provider,
    modelId: ref.model,
  });
  const kind = resolveExecutionSelectionExecutorKind(params.cfg, id);
  if (!kind) {
    throw new Error("The fixture runtime is not registered: " + id);
  }
  const owner = getPublishedPreparedModelCatalogOwnerSnapshot({
    config: params.cfg,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
  });
  if (!owner) {
    throw new Error("The fixture model owner is not published.");
  }
  return {
    status: "ready",
    selection: { model: { provider: ref.provider, id: ref.model }, executor: { kind, id } },
    reason: params.request.kind === "initialize" ? "initialized" : "model",
    message: "Prepared fixture selection.",
    catalogEntry: { provider: ref.provider, id: ref.model, name: ref.model },
    validateCommit: () =>
      owner.isCurrent() ? undefined : "Fixture model configuration changed during preparation.",
  };
}

/** Build a minimal runtime config for sessions_spawn tests. */
export function createSubagentSpawnTestConfig(
  workspaceDir = os.tmpdir(),
  overrides?: Record<string, unknown>,
) {
  return {
    models: {
      providers: Object.fromEntries(
        ["openai", "anthropic", "custom"].map(
          (provider) =>
            [
              provider,
              {
                api: "openai-completions",
                baseUrl: "https://models.example.invalid/v1",
                agentRuntime: { id: "openclaw" },
                models: [],
              },
            ] satisfies [string, ModelProviderConfig],
        ),
      ),
    },
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
    tools: {
      sessions_spawn: {
        attachments: {
          enabled: true,
          maxFiles: 50,
          maxFileBytes: 1 * 1024 * 1024,
          maxTotalBytes: 5 * 1024 * 1024,
        },
      },
    },
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
    },
    ...overrides,
  };
}

/** Mock gateway calls for the common accepted-spawn flow. */
export function setupAcceptedSubagentGatewayMock(callGatewayMock: MockImplementationTarget) {
  callGatewayMock.mockImplementation(async (opts: { method?: string }) => {
    if (opts.method === "sessions.patch") {
      return { ok: true };
    }
    if (opts.method === "sessions.delete") {
      return { ok: true };
    }
    if (opts.method === "agent") {
      return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
    }
    return {};
  });
}

function identityDeliveryContext(value: unknown) {
  return value;
}

function createDefaultSessionHelperMocks() {
  return {
    resolveMainSessionAlias: () => ({ mainKey: "main", alias: "main" }),
    resolveInternalSessionKey: ({ key }: { key?: string }) => key ?? "agent:main:main",
    resolveDisplaySessionKey: ({ key }: { key?: string }) => key ?? "agent:main:main",
  };
}

/** Install an updateSessionStore mock that captures mutations in memory. */
export function installSessionStoreCaptureMock(
  updateSessionStoreMock: {
    mockImplementation: (
      implementation: (storePath: string, mutator: SessionStoreMutator) => Promise<SessionStore>,
    ) => unknown;
  },
  params?: {
    operations?: string[];
    onStore?: (store: SessionStore) => void;
  },
) {
  const store: SessionStore = {};
  updateSessionStoreMock.mockImplementation(
    async (_storePath: string, mutator: SessionStoreMutator) => {
      params?.operations?.push("store:update");
      await mutator(store);
      params?.onStore?.(store);
      return store;
    },
  );
}

/** Assert the persisted session entry captured the expected runtime model. */
export function expectPersistedRuntimeModel(params: {
  persistedStore: SessionStore | undefined;
  sessionKey: string | RegExp;
  provider: string;
  model: string;
  overrideSource?: "auto" | "user";
}) {
  const [persistedKey, persistedEntry] = Object.entries(params.persistedStore ?? {})[0] ?? [];
  if (typeof params.sessionKey === "string") {
    expect(persistedKey).toBe(params.sessionKey);
  } else {
    expect(persistedKey).toMatch(params.sessionKey);
  }
  expect(persistedEntry?.executionSelection).toMatchObject({
    state: "accepted",
    selection: { model: { provider: params.provider, id: params.model } },
    ...(params.overrideSource
      ? { fallbackPermission: params.overrideSource === "auto" ? "configured" : "explicit" }
      : {}),
  });
}

/** Load subagent-spawn with runtime dependencies replaced by test doubles. */
export async function loadSubagentSpawnModuleForTest(params: {
  callGatewayMock: MockFn;
  dispatchGatewayMethodInProcessMock?: MockFn;
  hasInProcessGatewayContextMock?: MockFn;
  getRuntimeConfig?: () => Record<string, unknown>;
  loadSessionStoreMock?: MockFn;
  prepareExecutionSelectionMock?: typeof supportedSpawnExecutionSelection;
  ensureContextEnginesInitializedMock?: MockFn;
  updateSessionStoreMock?: MockFn;
  forkSessionEntryFromParentMock?: MockFn;
  forkSessionFromParentMock?: MockFn;
  resolveContextEngineMock?: MockFn;
  resolveParentForkDecisionMock?: MockFn;
  registerSubagentRunMock?: MockFn;
  startQueuedSubagentRunMock?: MockFn;
  settleFailedQueuedSubagentLaunchMock?: MockFn;
  completeCollectorLaunchCleanupMock?: MockFn;
  emitSessionLifecycleEventMock?: MockFn;
  hookRunner?: HookRunner;
  resolveAgentConfig?: (cfg: Record<string, unknown>, agentId: string) => unknown;
  resolveAgentWorkspaceDir?: (cfg: Record<string, unknown>, agentId: string) => string;
  getSubagentDepthFromSessionStore?: (sessionKey: string, opts?: unknown) => number;
  countActiveRunsForSession?: (sessionKey: string) => number;
  listSwarmRunsForGroup?: (groupId: string) => unknown[];
  resolveSandboxRuntimeStatus?: (params: {
    cfg?: Record<string, unknown>;
    sessionKey?: string;
  }) => { sandboxed: boolean };
  getSessionBindingService?: () => {
    getCapabilities?: (params: { channel?: string; accountId?: string }) => {
      adapterAvailable: boolean;
      bindSupported: boolean;
      placements: Array<"current" | "child">;
    };
    bind?: (params: {
      targetSessionKey: string;
      targetKind?: string;
      conversation: {
        channel: string;
        accountId?: string;
        conversationId: string;
        parentConversationId?: string;
      };
      placement: "current" | "child";
      metadata?: Record<string, unknown>;
    }) => Promise<{
      targetSessionKey: string;
      targetKind?: string;
      status?: string;
      conversation: {
        channel: string;
        accountId?: string;
        conversationId: string;
        parentConversationId?: string;
      };
    }>;
    listBySession: (targetSessionKey: string) => Array<{
      status?: string;
      conversation: {
        channel: string;
        accountId?: string;
        conversationId: string;
        parentConversationId?: string;
      };
    }>;
  };
  resolveConversationDeliveryTarget?: (params: {
    channel?: string;
    conversationId?: string | number;
    parentConversationId?: string | number;
  }) => { to?: string; threadId?: string };
  workspaceDir?: string;
  sessionStorePath?: string;
  resetModules?: boolean;
}): Promise<SubagentSpawnModuleForTest> {
  if (params.resetModules ?? true) {
    // The helper rewires imports with vi.doMock, so each test starts from a
    // fresh module graph unless explicitly sharing mocks.
    vi.resetModules();
  }

  const resetSubagentRegistryForTests = await installSpawnModelCatalogFixture(params.workspaceDir);

  vi.doMock("../../provider-model-normalization.runtime.js", () => ({
    normalizeProviderModelIdWithRuntime: () => undefined,
  }));

  vi.doMock("./subagent-spawn.runtime.js", () => ({
    callGateway: (opts: unknown) => params.callGatewayMock(opts),
    dispatchGatewayMethodInProcess: (...args: unknown[]) =>
      params.dispatchGatewayMethodInProcessMock?.(...args),
    hasInProcessGatewayContext: () => Boolean(params.hasInProcessGatewayContextMock?.()),
    forkSessionEntryFromParent:
      params.forkSessionEntryFromParentMock ??
      (async () => {
        const fork = (
          params.forkSessionFromParentMock
            ? await params.forkSessionFromParentMock()
            : { sessionId: "forked-session-id", sessionFile: "/tmp/forked-session.jsonl" }
        ) as { sessionId: string; sessionFile: string } | null;
        if (!fork) {
          return { status: "failed" };
        }
        return {
          status: "forked",
          fork,
          parentEntry: {
            sessionId: "parent-session-id",
            sessionFile: "/tmp/parent-session.jsonl",
            updatedAt: Date.now(),
          },
          sessionEntry: {
            sessionId: fork.sessionId,
            sessionFile: fork.sessionFile,
            forkedFromParent: true,
          },
          decision: {
            status: "fork",
            maxTokens: 100_000,
          },
        };
      }),
    forkSessionFromParent:
      params.forkSessionFromParentMock ??
      (async () => ({ sessionId: "forked-session-id", sessionFile: "/tmp/forked-session.jsonl" })),
    getGlobalHookRunner: () => params.hookRunner ?? { hasHooks: () => false },
    emitSessionLifecycleEvent: (...args: unknown[]) =>
      params.emitSessionLifecycleEventMock?.(...args),
    formatThinkingLevels: (levels: string[]) => levels.join(", "),
    normalizeThinkLevel: (level: unknown) => normalizeOptionalString(level),
    DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT: 5,
    ADMIN_SCOPE: "operator.admin",
    AGENT_LANE_SUBAGENT: "subagent",
    getRuntimeConfig: () =>
      params.getRuntimeConfig?.() ??
      createSubagentSpawnTestConfig(params.workspaceDir ?? os.tmpdir()),
    prepareSessionExecutionSelection:
      params.prepareExecutionSelectionMock ?? supportedSpawnExecutionSelection,
    loadSessionEntry: (scope: { storePath?: string; sessionKey: string }) =>
      ((params.loadSessionStoreMock?.(scope.storePath) ?? {}) as SessionStore)[scope.sessionKey],
    loadSessionStore: params.loadSessionStoreMock ?? (() => ({})),
    ensureContextEnginesInitialized:
      params.ensureContextEnginesInitializedMock ?? (() => undefined),
    resolveContextEngine: params.resolveContextEngineMock ?? (async () => ({})),
    resolveParentForkDecision:
      params.resolveParentForkDecisionMock ??
      (async (forkParams: { parentEntry?: { totalTokens?: unknown } }) => {
        const maxTokens = 100_000;
        const parentTokens =
          typeof forkParams.parentEntry?.totalTokens === "number" &&
          Number.isFinite(forkParams.parentEntry.totalTokens)
            ? Math.floor(forkParams.parentEntry.totalTokens)
            : undefined;
        if (maxTokens > 0 && typeof parentTokens === "number" && parentTokens > maxTokens) {
          return {
            status: "skip",
            reason: "parent-too-large",
            maxTokens,
            parentTokens,
            message: `Parent context is too large to fork (${parentTokens}/${maxTokens} tokens); starting with isolated context instead.`,
          };
        }
        return {
          status: "fork",
          maxTokens,
          ...(typeof parentTokens === "number" ? { parentTokens } : {}),
        };
      }),
    mergeSessionEntry: (
      current: Record<string, unknown> | undefined,
      next: Record<string, unknown>,
    ) => ({
      ...current,
      ...next,
    }),
    updateSessionStore:
      params.updateSessionStoreMock ??
      (async (_storePath: string, mutator: SessionStoreMutator) => {
        const store: SessionStore = {};
        await mutator(store);
        return store;
      }),
    // Real scope resolver: spawn's admin-tier pinning depends on params-aware
    // sessions.patch policy, so a stub here would hide policy regressions.
    resolveLeastPrivilegeOperatorScopesForMethod,
    upsertSessionEntryCore: async (
      scope: { storePath?: string; sessionKey: string },
      patch: Record<string, unknown>,
      options?: { assertCommitAllowed?: () => void },
    ) => {
      const updateSessionStore =
        params.updateSessionStoreMock ??
        (async (_storePath: string, mutator: SessionStoreMutator) => {
          const store: SessionStore = {};
          await mutator(store);
          return store;
        });
      let updated: Record<string, unknown> | undefined;
      const storePath =
        scope.storePath ?? params.sessionStorePath ?? "/tmp/subagent-spawn-model-session.json";
      await updateSessionStore(storePath, (store: SessionStore) => {
        options?.assertCommitAllowed?.();
        updated = Object.assign({}, store[scope.sessionKey], patch);
        store[scope.sessionKey] = updated;
      });
      return updated ?? null;
    },
    getSessionBindingService:
      params.getSessionBindingService ??
      (() => ({
        getCapabilities: () => ({
          adapterAvailable: false,
          bindSupported: false,
          placements: [],
        }),
        bind: async () => {
          throw new Error("session binding adapter unavailable");
        },
        listBySession: () => [],
      })),
    resolveConversationDeliveryTarget:
      params.resolveConversationDeliveryTarget ??
      ((targetParams: { channel?: string; conversationId?: string | number }) => ({
        to: targetParams.conversationId
          ? `channel:${String(targetParams.conversationId)}`
          : undefined,
      })),
    mergeDeliveryContext: (
      primary?: Record<string, unknown>,
      fallback?: Record<string, unknown>,
    ) => ({
      ...fallback,
      ...primary,
    }),
    resolveGatewaySessionStoreTarget: (targetParams: { key: string }) => ({
      agentId: "main",
      storePath: params.sessionStorePath ?? "/tmp/subagent-spawn-model-session.json",
      canonicalKey: targetParams.key,
      storeKeys: [targetParams.key],
    }),
    normalizeDeliveryContext: identityDeliveryContext,
    resolveAgentConfig: params.resolveAgentConfig ?? (() => undefined),
    resolveAgentWorkspaceDir:
      params.resolveAgentWorkspaceDir ?? (() => params.workspaceDir ?? os.tmpdir()),
    resolveSandboxRuntimeStatus:
      params.resolveSandboxRuntimeStatus ?? (() => ({ sandboxed: false })),
    ...createDefaultSessionHelperMocks(),
  }));

  vi.doMock("./subagent-depth.js", () => ({
    getSubagentDepthFromSessionStore: params.getSubagentDepthFromSessionStore ?? (() => 0),
  }));

  vi.doMock("../registry/subagent-registry.js", () => ({
    completeCollectorLaunchCleanup: params.completeCollectorLaunchCleanupMock ?? vi.fn(),
    countActiveRunsForSession: params.countActiveRunsForSession ?? (() => 0),
    getSubagentDeliveryBacklogPressure: () => ({ suspended: 0, blocked: false }),
    listSwarmRunsForGroup: params.listSwarmRunsForGroup ?? vi.fn(() => []),
    registerSubagentRun:
      params.registerSubagentRunMock ?? vi.fn((_record: Record<string, unknown>) => undefined),
    resetSubagentRegistryForTests,
    settleFailedQueuedSubagentLaunch:
      params.settleFailedQueuedSubagentLaunchMock ?? vi.fn(() => true),
    startQueuedSubagentRun: params.startQueuedSubagentRunMock ?? vi.fn(() => true),
  }));

  const subagentSpawnModule = await import("./subagent-spawn.js");
  return {
    ...subagentSpawnModule,
    resetSubagentRegistryForTests,
  };
}
