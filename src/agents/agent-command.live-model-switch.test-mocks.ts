import { toStringifiedError } from "@openclaw/normalization-core";
import { vi } from "vitest";
import type { ResolveManagerSession } from "../acp/control-plane/manager.types.js";
import type { SessionEntry } from "../config/sessions.js";
import { createTestModelVisibilityPolicy } from "./agent-command.model-selection.test-support.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";

export function createTestThinkingPolicy(state: {
  isThinkingLevelSupportedMock: (args: unknown) => boolean;
  resolveSupportedThinkingLevelMock: (args: { level?: string }) => string | undefined;
  resolveThinkingDefaultMock: (args: unknown) => string;
}) {
  return {
    formatThinkingLevels: () => "low, medium, high",
    normalizeThinkLevel: (v?: string) => v || undefined,
    normalizeVerboseLevel: (v?: string) => v || undefined,
    isThinkingLevelSupported: (args: unknown) => state.isThinkingLevelSupportedMock(args),
    resolveSupportedThinkingLevel: (args: { level?: string }) =>
      state.resolveSupportedThinkingLevelMock(args),
    resolveThinkingSelectionForModel: (args: { level?: string }) => {
      const requestedLevel = args.level ?? state.resolveThinkingDefaultMock(args);
      const policy = { ...args, level: requestedLevel };
      return {
        requestedLevel,
        level: state.resolveSupportedThinkingLevelMock(policy),
        supported: state.isThinkingLevelSupportedMock(policy),
      };
    },
    supportsXHighThinking: () => false,
  };
}

export function createTestRuntimePlugins(
  getRegistry: () => ReturnType<
    typeof import("../plugins/registry-empty.js").createEmptyPluginRegistry
  >,
) {
  return {
    withAgentPluginRegistry: ({ run }: { run: () => unknown }) => run(),
    loadAgentRuntimePluginRegistryHandle: getRegistry,
    acquireAgentRuntimePluginRegistry: async () => {
      const registry = getRegistry();
      return { registry, primaryRegistry: registry };
    },
  };
}
const state = vi.hoisted(() => ({
  defaultRuntimeConfig: {
    agents: {
      defaults: {
        models: {
          "anthropic/claude": {},
          "openai/claude": {},
          "openai/gpt-5.4": {},
        },
      },
    },
  },
  runtimeConfigMock: undefined as unknown,
  acpResolveSessionMock: vi
    .fn<
      (params: Parameters<ResolveManagerSession>[0]) => ReturnType<ResolveManagerSession> | null
    >()
    .mockReturnValue(null),
  acpRunTurnMock: vi.fn((..._args: unknown[]): unknown => undefined),
  buildAcpResultMock: vi.fn(),
  createAcpVisibleTextAccumulatorMock: vi.fn(),
  emitAcpLifecycleStartMock: vi.fn(),
  emitAcpLifecycleEndMock: vi.fn(),
  emitAcpLifecycleErrorMock: vi.fn(),
  emitAcpRuntimeEventMock: vi.fn(),
  gatewayCallMock: vi.fn(),
  persistCliTurnTranscriptMock: vi.fn(),
  persistAcpTurnTranscriptMock: vi.fn(),
  resolveAcpLifecycleEndFieldsMock: vi.fn(),
  appendExactAssistantMessageMock: vi.fn(),
  runCliTurnCompactionLifecycleMock: vi.fn(),
  runMemoryFlushIfNeededMock: vi.fn(
    async ({
      sessionEntry,
    }: {
      sessionEntry?: SessionEntry;
    }): Promise<{ sessionEntry?: SessionEntry; outcome: "skipped" | "failed" }> => ({
      sessionEntry,
      outcome: "skipped",
    }),
  ),
  resolveAcpAgentPolicyErrorMock: vi.fn(),
  resolveAcpDispatchPolicyErrorMock: vi.fn(),
  resolveAcpExplicitTurnPolicyErrorMock: vi.fn(),
  runWithModelFallbackMock: vi.fn(),
  runAgentAttemptMock: vi.fn(),
  resolveAgentSkillsFilterMock: vi.fn(
    (_cfg?: unknown, _agentId?: string): string[] | undefined => undefined,
  ),
  isModelSelectionLockedMock: vi.fn(
    (entry: unknown) =>
      (entry as { modelSelectionLocked?: boolean } | undefined)?.modelSelectionLocked === true,
  ),
  resolveChannelModelOverrideMock: vi.fn((_params: unknown) => null as unknown),
  assertLifecycleCurrentMock: vi.fn(),
  emitAgentEventMock: vi.fn(),
  registerAgentRunContextMock: vi.fn(),
  clearAgentRunContextMock: vi.fn(),
  loadSessionEntryMock: vi.fn(),
  updateSessionStoreAfterAgentRunMock: vi.fn(),
  deliverAgentCommandResultMock: vi.fn(),
  resolveAgentDeliveryPlanMock: vi.fn(),
  resolveAgentDeliveryPlanWithSessionRouteMock: vi.fn(),
  resolveAgentOutboundTargetMock: vi.fn(),
  resolveMessageChannelSelectionMock: vi.fn(),
  createTrajectoryRuntimeRecorderMock: vi.fn(),
  trajectoryRecordEventMock: vi.fn(),
  trajectoryFlushMock: vi.fn(async () => undefined),
  persistSessionEntryMock: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  clearSessionAuthProfileOverrideMock: vi.fn(),
  isThinkingLevelSupportedMock: vi.fn((_args: unknown) => true),
  resolveSupportedThinkingLevelMock: vi.fn(({ level }: { level?: string }) => level),
  resolveThinkingDefaultMock: vi.fn((_args: unknown) => "low"),
  loadManifestModelCatalogMock: vi.fn((): ModelCatalogSnapshot["entries"] => []),
  resolvePluginMetadataSnapshotMock: vi.fn(),
  listSkillCommandsForWorkspaceMock: vi.fn((_params: unknown) => []),
  loadProviderScopedThinkingCatalogMock: vi.fn(
    async (_params: unknown): Promise<ModelCatalogSnapshot["entries"] | undefined> => undefined,
  ),
  loadFullModelCatalogMock: vi.fn(async () => {
    throw new Error("full model catalog should not materialize");
  }),
  loadPreparedModelCatalogSnapshotMock: vi.fn(async (): Promise<ModelCatalogSnapshot> => ({
    entries: [],
    routeVariants: [],
  })),
  buildWorkspaceSkillSnapshotMock: vi.fn((..._args: unknown[]): unknown => ({
    prompt: "",
    skills: [],
    resolvedSkills: [],
    version: 0,
  })),
  prepareInternalSessionEffectsSessionMock: vi.fn(),
  applySessionEntryLifecycleMutationMock: vi.fn(),
  authProfileStoreMock: { profiles: {} } as { profiles: Record<string, unknown> },
  sessionEntryMock: undefined as SessionEntry | undefined,
  sessionStoreMock: undefined as Record<string, SessionEntry> | undefined,
  storePathMock: undefined as string | undefined,
  resolvedSessionKeyMock: undefined as string | undefined,
  trajectoryRecorderParamsMock: vi.fn(),
  enqueueExecutionIdentityContextAtAdmissionMock: vi.fn(),
}));

export { state };

vi.mock("../sessions/session-diff-baseline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions/session-diff-baseline.js")>();
  return {
    ...actual,
    ensureSessionDiffBaseline: vi.fn(
      async (params: Parameters<typeof actual.ensureSessionDiffBaseline>[0]) => params.entry,
    ),
  };
});

vi.mock("./model-runtime-choice.js", () => ({
  evaluatePublishedModelRuntimeChoice: vi.fn(),
}));

vi.mock("./model-fallback-runner.js", () => ({
  runWithModelFallback: (params: unknown) => state.runWithModelFallbackMock(params),
}));

vi.mock("../audit/execution-identity-admission.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/execution-identity-admission.js")>();
  return {
    ...actual,
    enqueueExecutionIdentityContextAtAdmission: (...args: unknown[]) =>
      state.enqueueExecutionIdentityContextAtAdmissionMock(...args),
  };
});

vi.mock("./command/attempt-execution.runtime.js", () => ({
  buildAcpResult: (...args: unknown[]) => state.buildAcpResultMock(...args),
  createAcpToolLifecycleTracker: () => ({
    active: new Map(),
    terminalToolCallIds: new Set(),
    saturated: false,
  }),
  createAcpVisibleTextAccumulator: () => state.createAcpVisibleTextAccumulatorMock(),
  emitAcpAssistantDelta: vi.fn(),
  emitAcpLifecycleEnd: (...args: unknown[]) => state.emitAcpLifecycleEndMock(...args),
  emitAcpLifecycleError: (...args: unknown[]) => state.emitAcpLifecycleErrorMock(...args),
  emitAcpLifecycleStart: (...args: unknown[]) => state.emitAcpLifecycleStartMock(...args),
  emitAcpPromptSubmitted: vi.fn(),
  emitAcpRuntimeEvent: (...args: unknown[]) => state.emitAcpRuntimeEventMock(...args),
  persistCliTurnTranscript: (...args: unknown[]) => state.persistCliTurnTranscriptMock(...args),
  persistAcpTurnTranscript: (...args: unknown[]) => state.persistAcpTurnTranscriptMock(...args),
  resolveAcpLifecycleEndFields: (...args: unknown[]) =>
    state.resolveAcpLifecycleEndFieldsMock(...args),
  persistSessionEntry: vi.fn(),
  prependInternalEventContext: (body: string) => body,
  resolveCliTranscriptReplyText: (result: { payloads?: Array<{ text?: string }> }) =>
    result.payloads
      ?.map((payload) => payload.text?.trim())
      .filter(Boolean)
      .join("\n\n") ?? "",
  runAgentAttempt: (...args: unknown[]) => state.runAgentAttemptMock(...args),
  sessionTranscriptHasContent: vi.fn(async () => false),
}));

vi.mock("./command/attempt-execution.shared.js", async () => {
  const actual = await vi.importActual<typeof import("./command/attempt-execution.shared.js")>(
    "./command/attempt-execution.shared.js",
  );
  return {
    ...actual,
    persistAgentSession: (...args: unknown[]) => state.persistSessionEntryMock(...args),
  };
});

vi.mock("../config/sessions/transcript.runtime.js", () => ({
  appendExactAssistantMessageToSessionTranscript: (...args: unknown[]) =>
    state.appendExactAssistantMessageMock(...args),
}));

vi.mock("./command/delivery.runtime.js", () => ({
  deliverAgentCommandResult: (...args: unknown[]) => state.deliverAgentCommandResultMock(...args),
}));

vi.mock("./command/cli-compaction.js", () => ({
  runCliTurnCompactionLifecycle: (...args: unknown[]) =>
    state.runCliTurnCompactionLifecycleMock(...args),
}));

vi.mock("../auto-reply/reply/agent-runner-memory.js", () => ({
  // Model-switch fixtures have no context pressure; required preflight preserves their session.
  runSessionCompactionIfNeeded: async (params: { sessionEntry?: SessionEntry }) =>
    params.sessionEntry,
  runMemoryFlushIfNeeded: (params: { sessionEntry?: SessionEntry }) =>
    state.runMemoryFlushIfNeededMock(params),
}));

vi.mock("./command/run-context.js", () => ({
  resolveAgentRunContext: (opts: {
    accountId?: string;
    channel?: string;
    groupChannel?: string | null;
    groupId?: string | null;
    groupSpace?: string | null;
    messageChannel?: string;
    replyChannel?: string;
    runContext?: {
      accountId?: string;
      currentChannelId?: string;
      currentThreadTs?: string;
      groupChannel?: string | null;
      groupId?: string | null;
      groupSpace?: string | null;
      messageChannel?: string;
      replyToMode?: "off" | "first" | "all" | "batched";
    };
    threadId?: string | number;
    to?: string;
  }) => ({
    messageChannel:
      opts.runContext?.messageChannel ?? opts.messageChannel ?? opts.replyChannel ?? opts.channel,
    accountId: opts.runContext?.accountId ?? opts.accountId ?? "acct",
    groupId: opts.runContext?.groupId ?? opts.groupId,
    groupChannel: opts.runContext?.groupChannel ?? opts.groupChannel,
    groupSpace: opts.runContext?.groupSpace ?? opts.groupSpace,
    currentChannelId: undefined,
    currentThreadTs:
      opts.runContext?.currentThreadTs ??
      (opts.threadId == null ? undefined : String(opts.threadId)),
    replyToMode: opts.runContext?.replyToMode,
    hasRepliedRef: { current: false },
  }),
}));

vi.mock("./command/session-store.runtime.js", () => ({
  loadSessionEntry: (...args: unknown[]) => state.loadSessionEntryMock(...args),
  loadSessionEntryReadOnly: (...args: unknown[]) => state.loadSessionEntryMock(...args),
  updateSessionStoreAfterAgentRun: (...args: unknown[]) =>
    state.updateSessionStoreAfterAgentRunMock(...args),
}));

vi.mock("./command/session.js", () => ({
  resolveSession: () => {
    const sessionEntry: SessionEntry = state.sessionEntryMock ?? {
      sessionId: "session-1",
      updatedAt: Date.now(),
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    const sessionKey = state.resolvedSessionKeyMock ?? "agent:main:main";
    state.sessionStoreMock ??= { [sessionKey]: sessionEntry };
    return {
      sessionId: "session-1",
      sessionKey,
      sessionEntry,
      sessionStore: state.sessionStoreMock,
      storePath: state.storePathMock ?? "/tmp/openclaw-sessions.json",
      isNewSession: false,
      persistedThinking:
        typeof sessionEntry.thinkingLevel === "string" ? sessionEntry.thinkingLevel : undefined,
      persistedVerbose: undefined,
    };
  },
}));

vi.mock("./command/types.js", () => ({}));

// Claim ownership has dedicated store-backed coverage. Keep real recovery commits
// so command teardown can be tested against the canonical session writer queue.
vi.mock("./main-session-recovery/main-session-recovery-store.js", () => ({
  commitMainSessionRecovery: async (
    ...args: Parameters<
      typeof import("./main-session-recovery/main-session-recovery-store.js").commitMainSessionRecovery
    >
  ) => {
    const actual = await vi.importActual<
      typeof import("./main-session-recovery/main-session-recovery-store.js")
    >("./main-session-recovery/main-session-recovery-store.js");
    return actual.commitMainSessionRecovery(...args);
  },
  claimMainSessionRecoveryOwner: vi.fn(async () => ({ kind: "not_required" })),
  inspectMainSessionRecoveryRequired: vi.fn(async () => ({ kind: "not_required" })),
  releaseMainSessionRecoveryOwner: vi.fn(async () => undefined),
  validateMainSessionRecoveryOwner: vi.fn(async () => true),
}));

vi.mock("./harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));

vi.mock("./runtime-plugins.js", async () => {
  const { getActivePluginRegistry } = await import("../plugins/runtime.js");
  return createTestRuntimePlugins(() => {
    const registry = getActivePluginRegistry();
    if (!registry) {
      throw new Error("Command fixture registry is not registered");
    }
    return registry;
  });
});

// Harness selection has dedicated coverage; this command suite registers no auto harnesses.
vi.mock("./harness/support.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./harness/support.js")>()),
  resolveAutoAgentHarnessId: () => undefined,
}));

vi.mock("../acp/policy.js", () => ({
  isAcpEnabledByPolicy: () => true,
  resolveAcpAgentPolicyError: (...args: unknown[]) => state.resolveAcpAgentPolicyErrorMock(...args),
  resolveAcpDispatchPolicyError: (...args: unknown[]) =>
    state.resolveAcpDispatchPolicyErrorMock(...args),
  resolveAcpExplicitTurnPolicyError: (...args: unknown[]) =>
    state.resolveAcpExplicitTurnPolicyErrorMock(...args),
}));

vi.mock("../acp/runtime/errors.js", () => ({
  toAcpRuntimeError: ({ error }: { error: unknown }) => toStringifiedError(error),
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => state.gatewayCallMock(...args),
}));

vi.mock("@openclaw/acp-core/runtime/session-identifiers", () => ({
  resolveAcpSessionCwd: () => "/tmp",
}));

vi.mock("../auto-reply/thinking.js", () => createTestThinkingPolicy(state));

vi.mock("../cli/command-format.js", () => ({
  formatCliCommand: (cmd: string) => cmd,
}));

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: async (params: { config: unknown }) => ({
    resolvedConfig: params.config,
    diagnostics: [],
  }),
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getAgentRuntimeCommandSecretTargetIds: () => [],
}));

vi.mock("../cli/deps.js", () => ({
  createDefaultDeps: () => ({}),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => state.runtimeConfigMock ?? state.defaultRuntimeConfig,
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: { valid: false },
  }),
}));

vi.mock("./agent-runtime-config.js", () => {
  return {
    resolveAgentRuntimeConfig: async () => state.runtimeConfigMock ?? state.defaultRuntimeConfig,
  };
});

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => {
  const { rebasePluginMetadataSnapshotManifestRegistry } =
    await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>();
  return {
    isPluginMetadataSnapshotCompatible: () => false,
    rebasePluginMetadataSnapshotManifestRegistry,
    resolvePluginMetadataSnapshot: (...args: unknown[]) =>
      state.resolvePluginMetadataSnapshotMock(...args),
  };
});

vi.mock("../skills/discovery/chat-commands.runtime.js", () => ({
  expandExplicitSkillReferences: ({ text }: { text: string }) => ({ body: text, skills: [] }),
  hasSkillReferenceCandidate: () => true,
  listSkillCommandsForWorkspace: (params: unknown) =>
    state.listSkillCommandsForWorkspaceMock(params),
  resolveEffectiveAgentSkillFilter: () => undefined,
}));

vi.mock("../config/runtime-snapshot.js", async () => {
  const { hashRuntimeConfigValue } = await vi.importActual<
    typeof import("../config/runtime-snapshot.js")
  >("../config/runtime-snapshot.js");
  return {
    hashRuntimeConfigValue,
    getRuntimeConfigSnapshot: () => state.runtimeConfigMock ?? state.defaultRuntimeConfig,
    // No source snapshot: runtime-source projection no-ops and resolvers read the
    // provided config directly, matching this suite's pre-projection world.
    getRuntimeConfigSourceSnapshot: () => null,
    registerRuntimeConfigSnapshotPreparer: vi.fn(),
    setRuntimeConfigSnapshot: vi.fn(),
  };
});

vi.mock("../config/sessions.js", () => ({
  resolveAgentIdFromSessionKey: () => "default",
  mergeSessionEntry: (a: unknown, b: unknown) => ({ ...(a as object), ...(b as object) }),
  updateSessionStore: vi.fn(
    async (_path: string, fn: (store: Record<string, unknown>) => unknown) => {
      const store: Record<string, unknown> = {};
      return fn(store);
    },
  ),
}));

vi.mock("./internal-session-effects.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./internal-session-effects.js")>()),
  prepareInternalSessionEffectsSession: (...args: unknown[]) =>
    state.prepareInternalSessionEffectsSessionMock(...args),
}));

vi.mock("../infra/agent-events.js", async () => {
  const { emitAgentEventForRunContext } = await vi.importActual<
    typeof import("../infra/agent-events.js")
  >("../infra/agent-events.js");
  return {
    emitAgentEventForRunContext,
    assertAgentRunLifecycleGenerationCurrent: (...args: unknown[]) =>
      state.assertLifecycleCurrentMock(...args),
    captureAgentRunLifecycleGeneration: () => "test-generation",
    emitAgentEvent: (...args: unknown[]) => state.emitAgentEventMock(...args),
    getAgentEventLifecycleGeneration: () => "test-generation",
    isAgentEventLifecycleGenerationCurrent: (generation: string) =>
      generation === "test-generation",
    onAgentEvent: vi.fn(),
    registerAgentEventLifecycleRotationHandler: vi.fn(),
    withAgentRunLifecycleGeneration: (_generation: string, run: () => unknown) => run(),
  };
});
vi.mock("../infra/agent-run-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/agent-run-registry.js")>();
  return {
    ...actual,
    clearAgentRunContext: (...args: unknown[]) => state.clearAgentRunContextMock(...args),
    registerAgentRunContext: (...args: unknown[]) => state.registerAgentRunContextMock(...args),
  };
});

vi.mock("../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: () => ({}),
}));

vi.mock("../infra/outbound/agent-delivery.js", () => ({
  resolveAgentDeliveryPlan: (...args: unknown[]) => state.resolveAgentDeliveryPlanMock(...args),
  resolveAgentDeliveryPlanWithSessionRoute: (...args: unknown[]) =>
    state.resolveAgentDeliveryPlanWithSessionRouteMock(...args),
  resolveAgentOutboundTarget: (...args: unknown[]) => state.resolveAgentOutboundTargetMock(...args),
}));

vi.mock("../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: (...args: unknown[]) =>
    state.resolveMessageChannelSelectionMock(...args),
}));

vi.mock("../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: () => ({ eligible: false }),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      raw: vi.fn(),
      child: vi.fn(() => logger),
    };
    return logger;
  },
}));
vi.mock("../channels/model-overrides.js", () => ({
  resolveChannelModelOverride: (params: unknown) => state.resolveChannelModelOverrideMock(params),
}));

vi.mock("../routing/session-key.js", async () => {
  const actual = await vi.importActual<typeof import("../routing/session-key.js")>(
    "../routing/session-key.js",
  );
  return {
    ...actual,
    normalizeAgentId: vi.fn((id: string) => id),
    normalizeMainKey: (key?: string | null) => key?.trim() || "main",
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
    log: vi.fn(),
  },
}));

vi.mock("../sessions/level-overrides.js", () => ({
  applyVerboseOverride: vi.fn(),
}));

vi.mock("../sessions/model-overrides.js", () => ({
  isModelSelectionLocked: (entry: unknown) => state.isModelSelectionLockedMock(entry),
  MODEL_SELECTION_LOCKED_MESSAGE: "Model selection is locked for this session.",
  ModelSelectionLockedError: class ModelSelectionLockedError extends Error {
    constructor() {
      super("Model selection is locked for this session.");
      this.name = "ModelSelectionLockedError";
    }
  },
}));

vi.mock("../sessions/send-policy.js", () => ({
  resolveSendPolicyCore: () => "allow",
}));

vi.mock("../terminal/ansi.js", () => ({
  sanitizeForLog: (s: string) => s,
}));

vi.mock("../trajectory/runtime.js", () => ({
  createTrajectoryRuntimeRecorder: (params: unknown) => {
    state.createTrajectoryRuntimeRecorderMock(params);
    state.trajectoryRecorderParamsMock(params);
    return {
      enabled: true,
      filePath: "/tmp/session.trajectory.jsonl",
      recordEvent: (...args: unknown[]) => state.trajectoryRecordEventMock(...args),
      flush: () => state.trajectoryFlushMock(),
    };
  },
}));

vi.mock("../utils/message-channel.js", () => ({
  INTERNAL_MESSAGE_CHANNEL: "internal",
  isDeliverableMessageChannel: (value: string) => value !== "internal",
  normalizeMessageChannel: (value?: string | null) => value?.trim().toLowerCase() || undefined,
  resolveMessageChannel: (...values: Array<string | null | undefined>) =>
    values
      .find((value) => value?.trim())
      ?.trim()
      .toLowerCase(),
}));

vi.mock("./agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-scope.js")>()),
  resolveAgentDir: () => "/tmp/agent",
  resolveDefaultAgentId: () => "default",
  resolveSessionAgentIds: () => ({ defaultAgentId: "default", sessionAgentId: "default" }),
  resolveSessionAgentId: () => "default",
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
}));

vi.mock("./auth-profiles.js", async () => {
  const actual = await vi.importActual<typeof import("./auth-profiles.js")>("./auth-profiles.js");
  return {
    ...actual,
    ensureAuthProfileStore: () => ({ profiles: {} }),
  };
});

vi.mock("./auth-profiles/store-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./auth-profiles/store-runtime.js")>(
    "./auth-profiles/store-runtime.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore: vi.fn(() => state.authProfileStoreMock),
  };
});

vi.mock("./auth-profiles/store.js", async (importOriginal) => ({
  // Native loader bootstrap still needs the real auth-store factory exports.
  ...(await importOriginal<typeof import("./auth-profiles/store.js")>()),
  getRuntimeAuthProfileStoreSnapshot: () => state.authProfileStoreMock,
  findPersistedAuthProfileCredential: ({ profileId }: { profileId: string }) =>
    state.authProfileStoreMock.profiles[profileId],
}));

vi.mock("./auth-profiles/session-override.js", () => ({
  clearSessionAuthProfileOverride: (...args: unknown[]) =>
    state.clearSessionAuthProfileOverrideMock(...args),
}));

vi.mock("./defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 200_000,
  DEFAULT_MODEL: "claude",
  DEFAULT_PROVIDER: "anthropic",
}));

// Exec eligibility is outside model-switch scope; avoid loading its policy graph.
vi.mock("./exec-defaults.js", () => ({
  resolveNodeExecEligibility: () => ({ canExec: false }),
}));

vi.mock("./lanes.js", () => ({
  AGENT_LANE_SUBAGENT: "subagent",
}));

vi.mock("./model-catalog.js", () => ({
  loadManifestModelCatalog: state.loadManifestModelCatalogMock,
}));

vi.mock("./model-catalog.runtime.js", () => ({
  // The scoped thinking catalog hydrates from the same runtime snapshot the test controls.
  loadProviderScopedThinkingCatalog: async (params: unknown) => {
    const scoped = await state.loadProviderScopedThinkingCatalogMock(params);
    if (scoped !== undefined) {
      return scoped;
    }
    return (await state.loadPreparedModelCatalogSnapshotMock()).entries;
  },
  loadPreparedModelCatalogSnapshot: state.loadPreparedModelCatalogSnapshotMock,
}));

vi.mock("./model-selection.js", async () => {
  const { createTestModelSelection } =
    await import("./agent-command.model-selection.test-support.js");
  return createTestModelSelection(state);
});

vi.mock("./model-visibility-policy.js", async (importOriginal) => {
  const { RUNTIME_MODEL_VISIBILITY_NORMALIZATION } =
    await importOriginal<typeof import("./model-visibility-policy.js")>();
  return {
    RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    createModelVisibilityPolicy: (...args: Parameters<typeof createTestModelVisibilityPolicy>) =>
      createTestModelVisibilityPolicy(...args),
  };
});

vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({}),
  resolveProviderIdForAuth: (provider: string) =>
    provider.trim().toLowerCase() === "codex-cli" ? "openai" : provider.trim().toLowerCase(),
}));

vi.mock("../skills/discovery/agent-filter.js", () => ({
  resolveEffectiveAgentSkillFilter: (_cfg: unknown, agentId: string) =>
    state.resolveAgentSkillsFilterMock(_cfg, agentId),
}));

vi.mock("../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: () => ({ eligible: false }),
}));

vi.mock("../skills/runtime/session-snapshot.js", () => ({
  resolveReusableWorkspaceSkillSnapshot: (params: {
    workspaceDir: string;
    existingSnapshot?: { resolvedSkills?: unknown };
    skillFilter?: string[];
  }) => {
    if (params.skillFilter !== undefined && params.skillFilter.length === 0) {
      return {
        snapshot: {
          prompt: "",
          skills: [],
          resolvedSkills: [],
          skillFilter: params.skillFilter,
          version: 0,
        },
        shouldRefresh: !params.existingSnapshot,
        snapshotVersion: 0,
      };
    }
    if (params.existingSnapshot?.resolvedSkills !== undefined) {
      return {
        snapshot: params.existingSnapshot,
        shouldRefresh: false,
        snapshotVersion: 0,
      };
    }
    const rebuilt = state.buildWorkspaceSkillSnapshotMock(params.workspaceDir, params) as {
      resolvedSkills?: unknown;
    };
    return {
      snapshot: params.existingSnapshot
        ? { ...params.existingSnapshot, resolvedSkills: rebuilt?.resolvedSkills }
        : rebuilt,
      shouldRefresh: !params.existingSnapshot,
      snapshotVersion: 0,
    };
  },
}));

vi.mock("./spawned-context.js", () => ({
  normalizeSpawnedRunMetadata: (meta: unknown) => meta ?? {},
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: ({ overrideSeconds }: { overrideSeconds?: number | null }) =>
    typeof overrideSeconds === "number" && Number.isFinite(overrideSeconds)
      ? overrideSeconds === 0
        ? 2_147_483_647
        : Math.max(overrideSeconds * 1000, 1)
      : 30_000,
}));

vi.mock("./workspace.js", () => ({
  ensureAgentWorkspace: async () => ({ dir: "/tmp/workspace" }),
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManagerCore: () => ({
    resolveSession: (params: Parameters<ResolveManagerSession>[0]) =>
      state.acpResolveSessionMock(params),
    runTurn: (...args: unknown[]) => state.acpRunTurnMock(...args),
  }),
}));
