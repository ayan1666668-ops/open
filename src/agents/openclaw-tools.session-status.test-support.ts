import { beforeEach, vi } from "vitest";
import type { SessionEntryPatchOptions } from "../config/sessions/session-accessor.types.js";
import { resolveSessionStoreEntryCore } from "../config/sessions/store-entry.js";
import { mergeSessionEntry, type SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearInternalHooks } from "../hooks/internal-hooks.js";
import { normalizeLegacySessionEntryDelivery } from "../infra/state-migrations.legacy-session-store.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { buildTaskStatusSnapshot } from "../tasks/task-status.js";
import { acceptedModelSelection } from "../test-utils/session-execution-selection.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createSessionModelCatalogFixture } from "./test-helpers/session-model-catalog.test-support.js";

export const loadSessionStoreMock = vi.fn();
export const updateSessionStoreMock = vi.fn();
export const callGatewayMock = vi.fn();
const agentToolGatewayCallMock = vi.fn();
const buildStatusMessageMock = vi.hoisted(() =>
  vi.fn((_params?: unknown) => "OpenClaw\n🧠 Model: GPT-5.4"),
);
const resolveQueueSettingsMock = vi.hoisted(() =>
  vi.fn((_params?: unknown) => ({ mode: "interrupt" })),
);
const listTasksForRelatedSessionKeyForOwnerMock = vi.hoisted(() =>
  vi.fn(
    (_params: { relatedSessionKey: string; callerOwnerKey: string }) =>
      [] as Array<Record<string, unknown>>,
  ),
);
const resolveEnvApiKeyMock = vi.hoisted(() =>
  vi.fn((_provider?: string, _env?: NodeJS.ProcessEnv) => null),
);
const resolveUsableCustomProviderApiKeyMock = vi.hoisted(() =>
  vi.fn((_params?: { provider?: string }) => null as { apiKey: string; source: string } | null),
);
const getSessionStateVersionMock = vi.hoisted(() =>
  vi.fn((_sessionKey: string, _agentId: string) => 0),
);
const listSessionStateEventsSinceMock = vi.hoisted(() =>
  vi.fn((_sessionKey: string, _agentId: string, _after: number, _limit: number) => ({
    events: [] as Array<Record<string, unknown>>,
    truncated: false,
    earliestAvailableSequence: 0,
    historyGap: false,
  })),
);
export {
  buildStatusMessageMock,
  resolveQueueSettingsMock,
  listTasksForRelatedSessionKeyForOwnerMock,
  resolveUsableCustomProviderApiKeyMock,
  getSessionStateVersionMock,
  listSessionStateEventsSinceMock,
};
const emptyPluginMetadataSnapshot = {
  configFingerprint: "session-status-test-empty-plugin-metadata",
  ...createPluginMetadataSnapshotFixture(),
};
export const statusModelProviders: NonNullable<OpenClawConfig["models"]>["providers"] = {
  openai: {
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    auth: "api-key",
    agentRuntime: { id: "openclaw" },
    models: [],
  },
  anthropic: {
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    auth: "api-key",
    models: [],
  },
  custom: {
    api: "openai-completions",
    baseUrl: "https://session-status.invalid/v1",
    auth: "api-key",
    models: [],
  },
};
const statusCatalog: ModelCatalogEntry[] = [
  {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    contextWindow: 200000,
  },
  {
    provider: "openai",
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    contextWindow: 400000,
  },
  {
    provider: "custom",
    id: "team/Reader",
    name: "Reader",
    api: "openai-completions",
    baseUrl: "https://session-status.invalid/v1",
  },
];
let catalogFixture: ReturnType<typeof createSessionModelCatalogFixture> | undefined;

export const createMockConfig = () => ({
  session: { mainKey: "main", scope: "per-sender" },
  models: { providers: statusModelProviders },
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.4" },
      models: {},
    },
  },
  tools: {
    agentToAgent: { enabled: false },
  },
});

export const statusFixture: { config: Record<string, unknown> } = { config: createMockConfig() };
const TASK_STATUS_SNAPSHOT_NOW = 1_000_000_000_000;

function createScopedSessionStores() {
  // Two stores simulate per-agent session files selected by scoped status lookups.
  return new Map<string, Record<string, unknown>>([
    [
      "/tmp/main/sessions.json",
      {
        "agent:main:main": { sessionId: "s-main", updatedAt: 10 },
      },
    ],
    [
      "/tmp/support/sessions.json",
      {
        main: { sessionId: "s-support", updatedAt: 20 },
      },
    ],
  ]);
}

export function installScopedSessionStores(syncUpdates = false) {
  // Tests choose whether session-store writes should mutate the backing map.
  const stores = createScopedSessionStores();
  loadSessionStoreMock.mockClear();
  updateSessionStoreMock.mockClear();
  callGatewayMock.mockClear();
  loadSessionStoreMock.mockImplementation((storePath: string) => stores.get(storePath) ?? {});
  if (syncUpdates) {
    updateSessionStoreMock.mockImplementation(
      (storePath: string, store: Record<string, unknown>) => {
        if (storePath) {
          stores.set(storePath, store);
        }
      },
    );
  }
  return stores;
}

function createSessionsModuleMock() {
  const resolveMockStorePath = (_store: string | undefined, opts?: { agentId?: string }) =>
    opts?.agentId === "support" ? "/tmp/support/sessions.json" : "/tmp/main/sessions.json";
  const cloneEntry = (entry: SessionEntry): SessionEntry => structuredClone(entry);
  return {
    loadSessionEntry: (scope: { agentId?: string; sessionKey: string; storePath?: string }) => {
      const storePath =
        scope.storePath ?? resolveMockStorePath(undefined, { agentId: scope.agentId });
      const store: Record<string, SessionEntry> = loadSessionStoreMock(storePath);
      const entry = resolveSessionStoreEntryCore({ store, sessionKey: scope.sessionKey }).existing;
      return entry ? cloneEntry(entry) : undefined;
    },
    patchSessionEntryWithKey: async (
      scope: { agentId?: string; sessionKey: string; storePath?: string },
      update: (
        entry: SessionEntry,
        context: { existingEntry?: SessionEntry },
      ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
      options?: Pick<
        SessionEntryPatchOptions,
        "fallbackEntry" | "replaceEntry" | "assertCommitAllowed"
      >,
    ) => {
      const storePath =
        scope.storePath ?? resolveMockStorePath(undefined, { agentId: scope.agentId });
      const store = loadSessionStoreMock(storePath) as Record<string, SessionEntry>;
      const resolved = resolveSessionStoreEntryCore({ store, sessionKey: scope.sessionKey });
      const existing = resolved.existing ?? options?.fallbackEntry;
      if (!existing) {
        return null;
      }
      const patch = await update(cloneEntry(existing), {
        existingEntry: resolved.existing ? cloneEntry(resolved.existing) : undefined,
      });
      options?.assertCommitAllowed?.();
      if (!patch) {
        return { sessionKey: resolved.normalizedKey, entry: cloneEntry(existing) };
      }
      const next = options?.replaceEntry
        ? cloneEntry(patch as SessionEntry)
        : mergeSessionEntry(existing, patch);
      store[resolved.normalizedKey] = next;
      updateSessionStoreMock(storePath, store);
      return { sessionKey: resolved.normalizedKey, entry: cloneEntry(next) };
    },
    resolveSessionEntryCandidateTarget: (scope: {
      agentId: string;
      candidateKeys: readonly string[];
      cfg: { session?: { store?: string } };
      fallback?: { sessionKey: string; entry: SessionEntry };
    }) => {
      const storePath = resolveMockStorePath(scope.cfg.session?.store, { agentId: scope.agentId });
      const store = loadSessionStoreMock(storePath) as Record<string, SessionEntry>;
      const candidates = [...new Set(scope.candidateKeys.map((key) => key.trim()))];
      for (const candidateKey of candidates) {
        if (!candidateKey) {
          continue;
        }
        const resolved = resolveSessionStoreEntryCore({ store, sessionKey: candidateKey });
        if (!resolved.existing) {
          continue;
        }
        return {
          agentId: scope.agentId,
          candidateKey,
          entry: cloneEntry(resolved.existing),
          persisted: true,
          sessionKey: resolved.normalizedKey,
        };
      }
      const fallbackKey = scope.fallback?.sessionKey.trim();
      return fallbackKey && scope.fallback
        ? {
            agentId: scope.agentId,
            candidateKey: fallbackKey,
            entry: cloneEntry(scope.fallback.entry),
            persisted: false,
            sessionKey: fallbackKey,
          }
        : null;
    },
    resolveSessionStorePathCore: resolveMockStorePath,
  };
}

function createGatewayCallModuleMock() {
  return {
    callGateway: (opts: unknown) => callGatewayMock(opts),
  };
}

function createInProcessGatewayModuleMock() {
  return {
    callAgentToolGatewayRequest: (opts: unknown) => agentToolGatewayCallMock(opts),
  };
}

function createConfigModuleMock() {
  return {
    getRuntimeConfig: () => statusFixture.config,
  };
}

function createModelCatalogModuleMock() {
  return {
    loadProviderScopedThinkingCatalog: async () => [],
    // A run's captured config goes stale after any Gateway config republish; the exact
    // loader then throws, and session_status must read the published owner instead.
    readPreparedModelCatalog: async () => {
      throw new Error("prepared model catalog owner config was replaced during the read (/tmp)");
    },
    loadPublishedPreparedModelCatalog: async (params: {
      config: OpenClawConfig;
      agentId: string;
    }) => {
      catalogFixture?.publish({
        config: params.config,
        agentId: params.agentId,
        catalog: { entries: statusCatalog, routeVariants: [] },
        profiles: {
          "openai:fixture": { type: "api_key", provider: "openai", key: "synthetic-status-key" },
          "anthropic:fixture": {
            type: "api_key",
            provider: "anthropic",
            key: "synthetic-status-key",
          },
          "custom:fixture": { type: "api_key", provider: "custom", key: "synthetic-status-key" },
          "session-status-team:prod": {
            type: "api_key",
            provider: "openai",
            key: "synthetic-account-key",
          },
        },
      });
      return statusCatalog;
    },
  };
}

function createAuthProfilesModuleMock() {
  return {
    ensureAuthProfileStore: () => ({ profiles: {} }),
    resolveAuthProfileDisplayLabel: () => undefined,
    resolveAuthProfileOrder: () => [],
  };
}

function createModelAuthModuleMock() {
  return {
    resolveEnvApiKey: resolveEnvApiKeyMock,
    resolveUsableCustomProviderApiKey: resolveUsableCustomProviderApiKeyMock,
    resolveModelAuthMode: () => "api-key",
  };
}

function createProviderUsageModuleMock() {
  return {
    resolveUsageProviderId: () => undefined,
    loadProviderUsageSummary: async () => ({
      updatedAt: Date.now(),
      providers: [],
    }),
  };
}

function formatPrimaryModelLabel(provider: string | undefined, model: string): string {
  return provider ? `${provider}/${model}` : model;
}

function formatStatusLines(primary: string, taskLineOverride: string | undefined): string {
  return taskLineOverride
    ? `OpenClaw\n🧠 Model: ${primary}\n${taskLineOverride}`
    : `OpenClaw\n🧠 Model: ${primary}`;
}

function createCommandsStatusRuntimeModuleMock() {
  // Status text mock keeps model/task/session routing observable in one place.
  return {
    buildStatusText: async (params: {
      sessionKey: string;
      sessionEntry: SessionEntry;
      statusChannel: string;
      provider?: string;
      model: string;
      thinkingCatalog?: Array<{ provider: string; id: string; contextWindow?: number }>;
      workspaceDir?: string;
      primaryModelLabelOverride?: string;
      includeTranscriptUsage?: boolean;
      taskLineOverride?: string;
      resolveDefaultThinkingLevel?: () => unknown;
    }) => {
      resolveQueueSettingsMock({
        channel: params.statusChannel,
        sessionEntry: params.sessionEntry,
      });
      const parsed = params.sessionKey.startsWith("agent:") ? params.sessionKey.split(":") : null;
      const agentId = parsed?.[1] || "main";
      const configuredAgent = Array.isArray(
        (statusFixture.config as { agents?: { list?: Array<Record<string, unknown>> } }).agents
          ?.list,
      )
        ? (
            statusFixture.config as { agents?: { list?: Array<Record<string, unknown>> } }
          ).agents?.list?.find((entry) => entry.id === agentId)
        : undefined;
      const primary =
        params.primaryModelLabelOverride ?? formatPrimaryModelLabel(params.provider, params.model);
      const customAuth = params.provider
        ? resolveUsableCustomProviderApiKeyMock({ provider: params.provider })
        : null;
      const envAuth =
        !customAuth && params.provider ? resolveEnvApiKeyMock(params.provider, process.env) : null;
      const modelAuth = customAuth
        ? `api-key (${customAuth.source})`
        : envAuth
          ? "api-key (env)"
          : undefined;
      buildStatusMessageMock({
        agentId,
        agent: {
          model: { primary },
          thinkingDefault:
            configuredAgent?.thinkingDefault ?? (await params.resolveDefaultThinkingLevel?.()),
        },
        sessionEntry: params.sessionEntry,
        modelAuth,
        thinkingCatalog: params.thinkingCatalog,
        includeTranscriptUsage: params.includeTranscriptUsage,
        workspaceDir: params.workspaceDir,
      });
      return formatStatusLines(primary, params.taskLineOverride);
    },
  };
}

vi.mock("../config/sessions.js", createSessionsModuleMock);
vi.mock("../config/sessions/session-accessor.js", () => {
  const { loadSessionEntry } = createSessionsModuleMock();
  return { loadSessionEntry, loadSessionEntryReadOnly: loadSessionEntry };
});
vi.mock("../gateway/call.js", createGatewayCallModuleMock);
vi.mock("./tools/in-process-gateway.js", createInProcessGatewayModuleMock);
vi.mock("../config/config.js", createConfigModuleMock);
vi.mock("../agents/prepared-model-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prepared-model-catalog.js")>()),
  ...createModelCatalogModuleMock(),
}));
vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));
vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
}));
vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  isPluginMetadataSnapshotCompatible: () => true,
  resolvePluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
}));
vi.mock("../plugins/provider-thinking.js", () => ({
  resolveProviderBinaryThinking: () => undefined,
  resolveProviderDefaultThinkingLevel: () => undefined,
  resolveEffectiveThinkingProfile: () => undefined,
  resolveProviderXHighThinking: () => undefined,
}));
// Keep provider-runtime/plugin activation out of this focused tool test. The
// session_status surface only needs model selection semantics here, not real
// bundled provider registration.
vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: () => [],
}));
vi.mock("../agents/auth-profiles.js", createAuthProfilesModuleMock);
vi.mock("../agents/model-auth.js", createModelAuthModuleMock);
vi.mock("../infra/provider-usage.js", createProviderUsageModuleMock);
vi.mock("../status/status-text.js", createCommandsStatusRuntimeModuleMock);
vi.mock("../auto-reply/group-activation.js", () => ({
  normalizeGroupActivation: (value: unknown) => value ?? "always",
}));
vi.mock("../auto-reply/reply/queue.js", () => ({
  getFollowupQueueDepth: () => 0,
  resolveQueueSettings: resolveQueueSettingsMock,
}));
vi.mock("../tasks/task-owner-access.js", () => ({
  listTasksForRelatedSessionKeyForOwner: (params: {
    relatedSessionKey: string;
    callerOwnerKey: string;
  }) => listTasksForRelatedSessionKeyForOwnerMock(params),
  buildTaskStatusSnapshotForRelatedSessionKeyForOwner: (params: {
    relatedSessionKey: string;
    callerOwnerKey: string;
  }) =>
    buildTaskStatusSnapshot(listTasksForRelatedSessionKeyForOwnerMock(params) as TaskRecord[], {
      now: TASK_STATUS_SNAPSHOT_NOW,
    }),
}));
vi.mock("../sessions/session-state-events.js", () => ({
  getSessionStateVersion: (sessionKey: string, agentId: string) =>
    getSessionStateVersionMock(sessionKey, agentId),
  listSessionStateEventsSince: (
    sessionKey: string,
    agentId: string,
    after: number,
    limit: number,
  ) => listSessionStateEventsSinceMock(sessionKey, agentId, after, limit),
}));
export function resetSessionStore(inputStore: Record<string, SessionEntry>) {
  const store = Object.fromEntries(
    Object.entries(inputStore).map(([key, entry]) => [
      key,
      normalizeLegacySessionEntryDelivery(entry),
    ]),
  ) as Record<string, SessionEntry>;
  buildStatusMessageMock.mockClear();
  resolveQueueSettingsMock.mockClear();
  resolveQueueSettingsMock.mockReturnValue({ mode: "interrupt" });
  resolveEnvApiKeyMock.mockReset();
  resolveEnvApiKeyMock.mockReturnValue(null);
  resolveUsableCustomProviderApiKeyMock.mockReset();
  resolveUsableCustomProviderApiKeyMock.mockReturnValue(null);
  loadSessionStoreMock.mockClear();
  updateSessionStoreMock.mockClear();
  callGatewayMock.mockClear();
  agentToolGatewayCallMock.mockReset();
  agentToolGatewayCallMock.mockImplementation((opts: unknown) => callGatewayMock(opts));
  listTasksForRelatedSessionKeyForOwnerMock.mockClear();
  listTasksForRelatedSessionKeyForOwnerMock.mockReturnValue([]);
  getSessionStateVersionMock.mockReset();
  getSessionStateVersionMock.mockReturnValue(0);
  listSessionStateEventsSinceMock.mockReset();
  listSessionStateEventsSinceMock.mockReturnValue({
    events: [],
    truncated: false,
    earliestAvailableSequence: 0,
    historyGap: false,
  });
  loadSessionStoreMock.mockReturnValue(store);
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string; params?: Record<string, unknown> };
    if (request.method === "sessions.resolve") {
      const key = typeof request.params?.key === "string" ? request.params.key.trim() : "";
      if (key && store[key]) {
        const spawnedBy =
          typeof request.params?.spawnedBy === "string" ? request.params.spawnedBy.trim() : "";
        const entry = store[key];
        if (!spawnedBy || entry.spawnedBy === spawnedBy || entry.parentSessionKey === spawnedBy) {
          return { key };
        }
        return {};
      }
      const sessionId =
        typeof request.params?.sessionId === "string" ? request.params.sessionId.trim() : "";
      if (!sessionId) {
        return {};
      }
      const spawnedBy =
        typeof request.params?.spawnedBy === "string" ? request.params.spawnedBy.trim() : "";
      const matches = Object.entries(store).filter((entry): entry is [string, SessionEntry] => {
        return (
          entry[1].sessionId === sessionId &&
          (!spawnedBy ||
            entry[1].spawnedBy === spawnedBy ||
            entry[1].parentSessionKey === spawnedBy)
        );
      });
      return { key: resolvePreferredSessionKeyForSessionIdMatches(matches, sessionId) };
    }
    if (request.method === "sessions.list") {
      return { sessions: [] };
    }
    return {};
  });
  statusFixture.config = createMockConfig();
}

export function installSandboxedSessionStatusConfig() {
  statusFixture.config = {
    session: { mainKey: "main", scope: "per-sender" },
    tools: {
      sessions: { visibility: "all" },
      agentToAgent: { enabled: true, allow: ["*"] },
    },
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.4" },
        models: {},
        sandbox: { sessionToolsVisibility: "spawned" },
      },
    },
  };
}

export function installSameAgentVisibility(visibility: "self" | "tree" | "agent") {
  resetSessionStore({
    "agent:main:main": {
      sessionId: "s-parent",
      updatedAt: 10,
      executionSelection: acceptedModelSelection("anthropic", "claude-sonnet-4-6"),
    },
    "agent:main:subagent:child": { sessionId: "s-child", updatedAt: 20 },
  });
  statusFixture.config = {
    session: { mainKey: "main", scope: "per-sender" },
    tools: {
      sessions: { visibility },
      agentToAgent: { enabled: true, allow: ["*"] },
    },
    agents: { defaults: { model: { primary: "openai/gpt-5.4" }, models: {} } },
    models: { providers: statusModelProviders },
  };
}

export function mockSpawnedSessionList(
  resolveSessions: (spawnedBy: string | undefined) => Array<Record<string, unknown>>,
  resolveSessionId?: (sessionId: string) => string | undefined,
) {
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string; params?: Record<string, unknown> };
    if (request.method === "sessions.resolve") {
      const key = typeof request.params?.key === "string" ? request.params.key.trim() : "";
      const spawnedBy = request.params?.spawnedBy as string | undefined;
      if (key && resolveSessions(spawnedBy).some((session) => session.key === key)) {
        return { key };
      }
      const sessionId =
        typeof request.params?.sessionId === "string" ? request.params.sessionId.trim() : "";
      if (sessionId && !spawnedBy) {
        return { key: resolveSessionId?.(sessionId) };
      }
      return {};
    }
    if (request.method === "sessions.list") {
      return { sessions: resolveSessions(request.params?.spawnedBy as string | undefined) };
    }
    return {};
  });
}

beforeEach(() => {
  catalogFixture = createSessionModelCatalogFixture();
  buildStatusMessageMock.mockClear();
  clearInternalHooks();
});
