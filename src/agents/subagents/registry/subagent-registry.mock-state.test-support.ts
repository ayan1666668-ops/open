import { vi } from "vitest";
import type { SessionEntry } from "../../../config/sessions.js";
import type {
  SessionAccessScope,
  SessionEntryPatchContext,
  SessionEntryPatchOptions,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import type {
  SessionIdentityMutation,
  SessionIdentityMutationListener,
} from "../../../sessions/session-lifecycle-events.js";
import { notifyListeners, registerListener } from "../../../shared/listeners.js";
import type {
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const noop = () => {};

export function createSubagentRegistryMockState() {
  const sessionIdentityMutationListeners = new Set<SessionIdentityMutationListener>();
  const mocks = {
    callGateway:
      vi.fn<
        (request: {
          method?: string;
          params?: Record<string, unknown>;
          scopes?: string[];
          timeoutMs?: number | null;
        }) => Promise<Record<string, unknown>>
      >(),
    onAgentEvent: vi.fn<(_handler: (event: AgentEventPayload) => void) => typeof noop>(() => noop),
    getAgentRunContext: vi.fn<(_runId: string) => unknown>(() => undefined),
    getRuntimeConfig: vi.fn<() => OpenClawConfig>(() => ({
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" as const },
    })),
    loadSessionEntry: vi.fn((scope: SessionAccessScope) => {
      const store = mocks.loadSessionStore(scope.storePath, { clone: false }) as Record<
        string,
        SessionEntry
      >;
      return store[scope.sessionKey];
    }),
    listSessionEntriesCore: vi.fn((scope: Omit<SessionAccessScope, "sessionKey">) => {
      const store = mocks.loadSessionStore(scope.storePath, { clone: false }) as Record<
        string,
        SessionEntry
      >;
      return Object.entries(store).map(([sessionKey, entry]) => ({ sessionKey, entry }));
    }),
    loadSessionStore: vi.fn((_storePath?: string, _options?: { clone?: boolean }) => ({})),
    patchSessionEntryCore: vi.fn(
      async (
        scope: SessionAccessScope,
        update: (
          entry: SessionEntry,
          context: SessionEntryPatchContext,
        ) => Partial<SessionEntry> | null | Promise<Partial<SessionEntry> | null>,
        options: SessionEntryPatchOptions = {},
      ) => {
        let updatedEntry: SessionEntry | null = null;
        const store = mocks.loadSessionStore(scope.storePath, { clone: false }) as Record<
          string,
          SessionEntry
        >;
        const currentEntry = store[scope.sessionKey];
        if (!currentEntry) {
          return null;
        }
        const patch = await update(currentEntry, { existingEntry: { ...currentEntry } });
        if (!patch) {
          return currentEntry;
        }
        const applyPatch = (targetStore: Record<string, SessionEntry>) => {
          const targetEntry = targetStore[scope.sessionKey] ?? currentEntry;
          updatedEntry = options.replaceEntry
            ? (patch as SessionEntry)
            : { ...targetEntry, ...patch };
          targetStore[scope.sessionKey] = updatedEntry;
        };
        mocks.updateSessionStore(scope.storePath, applyPatch);
        applyPatch(store);
        return updatedEntry;
      },
    ),
    resolveAgentIdFromSessionKey: vi.fn((sessionKey: string) => {
      return sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main";
    }),
    resolveStorePath: vi.fn(() => "/tmp/test-session-store.json"),
    updateSessionStore: vi.fn(),
    emitSessionLifecycleEvent: vi.fn(),
    onSessionIdentityMutation: vi.fn((listener: SessionIdentityMutationListener) =>
      registerListener(sessionIdentityMutationListeners, listener),
    ),
    emitSessionIdentityMutation: vi.fn((mutation: SessionIdentityMutation) =>
      notifyListeners(sessionIdentityMutationListeners, mutation),
    ),
    clearSubagentRunsReadCacheForTest: vi.fn(),
    persistSubagentRunsToDisk: vi.fn<typeof persistSubagentRunsToDisk>(),
    persistSubagentRunsToDiskOrThrow: vi.fn<typeof persistSubagentRunsToDiskOrThrow>(),
    restoreSubagentRunsFromDisk: vi.fn<typeof restoreSubagentRunsFromDisk>(() => 0),
    getSubagentRunsSnapshotForRead: vi.fn(
      (runs: Map<string, import("./subagent-registry.types.js").SubagentRunRecord>) =>
        new Map(runs),
    ),
    getSubagentRunsSnapshotForChildSession: vi.fn(
      (runs: Map<string, import("./subagent-registry.types.js").SubagentRunRecord>) =>
        new Map(runs),
    ),
    getSubagentRunsSnapshotForController: vi.fn(
      (runs: Map<string, import("./subagent-registry.types.js").SubagentRunRecord>) =>
        new Map(runs),
    ),
    captureSubagentCompletionReply: vi.fn(async () => "final completion reply"),
    cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
    runSubagentAnnounceFlow: vi.fn(async (): Promise<"delivered" | "retryable"> => "delivered"),
    maybeWakeRequesterAfterAllChildrenSettled: vi.fn(
      async (wakeParams: {
        settledEntry: SubagentRunRecord;
        completeBatch(batch: readonly SubagentRunRecord[]): void;
      }) => {
        wakeParams.completeBatch([wakeParams.settledEntry]);
        return false;
      },
    ),
    getGlobalHookRunner: vi.fn(() => null),
    ensureContextEnginesInitialized: vi.fn(),
    loadAgentRuntimePluginRegistryHandle: vi.fn(),
    resolveContextEngine: vi.fn(),
    onSubagentEnded: vi.fn<
      (params: { childSessionKey?: string }, context?: unknown) => Promise<void>
    >(async () => {}),
    runSubagentEnded: vi.fn(async () => {}),
    removeInternalSessionEffectsSession: vi.fn(async () => {}),
    resolveAgentTimeoutMs: vi.fn(() => 1_000),
    dispatchRecoveryAgent: vi.fn(),
    getGatewayRecoveryRuntime: vi.fn(() => ({
      dispatchAgent: mocks.dispatchRecoveryAgent as GatewayRecoveryRuntime["dispatchAgent"],
      waitForAgent: vi.fn(),
      sendRecoveryNotice: vi.fn(),
    })),
    lifecycleGeneration: "test-generation",
  };
  return mocks;
}
