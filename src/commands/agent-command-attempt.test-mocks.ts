// Command-attempt fixtures preserve execution handoffs without starting external runtimes.
import { vi } from "vitest";
import type { runAgentAttempt } from "../agents/command/attempt-execution.js";
import { resolveCollapsedSessionAuthPinSource } from "../config/sessions/auth-profile-override-provenance.js";
import {
  isAcpExecutionSelection,
  isModelExecutionSelection,
} from "../model-picker/execution-selection.js";
import { getAgentAttemptExecutionMocks } from "./agent-command-state.test-mocks.js";

const attemptExecutionMocks = getAgentAttemptExecutionMocks();
vi.mock("../agents/auth-profiles/store.js", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("../agents/auth-profiles/store.js")>()),
    hasAnyAuthProfileStoreSource: vi.fn(() => false),
  };
});
vi.mock("../agents/auth-profiles/store-runtime.js", async () => {
  const { getRuntimeAuthProfileStoreSnapshot } = await import("../agents/auth-profiles/store.js");
  const readStore = (agentDir?: string) =>
    getRuntimeAuthProfileStoreSnapshot(agentDir) ?? { version: 1, profiles: {} };
  return {
    ensureAuthProfileStore: vi.fn(readStore),
    ensureAuthProfileStoreForLocalUpdate: vi.fn(readStore),
    loadAuthProfileStore: vi.fn(readStore),
    loadAuthProfileStoreForRuntime: vi.fn(readStore),
    loadAuthProfileStoreForSecretsRuntime: vi.fn(readStore),
    loadAuthProfileStoreWithoutExternalProfiles: vi.fn(readStore),
    saveAuthProfileStore: vi.fn(),
    updateAuthProfileStoreWithLock: vi.fn(async () => readStore()),
  };
});

vi.mock("../agents/auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSource: vi.fn(() => false),
}));

vi.mock("../auto-reply/reply/session-stable-reply-mode.js", () => ({
  // Session-stable policy has owner coverage in the reply resolver suite. This
  // command suite only owns forwarding its result into CLI binding facts.
  resolveSessionStableReplyMode: vi.fn(() => "automatic"),
}));

vi.mock("../auto-reply/reply/source-reply-delivery-mode.js", () => ({
  // Source-reply policy has focused owner coverage. Command preparation only
  // needs to distinguish synthetic turns before forwarding stable facts.
  isSyntheticSourceReplyTurn: (params: {
    inputProvenance?: { kind?: string };
    isHeartbeat?: boolean;
  }) =>
    params.isHeartbeat === true ||
    params.inputProvenance?.kind === "inter_session" ||
    params.inputProvenance?.kind === "internal_system",
}));

vi.mock("../agents/harness/selection.js", () => ({
  // Availability fallback has focused owner coverage in selection.test.ts. The
  // command suite only needs a stable policy for auth-profile validation.
  resolveAvailableAgentHarnessPolicy: vi.fn(() => ({
    runtime: "openclaw",
    runtimeSource: "implicit",
  })),
}));

vi.mock("../agents/harness/hook-helpers.js", () => ({
  // Tool and transcript hook dispatch are exercised by their integration
  // suites. No command fixture in this file registers either hook.
  runAgentHarnessAfterToolCallHook: vi.fn(async () => undefined),
  runAgentHarnessBeforeMessageWriteHook: ({ message }: { message: unknown }) => message,
}));

vi.mock("../agents/thinking-runtime.js", () => ({
  // Runtime selection and catalog normalization have focused owner coverage in
  // thinking-runtime.test.ts. Command tests only need stable policy handoffs.
  hasResolvedThinkingCatalogEntry: (params: {
    catalog?: Array<{ id: string; provider: string; reasoning?: boolean }>;
    provider: string;
    model: string;
  }) =>
    params.catalog?.some(
      (entry) =>
        entry.provider.toLowerCase() === params.provider.toLowerCase() &&
        entry.id === params.model &&
        entry.reasoning !== undefined,
    ) ?? false,
  needsThinkHydration: (
    catalog: Array<{ id: string; provider: string; reasoning?: boolean }> | undefined,
    provider: string,
    model: string,
    agentRuntime: string,
  ) =>
    agentRuntime !== "openclaw" ||
    !catalog?.some(
      (entry) =>
        entry.provider.toLowerCase() === provider.toLowerCase() &&
        entry.id === model &&
        entry.reasoning !== undefined,
    ),
  normalizeThinkingCatalogProviders: <T extends { provider: string }>(catalog: T[]) =>
    catalog.map((entry) => ({ ...entry, provider: entry.provider.toLowerCase() })),
  resolveCandidateThinkingLevel: ({ level }: { level?: string }) => level,
  resolveEffectiveAgentRuntimeCore: vi.fn(() => "openclaw"),
}));

vi.mock("../agents/main-session-recovery/main-session-recovery-store.js", () => ({
  // Recovery-store fencing has dedicated store-backed coverage. None of these
  // command cases enters a persisted recovery cycle.
  claimMainSessionRecoveryOwner: vi.fn(async () => ({ kind: "not_required" })),
  commitMainSessionRecovery: vi.fn(async () => undefined),
  inspectMainSessionRecoveryRequired: vi.fn(async () => ({ kind: "not_required" })),
  refreshMainSessionRecoveryOwner: vi.fn(async () => undefined),
  releaseMainSessionRecoveryOwner: vi.fn(async () => undefined),
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  // Secret target discovery has dedicated owner coverage. These command
  // fixtures contain no SecretRefs and only need empty discovery results.
  getAgentRuntimeCommandSecretTargetIds: () => new Set<string>(),
  getAgentRuntimeOptionalCommandSecretPaths: () => new Set<string>(),
  getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
}));

vi.mock("../infra/outbound/channel-bootstrap.runtime.js", () => ({
  // Every channel fixture in this suite is already active. Bootstrap discovery
  // and its plugin-loader graph have focused owner coverage.
  bootstrapOutboundChannelPlugin: vi.fn(() => undefined),
  bootstrapOutboundChannelPluginAsync: vi.fn(() => undefined),
  resetOutboundChannelBootstrapStateForTests: vi.fn(),
}));

vi.mock("../config/sessions/inbound.runtime.js", () => ({
  // Explicit-recipient cases own route selection, not the downstream session
  // persistence exercised by outbound-session owner tests.
  resolveSessionStorePathCore: vi.fn(() => ""),
  updateSessionLastRoute: vi.fn(async () => null),
}));

vi.mock("../agents/command/assistant-transcript-repair.js", () => ({
  // Repair persistence, replay, and failure barriers have a focused owner
  // suite. These command cases contain no pending transcript repair records.
  persistAssistantTranscriptRepairRecord: vi.fn(async () => undefined),
  repairPendingAssistantTranscriptTurns: vi.fn(async () => undefined),
}));

vi.mock("../agents/command/session-store.runtime.js", async () => {
  const accessor = await import("../config/sessions/session-accessor.js");
  return {
    loadSessionEntry: accessor.loadSessionEntry,
    loadSessionEntryReadOnly: accessor.loadSessionEntryReadOnly,
    updateSessionStoreAfterAgentRun: vi.fn(async () => undefined),
  };
});

vi.mock("../agents/command/cli-compaction.js", () => {
  return {
    runCliTurnCompactionLifecycle: vi.fn(
      async (params: { sessionEntry?: unknown }) => params.sessionEntry,
    ),
  };
});

vi.mock("../agents/command/attempt-execution.runtime.js", () => {
  return {
    buildAcpResult: vi.fn(),
    createAcpToolLifecycleTracker: () => ({
      active: new Map(),
      terminalToolCallIds: new Set(),
      saturated: false,
    }),
    createAcpVisibleTextAccumulator: vi.fn(),
    emitAcpAssistantDelta: vi.fn(),
    emitAcpLifecycleEnd: vi.fn(),
    emitAcpLifecycleError: vi.fn(),
    emitAcpLifecycleStart: vi.fn(),
    persistAcpTurnTranscript: vi.fn(async (params: { sessionEntry?: unknown }) => ({
      kind: "persisted",
      sessionEntry: params.sessionEntry,
    })),
    persistCliTurnTranscript: vi.fn(async (params: { sessionEntry?: unknown }) => ({
      kind: "persisted",
      sessionEntry: params.sessionEntry,
    })),
    runAgentAttempt: vi.fn(async (params: Parameters<typeof runAgentAttempt>[0]) => {
      if (attemptExecutionMocks.useRealRunAgentAttempt) {
        const actual = await vi.importActual<
          typeof import("../agents/command/attempt-execution.js")
        >("../agents/command/attempt-execution.js");
        return await actual.runAgentAttempt(params);
      }
      const { opts, runContext, sessionEntry, executionSelection } = params;
      if (isAcpExecutionSelection(executionSelection)) {
        throw new Error("This attempt requires its bound app to run through the native manager.");
      }
      const selectedModel = isModelExecutionSelection(executionSelection)
        ? executionSelection.model
        : undefined;
      const authProfileId =
        selectedModel?.provider === params.authProfileProvider
          ? sessionEntry?.authProfileOverride
          : undefined;

      const { runEmbeddedAgent } = await import("../agents/embedded-agent.js");
      return await runEmbeddedAgent({
        preparedRunAdmission: params.preparedRunAdmission,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.sessionAgentId,
        trigger: "user",
        messageChannel: params.messageChannel,
        agentAccountId: runContext.accountId,
        messageTo: opts.replyTo ?? opts.to,
        messageThreadId: opts.threadId,
        sessionFile: params.sessionFile,
        workspaceDir: params.workspaceDir,
        config: params.cfg,
        skillsSnapshot: params.skillsSnapshot,
        prompt: params.body,
        images: opts.images,
        imageOrder: opts.imageOrder,
        clientTools: opts.clientTools,
        provider: selectedModel?.provider,
        model: selectedModel?.id,
        agentHarnessRuntimeOverride: executionSelection.executor.id,
        agentHarnessRuntimePreparationHint: executionSelection.executor.id,
        authProfileId,
        authProfileIdSource: authProfileId
          ? resolveCollapsedSessionAuthPinSource(sessionEntry)
          : undefined,
        thinkLevel: params.resolvedThinkLevel,
        fastMode: params.fastMode,
        verboseLevel: params.resolvedVerboseLevel,
        timeoutMs: params.timeoutMs,
        runId: params.runId,
        lifecycleGeneration: params.lifecycleGeneration,
        lane: opts.lane,
        abortSignal: opts.abortSignal,
        extraSystemPrompt: opts.extraSystemPrompt,
        bootstrapContextMode: opts.bootstrapContextMode,
        bootstrapContextRunKind: opts.bootstrapContextRunKind,
        internalEvents: opts.internalEvents,
        inputProvenance: opts.inputProvenance,
        streamParams: opts.streamParams,
        agentDir: params.agentDir,
        allowTransientCooldownProbe: params.allowTransientCooldownProbe,
        cleanupBundleMcpOnRunEnd: opts.cleanupBundleMcpOnRunEnd,
        oneShotCliRun: opts.oneShotCliRun,
        modelRun: opts.modelRun,
        promptMode: opts.promptMode,
        disableTools: opts.modelRun === true,
        onAgentEvent: params.onAgentEvent,
      });
    }),
    sessionTranscriptHasContent: vi.fn(async () => false),
  };
});
vi.mock("../config/sessions/transcript-resolve.runtime.js", () => {
  return {
    resolveSessionTranscriptFile: vi.fn(
      async (params: {
        sessionId: string;
        sessionKey: string;
        sessionEntry?: { sessionFile?: string; sessionId?: string };
        sessionStore?: Record<string, { sessionFile?: string; sessionId?: string }>;
        storePath?: string;
        agentId: string;
        threadId?: string | number;
      }) => {
        const sessionFile =
          params.sessionEntry?.sessionFile ??
          `sqlite:${params.agentId}:${params.sessionId}:${params.storePath ?? ""}`;
        let sessionEntry = params.sessionEntry;
        if (params.sessionStore && params.sessionKey) {
          const existingEntry = params.sessionStore[params.sessionKey] ?? {};
          sessionEntry = {
            ...existingEntry,
            sessionId: params.sessionId,
            sessionFile,
          };
          params.sessionStore[params.sessionKey] = sessionEntry;
        }
        return { sessionFile, sessionEntry };
      },
    ),
  };
});
