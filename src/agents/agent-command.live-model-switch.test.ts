import fs from "node:fs/promises";
/** Tests live model switching behavior in active agent command sessions. */
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ResolveManagerSession } from "../acp/control-plane/manager.types.js";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { SessionEntry } from "../config/sessions.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { projectPublicSessionEntry } from "../config/sessions/session-entry-projection.js";
import { mergeSessionSnapshotChanges } from "../config/sessions/session-snapshot-merge.js";
import { withInstallationTarget } from "../infra/installation-target-context.js";
import { commitSessionExecutionSelection } from "../model-picker/apply-session-model-selection.js";
import {
  isModelExecutionSelection,
  type AcpExecutionSelection,
  type ModelExecutionSelection,
} from "../model-picker/execution-selection.js";
import type * as ModelSessionRuntime from "../plugin-sdk/model-session-runtime.js";
import {
  getSessionEntry as getSdkSessionEntry,
  patchSessionEntry as patchSdkSessionEntry,
  upsertSessionEntry as upsertSdkSessionEntry,
} from "../plugin-sdk/session-store-runtime.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  getActivePluginRegistry,
  getActivePluginRegistryVersion,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  createUserTurnTranscriptRecorder,
  type UserTurnTranscriptRecorder,
} from "../sessions/user-turn-transcript.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acceptedModelSelection } from "../test-utils/session-execution-selection.js";
import {
  deliveryContextFromSession,
  normalizeSessionDeliveryState,
} from "../utils/delivery-context.shared.js";
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "./admitted-run-context.js";
import {
  type CommandSessionEntryFixture,
  createChannelModelRuntimeConfig,
  createCommandSessionEntry,
  createCommandSessionFixture,
  createConfiguredModelCompatRuntimeConfig,
  makeSuccessResult,
} from "./agent-command.live-model-switch.test-helpers.js";
import { registerAgentCommandRecoveryCases } from "./agent-command.restart-recovery.test-harness.js";
import { createApiKeyCredential } from "./auth-profiles/credential-fixtures.test-support.js";
import type { FailoverReason } from "./failover/signal.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "./internal-events.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "./internal-runtime-context.js";
import { resolveInternalSessionEffectsTarget } from "./internal-session-effects.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import type { ModelFallbackRunOptions } from "./model-fallback-attempt.js";
import { evaluatePublishedModelRuntimeChoice } from "./model-runtime-choice.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
} from "./run-termination.js";

// Register the shared module mocks before importing any runtime dependency.
const { state } = await vi.hoisted(
  async () => await import("./agent-command.live-model-switch.test-mocks.js"),
);
let manifestMetadataSnapshot: ReturnType<typeof createPluginMetadataSnapshotFixture>;

afterAll(() => {
  // This suite runs in a shared worker; do not leak its module-level logger
  // mock into later files that verify real warning diagnostics.
  vi.doUnmock("../logging/subsystem.js");
});

let agentCommand: typeof import("./agent-command.js").agentCommand;
let agentCommandFromSystem: typeof import("./agent-command.js").agentCommandFromSystem;
let prepareAgentCommandExecution: typeof import("./command/prepare.js").prepareAgentCommandExecution;

beforeAll(async () => {
  const mod = await import("./agent-command.js");
  agentCommand ??= mod.agentCommand;
  agentCommandFromSystem ??= mod.agentCommandFromSystem;
  ({ prepareAgentCommandExecution } = await import("./command/prepare.js"));
});

type FallbackRunnerParams = {
  prepareCandidateChain?: Parameters<
    typeof import("./model-fallback-runner.js").runWithModelFallback
  >[0]["prepareCandidateChain"];
  prepareCandidate?: (provider: string, model: string) => Promise<void>;
  provider: string;
  model: string;
  sessionId?: string;
  fallbacksOverride?: string[];
  run: (provider: string, model: string, options: ModelFallbackRunOptions) => Promise<unknown>;
  onFallbackStep?: (step: Record<string, unknown>) => void | Promise<void>;
  classifyResult?: (params: {
    provider: string;
    model: string;
    result: unknown;
    attempt: number;
    total: number;
  }) => unknown;
};

async function runInitialFallbackAttempt(
  params: FallbackRunnerParams,
  provider = params.provider,
  model = params.model,
) {
  await params.prepareCandidateChain?.([
    { provider, model, routeOrigin: "requested", routeResolution: "resolved" },
  ]);
  await params.prepareCandidate?.(provider, model);
  return params.run(provider, model, {
    modelRoutingProvenance: {
      requestedProvider: params.provider,
      requestedModel: params.model,
      stage: "initial",
    },
  });
}

async function runSubsequentFallbackAttempt(
  params: FallbackRunnerParams,
  provider: string,
  model: string,
  fallbackReason: FailoverReason,
) {
  await params.prepareCandidateChain?.([
    { provider, model, routeOrigin: "configured-fallback", routeResolution: "resolved" },
  ]);
  await params.prepareCandidate?.(provider, model);
  return params.run(provider, model, {
    modelRoutingProvenance: {
      requestedProvider: params.provider,
      requestedModel: params.model,
      stage: "fallback",
      fallbackReason,
    },
  });
}

type ModelSwitchOptions = {
  provider: string;
  model: string;
  agentRuntimeOverride?: string;
  cause?: "user" | "reset";
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};

function makeEmptyResult(provider: string, model: string) {
  return {
    payloads: [],
    meta: {
      durationMs: 30_000,
      aborted: false,
      stopReason: "end_turn",
      agentHarnessResultClassification: "empty",
      agentMeta: { provider, model },
    },
  };
}

async function persistSwitchNotification(
  error: LiveSessionModelSwitchError,
  cause: "user" | "reset" = "user",
): Promise<LiveSessionModelSwitchError> {
  const sessionKey = state.resolvedSessionKeyMock ?? "agent:main:main";
  const store = expectDefined(state.sessionStoreMock, "command session store");
  const current = expectDefined(store[sessionKey], "current command session");
  if (current.modelSelectionLocked) {
    return error;
  }
  const next = { ...current };
  commitSessionExecutionSelection(next, error.selection, { cause: { kind: cause } });
  next.authProfileOverride = error.authProfileId;
  next.authProfileOverrideSource = error.authProfileId ? error.authProfileIdSource : undefined;
  next.authProfileOverrideCompactionCount = undefined;
  await state.persistSessionEntryMock({
    sessionStore: store,
    sessionKey,
    storePath: state.storePathMock ?? "/tmp/openclaw-sessions.json",
    initialEntry: current,
    entry: next,
  });
  return error;
}

function setupModelSwitchRetry(switchOptions: ModelSwitchOptions) {
  let invocation = 0;
  state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
    invocation += 1;
    if (invocation === 1) {
      throw await persistSwitchNotification(
        new LiveSessionModelSwitchError({
          selection: {
            model: { provider: switchOptions.provider, id: switchOptions.model },
            executor: { kind: "harness", id: switchOptions.agentRuntimeOverride ?? "openclaw" },
          },
          authProfileId: switchOptions.authProfileId,
          authProfileIdSource: switchOptions.authProfileIdSource,
        }),
        switchOptions.cause,
      );
    }
    const result = await runInitialFallbackAttempt(params);
    return {
      result,
      provider: params.provider,
      model: params.model,
      attempts: [],
    };
  });
}

function setupSingleAttemptFallback() {
  state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
    const result = await runInitialFallbackAttempt(params);
    return {
      result,
      provider: params.provider,
      model: params.model,
      attempts: [],
    };
  });
}

function setupSuccessfulAttempt(provider = "openai", model = "gpt-5.4"): void {
  setupSingleAttemptFallback();
  state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult(provider, model));
}

function setupAdmittedSuccessfulAttempt(provider = "openai", model = "gpt-5.4"): void {
  setupSingleAttemptFallback();
  state.runAgentAttemptMock.mockImplementation(
    async (params: { preparedRunAdmission: { admit: (kind: "embedded") => Promise<unknown> } }) => {
      await params.preparedRunAdmission.admit("embedded");
      return makeSuccessResult(provider, model);
    },
  );
}

function setupAcpSession(): void {
  const selection: AcpExecutionSelection = {
    executor: { kind: "acp", backend: "fixture-backend", agent: "fixture-agent" },
    model: "native-managed",
  };
  const entry = createCommandSessionEntry({
    lifecycleRevision: "command-acp-generation",
    executionSelection: { state: "accepted", selection, fallbackPermission: "configured" },
  });
  state.sessionEntryMock = entry;
  state.acpResolveSessionMock.mockImplementation(
    ({
      sessionKey,
      agentId,
    }: Parameters<ResolveManagerSession>[0]): ReturnType<ResolveManagerSession> => ({
      kind: "ready",
      sessionKey,
      agentId,
      entry,
      selection,
      meta: {
        runtimeSessionName: "command-acp-runtime",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 1,
        cwd: "/tmp/workspace",
      },
    }),
  );
}

const requireRecord = createRequireRecord("object", "expected-label-object");

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} to be an array`);
  }
  return value;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function expectRecordFields(value: unknown, expected: Record<string, unknown>): void {
  const actual = requireRecord(value, "record");
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(actual[key]).toEqual(expectedValue);
  }
}

function findPersistedTranscriptRepair() {
  return state.persistSessionEntryMock.mock.calls
    .map(([params]) => (params as { entry?: SessionEntry }).entry?.pendingTranscriptRepair)
    .find((repair) => repair?.length);
}

async function runBasicAgentCommand() {
  await agentCommand({
    message: "hello",
    to: "+1234567890",
  });
}

async function runSystemAgentCommand() {
  await agentCommandFromSystem(
    {
      message: "boot",
      sessionKey: "agent:main:boot",
      deliver: false,
    },
    { boundary: "gateway.boot" },
  );
}

function runDiscordDelivery(overrides: Partial<Parameters<typeof agentCommand>[0]> = {}) {
  return agentCommand({
    message: "hello",
    channel: "discord",
    to: "discord:dm:123",
    accountId: "main",
    deliver: true,
    ...overrides,
  });
}

function runInternalModelCommand(runId: string) {
  return agentCommand({
    message: "probe",
    to: "+1234567890",
    runId,
    modelRun: true,
    promptMode: "none",
    sessionEffects: "internal",
  });
}

function setupStoredSession(
  overrides: CommandSessionEntryFixture = {},
  storePath = "/tmp/openclaw-sessions.json",
  sessionKey = "agent:main:main",
): { entry: SessionEntry; store: Record<string, SessionEntry> } {
  const fixture = createCommandSessionFixture(overrides, sessionKey);
  state.sessionEntryMock = fixture.entry;
  state.sessionStoreMock = fixture.store;
  state.storePathMock = storePath;
  return fixture;
}

function setupBareStoredSession(
  overrides: CommandSessionEntryFixture = {},
  storePath = "/tmp/openclaw-sessions.json",
  sessionKey = "agent:main:main",
): { entry: SessionEntry; store: Record<string, SessionEntry> } {
  const entry = createCommandSessionEntry(overrides);
  const store = { [sessionKey]: entry };
  state.sessionEntryMock = entry;
  state.sessionStoreMock = store;
  state.storePathMock = storePath;
  return { entry, store };
}

function getAgentCommandRecoveryFixture() {
  return {
    state,
    agentCommand,
    setupSingleAttemptFallback,
    setupBareStoredSession,
    makeSuccessResult,
  };
}

describe("agentCommand – LiveSessionModelSwitchError retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.runAgentAttemptMock.mockReset();
    state.runWithModelFallbackMock.mockReset();
    const readSessionEntryReadOnly = sessionAccessor.loadSessionEntryReadOnly;
    const previousRegistry = captureActivePluginRegistrySnapshot();
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: "codex",
      source: "test",
      harness: {
        id: "codex",
        label: "Fixture app",
        autoSelection: { providerIds: [] },
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("Command attempt fixture owns execution");
        },
      },
    });
    setActivePluginRegistry(registry);
    const generation = { current: true };
    onTestFinished(() => {
      generation.current = false;
      restoreActivePluginRegistrySnapshot(previousRegistry);
    });
    vi.mocked(evaluatePublishedModelRuntimeChoice).mockImplementation(
      async ({ provider, model, runtimeId }) => {
        if (
          runtimeId !== "openclaw" &&
          !registry.agentHarnesses.some(({ harness }) => harness.id === runtimeId) &&
          !registry.cliBackends.some(
            ({ backend }) => backend.id === runtimeId && backend.modelProvider === provider,
          )
        ) {
          return { kind: "unknown", message: "The fixture executor is not registered." };
        }
        const registryVersion = getActivePluginRegistryVersion();
        return {
          kind: "ready",
          entry: { provider, id: model, name: model },
          validate: () =>
            generation.current && registryVersion === getActivePluginRegistryVersion()
              ? undefined
              : "The fixture catalog is no longer current.",
        };
      },
    );

    state.acpResolveSessionMock.mockReturnValue(null);
    state.resolveAcpAgentPolicyErrorMock.mockReturnValue(null);
    state.resolveAcpDispatchPolicyErrorMock.mockReturnValue(null);
    state.resolveAcpExplicitTurnPolicyErrorMock.mockReturnValue(null);
    state.runtimeConfigMock = undefined;
    delete (state.defaultRuntimeConfig.agents as { list?: unknown }).list;
    state.isThinkingLevelSupportedMock.mockReturnValue(true);
    state.resolveSupportedThinkingLevelMock.mockImplementation(
      ({ level }: { level?: string }) => level,
    );
    state.resolveThinkingDefaultMock.mockReturnValue("low");
    state.resolveAgentSkillsFilterMock.mockReturnValue(undefined);
    state.loadManifestModelCatalogMock.mockReturnValue([]);
    manifestMetadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: registry.agentHarnesses.map(({ pluginId, harness }) => ({
        id: pluginId,
        activation: { onAgentHarnesses: [harness.id] },
      })),
    });
    state.resolvePluginMetadataSnapshotMock.mockReturnValue(manifestMetadataSnapshot);
    state.loadProviderScopedThinkingCatalogMock.mockReset().mockResolvedValue(undefined);
    state.loadFullModelCatalogMock.mockClear();
    state.loadPreparedModelCatalogSnapshotMock.mockResolvedValue({
      entries: [],
      routeVariants: [],
    });
    state.isModelSelectionLockedMock.mockImplementation(
      (entry: unknown) =>
        (entry as { modelSelectionLocked?: boolean } | undefined)?.modelSelectionLocked === true,
    );
    state.resolveChannelModelOverrideMock.mockImplementation((params: unknown) => {
      const input = params as {
        cfg?: { channels?: { modelByChannel?: Record<string, Record<string, string>> } };
        channel?: string;
        groupId?: string;
        parentSessionKey?: string;
      };
      const channel = input.channel?.trim().toLowerCase();
      const entries = channel ? input.cfg?.channels?.modelByChannel?.[channel] : undefined;
      if (!entries) {
        return null;
      }
      const direct = input.groupId ? entries[input.groupId] : undefined;
      if (direct) {
        return { channel, model: direct, matchKey: input.groupId };
      }
      const parentChannel = input.parentSessionKey?.match(/:channel:([^:]+)/u)?.[1];
      const parent = parentChannel ? entries[parentChannel] : undefined;
      return parent ? { channel, model: parent, matchKey: parentChannel } : null;
    });
    state.acpRunTurnMock.mockImplementation(async (params: unknown) => {
      const onEvent = (params as { onEvent?: (event: unknown) => void }).onEvent;
      onEvent?.({ type: "text_delta", stream: "output", text: "done" });
      onEvent?.({ type: "done", stopReason: "end_turn" });
    });
    state.createAcpVisibleTextAccumulatorMock.mockImplementation(() => {
      let text = "";
      return {
        consume(chunk: string) {
          text += chunk;
          return { text, delta: chunk };
        },
        finalizeRaw: () => text,
        finalize: () => text,
        finalizeReplySnapshot: () => ({ disposition: "visible" as const, text }),
      };
    });
    state.buildAcpResultMock.mockImplementation((params: { payloadText?: string }) => ({
      payloads: params.payloadText ? [{ text: params.payloadText }] : [],
      meta: { durationMs: 0, stopReason: "end_turn" },
    }));
    state.persistCliTurnTranscriptMock.mockImplementation(
      async (params: { sessionEntry?: unknown }) => ({
        kind: "persisted",
        sessionEntry: params.sessionEntry,
      }),
    );
    state.persistAcpTurnTranscriptMock.mockImplementation(
      async (params: { sessionEntry?: unknown }) => ({
        kind: "persisted",
        sessionEntry: params.sessionEntry,
      }),
    );
    state.resolveAcpLifecycleEndFieldsMock.mockReset().mockReturnValue({});
    state.appendExactAssistantMessageMock.mockReset().mockResolvedValue({
      ok: true,
      target: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: "/tmp/openclaw-sessions.json",
      },
      messageId: "repaired-message",
    });
    state.runCliTurnCompactionLifecycleMock.mockImplementation(
      async (params: { sessionEntry?: unknown }) => params.sessionEntry,
    );
    state.authProfileStoreMock = { profiles: {} };
    state.sessionEntryMock = undefined;
    state.sessionStoreMock = undefined;
    state.storePathMock = undefined;
    state.resolvedSessionKeyMock = undefined;
    state.persistSessionEntryMock.mockImplementation(async (...args: unknown[]) => {
      const params = args[0] as Parameters<
        typeof import("./command/attempt-execution.shared.js").persistAgentSession
      >[0];
      if (
        params.storePath !== "/tmp/openclaw-sessions.json" &&
        params.storePath !== "/tmp/openclaw-session-store.json"
      ) {
        const actual = await vi.importActual<
          typeof import("./command/attempt-execution.shared.js")
        >("./command/attempt-execution.shared.js");
        return actual.persistAgentSession(params);
      }
      const invalid = params.validateCommit?.();
      if (invalid) {
        throw new Error(invalid);
      }
      const stored = expectDefined(state.sessionStoreMock, "synthetic persisted session store");
      const current = stored[params.sessionKey];
      const shouldPersist = params.shouldPersist?.(current);
      if (!current && shouldPersist !== true) {
        delete params.sessionStore[params.sessionKey];
        return undefined;
      }
      if (
        current &&
        (shouldPersist === false || current.sessionId !== params.initialEntry.sessionId)
      ) {
        params.sessionStore[params.sessionKey] = current;
        return current;
      }
      const persisted = current
        ? mergeSessionSnapshotChanges({ initial: params.initialEntry, next: params.entry, current })
        : params.entry;
      stored[params.sessionKey] = persisted;
      params.sessionStore[params.sessionKey] = persisted;
      return persisted;
    });
    state.buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "",
      skills: [],
      resolvedSkills: [],
      version: 0,
    });
    state.deliverAgentCommandResultMock.mockImplementation(
      async ({
        result,
        payloads,
      }: Parameters<typeof import("./command/delivery.js").deliverAgentCommandResult>[0]) => ({
        payloads: payloads ?? [],
        meta: result.meta,
      }),
    );
    state.resolveAgentOutboundTargetMock.mockImplementation(
      (params: { plan?: { resolvedTo?: string }; targetMode?: string }) => ({
        resolvedTarget: null,
        resolvedTo: params.plan?.resolvedTo,
        targetMode: params.targetMode ?? "implicit",
      }),
    );
    state.resolveMessageChannelSelectionMock.mockRejectedValue(new Error("channel required"));
    state.loadSessionEntryMock
      .mockReset()
      .mockImplementation(
        (params: Parameters<typeof sessionAccessor.loadSessionEntryReadOnly>[0]) => {
          if (
            params.storePath &&
            params.storePath !== "/tmp/openclaw-sessions.json" &&
            params.storePath !== "/tmp/openclaw-session-store.json"
          ) {
            return readSessionEntryReadOnly(params);
          }
          const sessionKey = params.sessionKey ?? state.resolvedSessionKeyMock ?? "agent:main:main";
          return state.sessionStoreMock?.[sessionKey];
        },
      );
    state.resolveAgentDeliveryPlanMock.mockImplementation(
      (params: {
        accountId?: string;
        explicitThreadId?: string | number;
        explicitTo?: string;
        requestedChannel?: string;
        sessionEntry?: SessionEntry;
      }) => {
        const context = deliveryContextFromSession(params.sessionEntry);
        const channel = params.requestedChannel ?? context?.channel ?? "internal";
        const to = params.explicitTo ?? context?.to;
        const accountId = params.accountId ?? context?.accountId;
        const threadId = params.explicitThreadId ?? context?.threadId;
        return {
          baseDelivery: {},
          resolvedChannel: channel,
          resolvedTo: to,
          resolvedAccountId: accountId,
          resolvedThreadId: threadId,
          deliveryTargetMode: params.explicitTo ? "explicit" : to ? "implicit" : undefined,
        };
      },
    );
    state.resolveAgentDeliveryPlanWithSessionRouteMock.mockImplementation((params: unknown) =>
      state.resolveAgentDeliveryPlanMock(params),
    );
    state.updateSessionStoreAfterAgentRunMock.mockResolvedValue(undefined);
    state.trajectoryFlushMock.mockResolvedValue(undefined);
    state.prepareInternalSessionEffectsSessionMock.mockResolvedValue({
      agentId: "default",
      sessionId: "internal-session",
      sessionKey: "agent:default:internal-session-effects:run",
      storePath: "/tmp/openclaw-session-store.json",
      sessionFile: "sqlite:default:internal-session:/tmp/openclaw-session-store.json",
      sessionEntry: { sessionId: "internal-session", updatedAt: 1 },
    });
    state.applySessionEntryLifecycleMutationMock.mockReset().mockResolvedValue(undefined);
    // Keep tracking and deletion planning real; restore the storage fault boundary after each case.
    vi.spyOn(sessionAccessor, "applySessionEntryLifecycleMutation").mockImplementation((...args) =>
      state.applySessionEntryLifecycleMutationMock(...args),
    );
  });

  afterEach(async () => {
    await resetPreparedModelRuntimeSnapshotsForTest();
    vi.restoreAllMocks();
  });

  it("uses Gateway command metadata without resolving the agent workspace", async () => {
    const pluginGeneration = {
      pluginMetadataSnapshot: manifestMetadataSnapshot,
    } as never;

    const prepared = await prepareAgentCommandExecution(
      { message: "/demo", to: "+1234567890" },
      {} as never,
      { config: {}, pluginGeneration },
    );

    expect(prepared.manifestMetadataSnapshot).toBe(manifestMetadataSnapshot);
    expect(prepared.commandRuntimeContext?.pluginGeneration).toBe(pluginGeneration);
    expect(state.listSkillCommandsForWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ pluginMetadataSnapshot: manifestMetadataSnapshot }),
    );
    expect(state.resolvePluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it.each(["user", "reset"] as const)(
    "retries the committed %s selection when notified",
    async (cause) => {
      setupModelSwitchRetry({
        provider: "openai",
        model: "gpt-5.4",
        cause,
      });

      state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

      await runBasicAgentCommand();

      expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(2);

      const secondCall = mockCallArg(state.runWithModelFallbackMock, 1) as FallbackRunnerParams;
      expect(secondCall.provider).toBe("openai");
      expect(secondCall.model).toBe("gpt-5.4");
      expect(secondCall.sessionId).toBe("session-1");
      expect(
        state.sessionStoreMock?.["agent:main:main"]?.executionSelection?.fallbackPermission,
      ).toBe(cause === "reset" ? "configured" : "explicit");

      const lifecycleEndCalls = state.emitAgentEventMock.mock.calls.filter((call: unknown[]) => {
        const arg = call[0] as { stream?: string; data?: { phase?: string } };
        return arg?.stream === "lifecycle" && arg?.data?.phase === "end";
      });
      expect(lifecycleEndCalls.length).toBeGreaterThanOrEqual(1);
      const lifecycleFinishingCalls = state.emitAgentEventMock.mock.calls.filter(
        (call: unknown[]) => {
          const arg = call[0] as { stream?: string; data?: { phase?: string } };
          return arg?.stream === "lifecycle" && arg?.data?.phase === "finishing";
        },
      );
      expect(lifecycleFinishingCalls.length).toBeGreaterThanOrEqual(1);
      expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
        deferTerminalLifecycle: true,
      });
      const firstFinishingIndex = state.emitAgentEventMock.mock.calls.findIndex(
        (call: unknown[]) => {
          const arg = call[0] as { stream?: string; data?: { phase?: string } };
          return arg?.stream === "lifecycle" && arg?.data?.phase === "finishing";
        },
      );
      const lastEndIndex = state.emitAgentEventMock.mock.calls.findLastIndex((call: unknown[]) => {
        const arg = call[0] as { stream?: string; data?: { phase?: string } };
        return arg?.stream === "lifecycle" && arg?.data?.phase === "end";
      });
      expect(state.deliverAgentCommandResultMock).toHaveBeenCalledTimes(1);
      const deliveryOrder = state.deliverAgentCommandResultMock.mock.invocationCallOrder[0] ?? 0;
      expect(
        state.emitAgentEventMock.mock.invocationCallOrder[firstFinishingIndex] ?? 0,
      ).toBeLessThan(deliveryOrder);
      expect(deliveryOrder).toBeLessThan(
        state.emitAgentEventMock.mock.invocationCallOrder[lastEndIndex] ?? 0,
      );
    },
  );

  it("settles the deferred attempt when a live-switch reread fails", async () => {
    const sessionKey = "agent:main:main";
    const storePath = "/tmp/openclaw-sessions.json";
    setupStoredSession({ lifecycleRevision: "retry-read-lifecycle" });
    const selection: ModelExecutionSelection = {
      executor: { kind: "harness", id: "openclaw" },
      model: { provider: "openai", id: "gpt-5.4" },
    };
    state.authProfileStoreMock = {
      profiles: { "retry-account": createApiKeyCredential("openai", "synthetic-credential") },
    };
    const failure = new Error("The session store read failed.");
    const complete = vi.fn(async () => {});
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockImplementationOnce(
      async (
        params: Parameters<typeof import("./command/attempt-execution.js").runAgentAttempt>[0],
      ) => {
        await params.preparedRunAdmission.admit("embedded");
        expectDefined(params.deferredLifecycle, "deferred attempt manager").adopt({
          complete,
          discard: vi.fn(),
          beginRetryWait: () => undefined,
        });
        const notification = await persistSwitchNotification(
          new LiveSessionModelSwitchError({
            selection,
            authProfileId: "retry-account",
            authProfileIdSource: "user",
          }),
          "reset",
        );
        state.loadSessionEntryMock.mockImplementationOnce(() => {
          throw failure;
        });
        throw notification;
      },
    );

    await expect(runBasicAgentCommand()).rejects.toBe(failure);

    expect(state.runAgentAttemptMock).toHaveBeenCalledOnce();
    expect(state.runWithModelFallbackMock).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(state.trajectoryFlushMock).toHaveBeenCalledOnce();
    expect(state.emitAgentEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({ phase: "error", executionSettled: true }),
      }),
    );
    expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
    expect(state.loadSessionEntryMock({ sessionKey, storePath })).toMatchObject({
      sessionId: "session-1",
      lifecycleRevision: "retry-read-lifecycle",
      executionSelection: { state: "accepted", selection, fallbackPermission: "configured" },
      authProfileOverride: "retry-account",
      authProfileOverrideSource: "user",
    });
  });

  it("keeps a person-linked account pinned across a saved-selection retry", async () => {
    const sessionKey = "agent:main:main";
    const storePath = "/tmp/openclaw-sessions.json";
    const { store } = setupStoredSession({ lifecycleRevision: "linked-account-lifecycle" });
    const selection: ModelExecutionSelection = {
      executor: { kind: "harness", id: "openclaw" },
      model: { provider: "openai", id: "gpt-5.4" },
    };
    state.authProfileStoreMock = {
      profiles: { "linked-account": createApiKeyCredential("openai", "synthetic-credential") },
    };
    setupSingleAttemptFallback();
    state.runAgentAttemptMock
      .mockImplementationOnce(
        async (
          params: Parameters<typeof import("./command/attempt-execution.js").runAgentAttempt>[0],
        ) => {
          await params.preparedRunAdmission.admit("embedded");
          const current = expectDefined(store[sessionKey], "current command session");
          const next = { ...current };
          commitSessionExecutionSelection(next, selection, { cause: { kind: "user" } });
          next.authProfileOverride = "linked-account";
          next.authProfileOverrideSource = "user-link";
          delete next.authProfileOverrideCompactionCount;
          await state.persistSessionEntryMock({
            sessionStore: store,
            sessionKey,
            storePath,
            initialEntry: current,
            entry: next,
          });
          throw new LiveSessionModelSwitchError({
            selection,
            authProfileId: "linked-account",
            authProfileIdSource: "user",
          });
        },
      )
      .mockResolvedValueOnce(makeSuccessResult("openai", "gpt-5.4"));

    await runBasicAgentCommand();

    expect(state.runAgentAttemptMock).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(state.runWithModelFallbackMock, 1), {
      userLockedAuthProfileId: "linked-account",
    });
    expect(state.runAgentAttemptMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionEntry: expect.objectContaining({
          authProfileOverride: "linked-account",
          authProfileOverrideSource: "user-link",
        }),
      }),
    );
    expect(state.loadSessionEntryMock({ sessionKey, storePath })).toMatchObject({
      sessionId: "session-1",
      lifecycleRevision: "linked-account-lifecycle",
      executionSelection: { state: "accepted", selection, fallbackPermission: "explicit" },
      authProfileOverride: "linked-account",
      authProfileOverrideSource: "user-link",
    });
    expect(state.clearSessionAuthProfileOverrideMock).not.toHaveBeenCalled();
  });

  it("keeps collection off by default without blocking local execution", async () => {
    setupAdmittedSuccessfulAttempt();

    await runBasicAgentCommand();

    expect(state.enqueueExecutionIdentityContextAtAdmissionMock).not.toHaveBeenCalled();
    expect(state.runAgentAttemptMock).toHaveBeenCalledTimes(1);
  });

  it("records authoritative local and system ingress only after explicit opt-in", async () => {
    state.runtimeConfigMock = {
      ...state.defaultRuntimeConfig,
      logging: { audit: { executionIdentity: true } },
    };
    setupAdmittedSuccessfulAttempt();

    await runBasicAgentCommand();
    await runSystemAgentCommand();

    expect(state.enqueueExecutionIdentityContextAtAdmissionMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
      }),
      expect.objectContaining({ enabled: true }),
    );
    expect(state.enqueueExecutionIdentityContextAtAdmissionMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        ingress: { kind: "system", boundary: "gateway.boot", state: "present" },
      }),
      expect.objectContaining({ enabled: true }),
    );
  });

  it("applies the configured run cwd to ordinary (non-ACP) command sessions", async () => {
    state.runtimeConfigMock = {
      ...state.defaultRuntimeConfig,
      agents: {
        ...state.defaultRuntimeConfig.agents,
        defaults: { ...state.defaultRuntimeConfig.agents.defaults, cwd: "/tmp/task-repo" },
      },
    };
    // Ordinary sessions resolve to a truthy { kind: "none" }; only a real ACP
    // placement may keep the configured cwd away from the run.
    state.acpResolveSessionMock.mockImplementation(({ sessionKey, agentId }) => ({
      kind: "none",
      sessionKey,
      agentId,
    }));
    setupAdmittedSuccessfulAttempt();

    await runBasicAgentCommand();

    expect(state.runAgentAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/task-repo", workspaceDir: "/tmp/workspace" }),
    );
  });

  it.each([
    ["local CLI", runBasicAgentCommand],
    ["system", runSystemAgentCommand],
  ])("keeps %s runs nonblocking when evidence cannot be queued", async (_name, run) => {
    state.runtimeConfigMock = {
      ...state.defaultRuntimeConfig,
      logging: { audit: { executionIdentity: true } },
    };
    state.enqueueExecutionIdentityContextAtAdmissionMock.mockReturnValue(undefined);
    setupAdmittedSuccessfulAttempt();

    await run();

    expect(state.runAgentAttemptMock).toHaveBeenCalledTimes(1);
  });

  it.each(["completed", "failed"] as const)(
    "persists a detached recovery start before closing a %s command",
    async (outcome) => {
      const stateDir = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-command-recovery-start-")),
      );
      try {
        await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
          const sessionKey = "agent:default:main";
          const storePath = path.join(stateDir, "agents", "default", "sessions", "sessions.json");
          const runId = "recovery-run";
          const { entry } = setupStoredSession(
            {
              status: "running",
              lifecycleRunId: runId,
              restartRecoveryRuns: [{ runId, lifecycleGeneration: "test-generation" }],
              mainRestartRecovery: { cycleId: "recovery-cycle", revision: 4, chargedAttempts: 3 },
            },
            storePath,
            sessionKey,
          );
          state.resolvedSessionKeyMock = sessionKey;
          await sessionAccessor.replaceSessionEntry({ sessionKey, storePath }, entry);
          const started = createDeferred();
          const releaseWriter = createDeferred();
          let writer: Promise<void> | undefined;
          let registration: Promise<void> | undefined;
          let context: AdmittedRunContext | undefined;
          let commandSettled = false;
          const failure = new Error("runtime failed after accepting the recovery turn");
          setupSingleAttemptFallback();
          state.runAgentAttemptMock.mockImplementationOnce(
            async (params: {
              preparedRunAdmission: PreparedAgentRunAdmission;
              onAgentEvent: (event: {
                stream: string;
                data: Record<string, unknown>;
              }) => void | Promise<void>;
            }) => {
              context = await params.preparedRunAdmission.admit("embedded");
              writer = runExclusiveSqliteSessionWrite(
                resolveSqliteScope({ sessionKey, storePath }),
                async () => await releaseWriter.promise,
                "session.transcript.batch",
              );
              // Real CLI, Pi, and Codex event producers do not await this callback.
              registration = Promise.resolve(
                params.onAgentEvent({ stream: "lifecycle", data: { phase: "start" } }),
              );
              started.resolve();
              if (outcome === "failed") {
                throw failure;
              }
              return makeSuccessResult("anthropic", "claude");
            },
          );
          const command = agentCommand({
            message: "continue interrupted work",
            sessionKey,
            runId,
            mainRestartRecoveryAdmitted: true,
            mainRestartRecoveryAttempt: 3,
          }).then(
            () => {
              commandSettled = true;
              return undefined;
            },
            (error: unknown) => {
              commandSettled = true;
              return error;
            },
          );
          try {
            const first = await Promise.race([
              started.promise.then(() => ({ kind: "started" as const })),
              command.then((error) => ({ kind: "settled" as const, error })),
            ]);
            if (first.kind === "settled") {
              throw first.error instanceof Error
                ? first.error
                : new Error("The command ended before the recovery attempt started.", {
                    cause: first.error,
                  });
            }
            // Let the runner's resolved/rejected promise reach command teardown
            // while the earlier SQLite writer still holds the registration.
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            expect(commandSettled).toBe(false);
            const admitted = expectDefined(context, "recovery admission");
            expect(getAdmittedRunDelegatedAuthority(admitted)).toBeDefined();
            releaseWriter.resolve();
            expect(await command).toBe(outcome === "failed" ? failure : undefined);
            expect(sessionAccessor.loadSessionEntry({ sessionKey, storePath })).toMatchObject({
              mainRestartRecovery: { chargedAttempts: 3, startedAttempt: 3 },
            });
            expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
          } finally {
            releaseWriter.resolve();
            await writer;
            await registration;
            await command;
          }
        });
      } finally {
        await resetPreparedModelRuntimeSnapshotsForTest();
        await closeOpenClawAgentDatabasesAsync(stateDir);
        await closeOpenClawStateDatabaseByPathAsync(
          resolveOpenClawStateSqlitePath({ ...process.env, OPENCLAW_STATE_DIR: stateDir }),
        );
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("forwards the auth profile bound to the configured default model", async () => {
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude@anthropic:verified" },
          models: { "anthropic/claude": {} },
        },
      },
    };
    state.sessionEntryMock = createCommandSessionEntry({
      sessionId: "session-1",
      updatedAt: Date.now(),
      authProfileOverride: "anthropic:stale-auto",
      authProfileOverrideSource: "auto",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    });
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude"));

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      executionSelection: expect.objectContaining({
        model: expect.objectContaining({ provider: "anthropic", id: "claude" }),
      }),
      configuredAuthProfileId: "anthropic:verified",
    });
    expect(state.runWithModelFallbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ userLockedAuthProfileId: undefined }),
    );
  });

  it("retries a same-model switch with the runtime carried by the error", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      executionSelection: acceptedModelSelection("openai", "gpt-5.4"),
    };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    state.storePathMock = "/tmp/openclaw-sessions.json";
    setupModelSwitchRetry({
      provider: "openai",
      model: "gpt-5.4",
      agentRuntimeOverride: "codex",
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      executionSelection: expect.objectContaining({
        model: expect.objectContaining({ provider: "openai", id: "gpt-5.4" }),
        executor: expect.objectContaining({ id: "codex" }),
      }),
    });
  });

  it("rejects live model switches for locked sessions without retrying", async () => {
    setupModelSwitchRetry({
      provider: "openai",
      model: "gpt-5.4",
    });
    state.sessionEntryMock = createCommandSessionEntry({
      sessionId: "session-1",
      updatedAt: 1,
      modelSelectionLocked: true,
      executionSelection: acceptedModelSelection("anthropic", "claude"),
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    });
    state.isModelSelectionLockedMock.mockReturnValue(true);

    await expect(runBasicAgentCommand()).rejects.toMatchObject({
      name: "ModelSelectionLockedError",
      message: "Model selection is locked for this session.",
    });

    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
    expect(state.trajectoryFlushMock).toHaveBeenCalledTimes(1);
  });

  it("pins catalog-adopted direct runs before fallback preflight", async () => {
    setupSingleAttemptFallback();
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          models: state.defaultRuntimeConfig.agents.defaults.models,
        },
      },
    };
    state.sessionEntryMock = createCommandSessionEntry({
      sessionId: "session-1",
      updatedAt: 1,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      executionSelection: acceptedModelSelection("anthropic", "claude", {
        executor: { kind: "harness", id: "codex" },
      }),
      pluginExtensions: {
        codex: {
          supervision: {
            sourceThreadId: "019f-codex-thread",
            modelLocked: true,
          },
        },
      },
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    });
    state.isModelSelectionLockedMock.mockReturnValue(true);
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude"));

    await runBasicAgentCommand();

    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.fallbacksOverride).toEqual([]);
    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      executionSelection: expect.objectContaining({
        model: expect.objectContaining({ provider: "anthropic", id: "claude" }),
        executor: expect.objectContaining({ id: "codex" }),
      }),
      sessionEntry: expect.objectContaining({
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      }),
    });
  });

  it("uses an explicit per-run fallback chain with an explicit model", async () => {
    setupSingleAttemptFallback();
    const fallbacks = ["openai/gpt-5.6-terra", "anthropic/claude-sonnet-4-6"];
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude"));

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      model: "anthropic/claude",
      modelFallbacksOverride: fallbacks,
    });

    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.fallbacksOverride).toEqual(fallbacks);
  });

  it("keeps the accepted pair when continuing an ordinary locked harness session", async () => {
    setupSingleAttemptFallback();
    state.resolvedSessionKeyMock = "agent:main:plugin-owned";
    const { entry } = setupStoredSession(
      {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        executionSelection: acceptedModelSelection("anthropic", "claude", {
          executor: { kind: "harness", id: "codex" },
        }),
        skillsSnapshot: { prompt: "", skills: [], version: 0 },
      },
      undefined,
      "agent:main:plugin-owned",
    );
    const accepted = structuredClone(entry.executionSelection);
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude"));

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      executionSelection: {
        model: { provider: "anthropic", id: "claude" },
        executor: { kind: "harness", id: "codex" },
      },
      sessionEntry: expect.objectContaining({ modelSelectionLocked: true }),
    });
    expect(entry.executionSelection).toEqual(accepted);
  });

  it("keeps the fast mode cutoff timestamp across live model switch retries", async () => {
    let invocation = 0;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      invocation++;
      const result = await runInitialFallbackAttempt(params);
      if (invocation === 1) {
        throw await persistSwitchNotification(
          new LiveSessionModelSwitchError({
            selection: {
              model: { provider: "openai", id: "gpt-5.4" },
              executor: { kind: "harness", id: "openclaw" },
            },
          }),
        );
      }
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await runBasicAgentCommand();

    const firstAttempt = mockCallArg(state.runAgentAttemptMock, 0) as {
      fastModeStartedAtMs?: number;
    };
    const secondAttempt = mockCallArg(state.runAgentAttemptMock, 1) as {
      fastModeStartedAtMs?: number;
    };
    expect(firstAttempt.fastModeStartedAtMs).toBe(secondAttempt.fastModeStartedAtMs);
  });

  it("reuses durable user-turn proof across live model switch retries", async () => {
    let fallbackInvocation = 0;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      fallbackInvocation += 1;
      const result = await runInitialFallbackAttempt(params);
      if (fallbackInvocation === 1) {
        throw await persistSwitchNotification(
          new LiveSessionModelSwitchError({
            selection: {
              model: { provider: "openai", id: "gpt-5.4" },
              executor: { kind: "harness", id: "openclaw" },
            },
          }),
        );
      }
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockImplementation(async (attemptParams: unknown) => {
      const attempt = attemptParams as {
        userTurnTranscriptRecorder?: {
          markRuntimePersisted: (message: { role: "user"; content: string }) => void;
        };
      };
      if (state.runAgentAttemptMock.mock.calls.length === 1) {
        attempt.userTurnTranscriptRecorder?.markRuntimePersisted({
          role: "user",
          content: "hello",
        });
      }
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await runBasicAgentCommand();

    const firstAttempt = mockCallArg(state.runAgentAttemptMock, 0) as {
      suppressPromptPersistenceOnRetry?: boolean;
      userTurnTranscriptRecorder?: unknown;
    };
    const secondAttempt = mockCallArg(state.runAgentAttemptMock, 1) as {
      suppressPromptPersistenceOnRetry?: boolean;
      userTurnTranscriptRecorder?: unknown;
    };
    expect(secondAttempt.userTurnTranscriptRecorder).toBe(firstAttempt.userTurnTranscriptRecorder);
    expect(firstAttempt.suppressPromptPersistenceOnRetry).toBe(false);
    expect(secondAttempt.suppressPromptPersistenceOnRetry).toBe(true);
  });

  it("uses an embedded queue rebound generation for terminal lifecycle and cleanup", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockImplementation(async (attemptParams: unknown) => {
      (
        attemptParams as {
          onLifecycleGenerationChanged?: (lifecycleGeneration: string) => void;
        }
      ).onLifecycleGenerationChanged?.("post-restart-generation");
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await runBasicAgentCommand();

    const lifecycleEnd = state.emitAgentEventMock.mock.calls
      .map(
        (call) =>
          call[0] as {
            stream?: string;
            data?: { phase?: string };
            lifecycleGeneration?: string;
          },
      )
      .find((event) => event.stream === "lifecycle" && event.data?.phase === "end");
    expect(lifecycleEnd?.lifecycleGeneration).toBe("post-restart-generation");
    expect(state.clearAgentRunContextMock).toHaveBeenCalledWith(
      expect.any(String),
      "post-restart-generation",
    );
  });

  it("uses an embedded queue rebound generation for cleanup when the attempt fails", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockImplementation(async (attemptParams: unknown) => {
      (
        attemptParams as {
          onLifecycleGenerationChanged?: (lifecycleGeneration: string) => void;
        }
      ).onLifecycleGenerationChanged?.("post-restart-generation");
      throw new Error("attempt failed after queue rebound");
    });

    await expect(runBasicAgentCommand()).rejects.toThrow("attempt failed after queue rebound");

    expect(state.clearAgentRunContextMock).toHaveBeenCalledWith(
      expect.any(String),
      "post-restart-generation",
    );
  });

  it("preserves bounded delivery evidence when strict post-turn delivery throws", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    const secret = ["sk", "strict-delivery-secret-value"].join("-");
    state.deliverAgentCommandResultMock.mockImplementation(async (params: unknown) => {
      (
        params as {
          onDeliveryResult?: (result: { deliveryStatus: Record<string, unknown> }) => void;
        }
      ).onDeliveryResult?.({
        deliveryStatus: {
          status: "failed",
          errorMessage: `Authorization: Bearer ${secret}`,
          target: "discord:dm:private",
        },
      });
      throw new Error("strict delivery failed");
    });

    await expect(runDiscordDelivery()).rejects.toThrow("strict delivery failed");

    const lifecycleError = state.emitAgentEventMock.mock.calls
      .map((call) => call[0] as { stream?: string; data?: Record<string, unknown> })
      .find((event) => event.stream === "lifecycle" && event.data?.phase === "error");
    expect(lifecycleError?.data?.terminalDelivery).toEqual({
      status: "failed",
      resultCount: 0,
    });
    for (const field of ["stopReason", "terminalReceipt", "terminalReply"]) {
      expect(lifecycleError?.data).not.toHaveProperty(field);
    }
    expect(JSON.stringify(lifecycleError)).not.toContain(secret);
    expect(JSON.stringify(lifecycleError)).not.toContain("discord:dm:private");
  });

  it("preserves restart ownership when an aborted attempt resolves normally", async () => {
    setupSingleAttemptFallback();
    const controller = new AbortController();
    state.runAgentAttemptMock.mockImplementation(async () => {
      controller.abort(createAgentRunRestartAbortError());
      return {
        payloads: [],
        meta: {
          durationMs: 100,
          aborted: true,
          stopReason: "end_turn",
          agentMeta: { provider: "anthropic", model: "claude" },
        },
      };
    });

    await expect(
      agentCommand({
        message: "hello",
        to: "+1234567890",
        abortSignal: controller.signal,
        runtimePluginToolGrant: { pluginId: "owner-tools", toolNames: ["owner-only"] },
      }),
    ).rejects.toThrow("agent run aborted for restart");

    const lifecycleEvents = state.emitAgentEventMock.mock.calls
      .map((call) => call[0] as { stream?: string; data?: Record<string, unknown> })
      .filter((event) => event.stream === "lifecycle");
    expect(lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "error",
            aborted: true,
            stopReason: "restart",
          }),
        }),
      ]),
    );
    expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
  });

  it.each([
    ["restart abort", "agent run aborted for restart"],
    ["lifecycle replacement", "Agent run belongs to a stale gateway lifecycle"],
  ] as const)(
    "does not run CLI compaction when %s closes after persistence",
    async (mode, error) => {
      setupSingleAttemptFallback();
      setupStoredSession({ contextTokens: 32_768 });
      const controller = new AbortController();
      const result = makeSuccessResult("openai", "gpt-5.4") as ReturnType<
        typeof makeSuccessResult
      > & { meta: Record<string, unknown> };
      result.meta.executionTrace = {
        runner: "cli",
        fallbackUsed: false,
        winnerProvider: "openai",
        winnerModel: "gpt-5.4",
      };
      state.runAgentAttemptMock.mockResolvedValue(result);
      const compact = vi.fn();
      state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(
        async (params: { sessionEntry?: SessionEntry }, host: { assertActive?: () => void }) => {
          expectDefined(host.assertActive, "compaction authority")();
          compact();
          return params.sessionEntry;
        },
      );
      state.persistCliTurnTranscriptMock.mockImplementationOnce(
        async (params: { sessionEntry?: SessionEntry }) => {
          if (mode === "restart abort") {
            controller.abort(createAgentRunRestartAbortError());
          } else {
            state.assertLifecycleCurrentMock.mockImplementationOnce(() => {
              throw new Error(error);
            });
          }
          return { kind: "persisted", sessionEntry: params.sessionEntry };
        },
      );

      await expect(
        agentCommand({
          message: "hello",
          to: "+1234567890",
          abortSignal: controller.signal,
        }),
      ).rejects.toThrow(error);

      expect(state.persistCliTurnTranscriptMock).toHaveBeenCalledOnce();
      expect(state.runMemoryFlushIfNeededMock).not.toHaveBeenCalled();
      expect(state.runCliTurnCompactionLifecycleMock).toHaveBeenCalledOnce();
      expect(compact).not.toHaveBeenCalled();
      expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["restart abort", "agent run aborted for restart"],
    ["lifecycle replacement", "Agent run belongs to a stale gateway lifecycle"],
  ] as const)("stops finalization when CLI compaction sees a %s", async (mode, error) => {
    setupSingleAttemptFallback();
    const { store } = setupStoredSession({
      contextTokens: 32_768,
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
    });
    const controller = new AbortController();
    const result = makeSuccessResult("openai", "gpt-5.4") as ReturnType<
      typeof makeSuccessResult
    > & { meta: Record<string, unknown> };
    result.meta.executionTrace = {
      runner: "cli",
      fallbackUsed: false,
      winnerProvider: "openai",
      winnerModel: "gpt-5.4",
    };
    state.runAgentAttemptMock.mockResolvedValue(result);
    state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params) => {
      if (mode === "restart abort") {
        controller.abort(createAgentRunRestartAbortError());
      } else {
        state.assertLifecycleCurrentMock.mockImplementationOnce(() => {
          throw new Error(error);
        });
      }
      return params.sessionEntry;
    });

    await expect(
      agentCommand({
        message: "hello",
        to: "+1234567890",
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow(error);

    expect(state.runMemoryFlushIfNeededMock).not.toHaveBeenCalled();
    expect(state.runCliTurnCompactionLifecycleMock).toHaveBeenCalledOnce();
    const compactionParams = requireRecord(
      mockCallArg(state.runCliTurnCompactionLifecycleMock),
      "CLI compaction parameters",
    );
    expect(compactionParams.sessionEntry).toMatchObject({
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
    });
    for (const field of [
      "runtimePluginToolGrant",
      "scheduledToolPolicy",
      "trustedInternalHandoff",
      "bashElevated",
    ]) {
      expect(compactionParams).not.toHaveProperty(field);
    }
    expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
    expect(store["agent:main:main"]?.pendingFinalDelivery).toBeUndefined();
  });

  it("rejects pre-aborted ACP admission with the original restart cause", async () => {
    setupAcpSession();
    const controller = new AbortController();
    const reason = createAgentRunRestartAbortError();
    controller.abort(reason);

    await expect(
      agentCommand({
        message: "hello",
        sessionKey: "agent:main:main",
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError", cause: reason });

    expect(state.acpRunTurnMock).not.toHaveBeenCalled();
    expect(state.emitAcpLifecycleStartMock).not.toHaveBeenCalled();
    expect(state.emitAcpLifecycleEndMock).not.toHaveBeenCalled();
    expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
  });

  it("preserves restart ownership when an aborted ACP turn resolves normally", async () => {
    setupAcpSession();
    const controller = new AbortController();
    state.acpRunTurnMock.mockImplementationOnce(async () => {
      controller.abort(createAgentRunRestartAbortError());
    });

    await expect(
      agentCommand({
        message: "hello",
        sessionKey: "agent:main:main",
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("agent run aborted for restart");

    expect(state.acpRunTurnMock).toHaveBeenCalledOnce();
    expect(state.emitAcpLifecycleEndMock).not.toHaveBeenCalled();
    expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
  });

  it("suppresses ACP delivery when restart begins during transcript persistence", async () => {
    setupAcpSession();
    const controller = new AbortController();
    state.persistAcpTurnTranscriptMock.mockImplementation(
      async (params: { sessionEntry?: unknown }) => {
        controller.abort(createAgentRunRestartAbortError());
        return { kind: "persisted", sessionEntry: params.sessionEntry };
      },
    );

    await expect(
      agentCommand({
        message: "hello",
        sessionKey: "agent:main:main",
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("agent run aborted for restart");

    expect(state.emitAcpLifecycleEndMock).not.toHaveBeenCalled();
    expect(state.emitAcpLifecycleErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "session-1",
        sessionKey: "agent:main:main",
      }),
    );
    const lifecycleError = state.emitAcpLifecycleErrorMock.mock.calls[0]?.[0] as
      | { abortSignal?: AbortSignal }
      | undefined;
    expect(lifecycleError?.abortSignal?.aborted).toBe(true);
    expect(lifecycleError?.abortSignal?.reason).toBe(controller.signal.reason);
    expect(state.persistAcpTurnTranscriptMock).toHaveBeenCalledTimes(1);
    expect(state.buildAcpResultMock).not.toHaveBeenCalled();
    expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
  });

  it("threads lifecycle ownership into ACP delivery", async () => {
    setupAcpSession();

    await agentCommand({
      message: "hello",
      sessionKey: "agent:main:main",
    });

    expect(state.registerAgentRunContextMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ projectSessionActive: true }),
    );
    const deliveryParams = requireRecord(
      mockCallArg(state.deliverAgentCommandResultMock),
      "ACP delivery params",
    );
    expect(deliveryParams.assertDeliveryCurrent).toBeTypeOf("function");
    (deliveryParams.assertDeliveryCurrent as () => void)();
    expect(state.assertLifecycleCurrentMock).toHaveBeenLastCalledWith("test-generation");
  });

  it("persists structured transcript media for ACP turns", async () => {
    setupAcpSession();

    await agentCommand({
      message: "[media attached: media://inbound/image-1]",
      transcriptMessage: "",
      transcriptMedia: [{ path: "/media/inbound/image-1.png", contentType: "image/png" }],
      sessionKey: "agent:main:main",
    });

    expect(state.persistAcpTurnTranscriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptBody: "",
        userInput: {
          text: "",
          media: [{ path: "/media/inbound/image-1.png", contentType: "image/png" }],
        },
      }),
    );
  });

  it("keeps the initial session touch for local runs", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    setupStoredSession();

    await runBasicAgentCommand();

    const touchWrites = state.persistSessionEntryMock.mock.calls.filter((call) => {
      const { initialEntry, entry } = call[0] as Parameters<
        typeof import("./command/attempt-execution.shared.js").persistAgentSession
      >[0];
      return (
        entry.lastInteractionAt !== undefined &&
        entry.lastInteractionAt !== initialEntry.lastInteractionAt
      );
    });
    expect(touchWrites).toHaveLength(1);
    expect(state.updateSessionStoreAfterAgentRunMock).toHaveBeenCalledTimes(1);
  });

  it("threads lifecycle ownership into normal delivery", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    setupStoredSession();

    await runBasicAgentCommand();

    const deliveryParams = requireRecord(
      mockCallArg(state.deliverAgentCommandResultMock),
      "delivery params",
    );
    expect(deliveryParams.assertDeliveryCurrent).toBeTypeOf("function");
    (deliveryParams.assertDeliveryCurrent as () => void)();
    expect(state.assertLifecycleCurrentMock).toHaveBeenLastCalledWith("test-generation");
  });

  it("passes explicit timeout overrides into agent attempts", async () => {
    // Freeze preflight elapsed time to keep the forwarding assertions exact.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      timeout: "600",
    });

    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      timeoutMs: 600_000,
      runTimeoutOverrideMs: 600_000,
    });
  });

  it("clamps unsupported explicit thinking for subagent spawns instead of throwing", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude-fable-5"));
    state.resolvedSessionKeyMock = "agent:planner:subagent:00000000-0000-4000-8000-000000000000";
    state.isThinkingLevelSupportedMock.mockReturnValue(false);
    state.resolveSupportedThinkingLevelMock.mockReturnValue("high");

    await agentCommand({
      message: "hello",
      sessionKey: state.resolvedSessionKeyMock,
      thinking: "xhigh",
      lane: "subagent",
    });

    expect(state.resolveSupportedThinkingLevelMock).toHaveBeenCalled();
    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      resolvedThinkLevel: "high",
    });
  });

  it.each([
    {
      name: "rejects unsupported explicit thinking for interactive subagent-key runs",
      sessionKey: "agent:planner:subagent:00000000-0000-4000-8000-000000000000",
      lane: undefined,
    },
    {
      name: "rejects unsupported explicit thinking for non-subagent sessions on the subagent lane",
      sessionKey: "agent:main:main",
      lane: "subagent" as const,
    },
  ])("$name", async ({ sessionKey, lane }) => {
    setupSuccessfulAttempt("anthropic", "claude-fable-5");
    state.resolvedSessionKeyMock = sessionKey;
    state.isThinkingLevelSupportedMock.mockReturnValue(false);

    await expect(
      agentCommand({
        message: "hello",
        sessionKey: state.resolvedSessionKeyMock,
        thinking: "xhigh",
        lane,
      }),
    ).rejects.toThrow(/is not supported/u);
    expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported explicit thinking for direct interactive runs", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude-fable-5"));
    state.resolvedSessionKeyMock = "agent:main:main";
    state.isThinkingLevelSupportedMock.mockReturnValue(false);
    const { store } = setupStoredSession({ thinkingLevel: "low" });

    await expect(
      agentCommand({
        message: "hello",
        to: "+1234567890",
        thinking: "ultra",
      }),
    ).rejects.toThrow(/is not supported/u);
    expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
    expect(store["agent:main:main"]?.thinkingLevel).toBe("low");
    expect(state.persistSessionEntryMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ thinkingLevel: "ultra" }),
      }),
    );
  });

  it("skips the initial session touch after gateway ingress already persisted activity", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    setupStoredSession();

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      skipInitialSessionTouch: true,
    });

    const touchWrites = state.persistSessionEntryMock.mock.calls.filter((call) => {
      const entry = (call[0] as { entry?: Record<string, unknown> } | undefined)?.entry;
      return entry?.lastInteractionAt !== undefined;
    });
    expect(touchWrites).toHaveLength(0);
    expect(state.updateSessionStoreAfterAgentRunMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "uses channel model override as the initial run model for channel-backed sessions",
      sessionEntry: createCommandSessionFixture({ channel: "discord", groupId: "channel-123" })
        .entry,
      command: undefined,
      expectResolverContext: true,
      expectAttemptModel: true,
    },
    {
      name: "uses current run channel context when persisted session metadata is absent",
      sessionEntry: undefined,
      command: {
        message: "hello",
        channel: "discord",
        groupId: "channel-123",
        to: "discord:channel:channel-123",
      },
      expectResolverContext: false,
      expectAttemptModel: false,
    },
    {
      name: "keeps persisted channel model override when current run context is internal",
      sessionEntry: createCommandSessionFixture({ channel: "discord", groupId: "channel-123" })
        .entry,
      command: {
        message: "hello",
        channel: "internal",
        messageChannel: "internal",
        to: "internal",
      },
      expectResolverContext: true,
      expectAttemptModel: false,
    },
  ])("$name", async ({ sessionEntry, command, expectResolverContext, expectAttemptModel }) => {
    setupSuccessfulAttempt("openai", "channel-model");
    state.runtimeConfigMock = createChannelModelRuntimeConfig();
    state.sessionEntryMock = sessionEntry;

    await (command ? agentCommand(command) : runBasicAgentCommand());

    if (expectResolverContext) {
      expect(mockCallArg(state.resolveChannelModelOverrideMock)).toMatchObject({
        channel: "discord",
        groupId: "channel-123",
      });
    }
    if (expectAttemptModel) {
      expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
        executionSelection: expect.objectContaining({
          model: expect.objectContaining({ provider: "openai", id: "channel-model" }),
        }),
      });
    }
    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.provider).toBe("openai");
    expect(fallbackParams.model).toBe("channel-model");
  });

  it.each([false, true])(
    "keeps incomplete SDK intent across a command and completes it later; partial=%s",
    async (partial) => {
      await withOpenClawTestState({ label: "command-partial-selection" }, async (testState) => {
        const sessionKey = "agent:default:discord:channel:channel-123";
        const scope = {
          agentId: "default",
          sessionKey,
          storePath: testState.path("alternate", "sessions.json"),
        };
        await upsertSdkSessionEntry({
          ...scope,
          entry: projectPublicSessionEntry(
            createCommandSessionEntry({
              channel: "discord",
              groupId: "channel-123",
              skillsSnapshot: { prompt: "", skills: [], version: 0 },
            }),
          ),
        });
        if (partial) {
          await patchSdkSessionEntry({ ...scope, update: () => ({ providerOverride: "pending" }) });
        }
        state.runtimeConfigMock = {
          agents: {
            defaults: {
              model: "fixture/default",
              models: { "fixture/default": {}, "fixture/decoy": {}, "pending/replacement": {} },
            },
          },
          channels: { modelByChannel: { discord: { "channel-123": "fixture/decoy" } } },
        };
        state.resolvedSessionKeyMock = sessionKey;
        state.storePathMock = scope.storePath;
        for (const phase of partial ? ["initial", "complete"] : ["initial"]) {
          if (phase === "complete") {
            await patchSdkSessionEntry({
              ...scope,
              update: () => ({ modelOverride: "replacement" }),
            });
          }
          const entry = expectDefined(sessionAccessor.loadSessionEntryReadOnly(scope), "session");
          state.sessionEntryMock = entry;
          state.sessionStoreMock = { [sessionKey]: entry };
          const provider = phase === "complete" ? "pending" : "fixture";
          const model = phase === "complete" ? "replacement" : partial ? "default" : "decoy";
          setupSuccessfulAttempt(provider, model);
          state.runAgentAttemptMock.mockClear();

          await agentCommand({ message: "Continue", sessionKey, channel: "discord" });

          expect(state.runAgentAttemptMock).toHaveBeenCalledWith(
            expect.objectContaining({
              executionSelection: {
                model: { provider, id: model },
                executor: { kind: "harness", id: "openclaw" },
              },
            }),
          );
          if (partial && phase === "initial") {
            await patchSdkSessionEntry({
              ...scope,
              update: () => ({ modelProvider: "observation", model: "observed" }),
            });
            const view = expectDefined(getSdkSessionEntry(scope), "public session view");
            expect(view.providerOverride).toBe("pending");
            expect(view.modelOverride).toBeUndefined();
          }
        }
        if (partial) {
          expect(getSdkSessionEntry(scope)).toMatchObject({
            providerOverride: "pending",
            modelOverride: "replacement",
          });
        }
      });
    },
  );

  it.each(["explicit", "configured"] as const)(
    "inherits the threaded parent's model and %s fallback permission after an implicit SDK default",
    async (fallbackPermission) => {
      const { applyModelOverrideToSessionEntry } = await vi.importActual<
        typeof ModelSessionRuntime
      >("../plugin-sdk/model-session-runtime.js");
      await withOpenClawTestState({ label: "command-sdk-thread-default" }, async (testState) => {
        const parentKey = "agent:default:webchat:channel:parent";
        const sessionKey = parentKey + ":thread:child";
        const storePath = testState.path("alternate", "sessions.json");
        const parentScope = { agentId: "default", sessionKey: parentKey, storePath };
        const scope = { agentId: "default", sessionKey, storePath };
        const parent = createCommandSessionEntry({ sessionId: "parent-session" });
        commitSessionExecutionSelection(
          parent,
          {
            model: { provider: "fixture", id: "parent" },
            executor: { kind: "harness", id: "openclaw" },
          },
          { cause: { kind: "initialize", fallbackPermission } },
        );
        await sessionAccessor.replaceSessionEntry(parentScope, parent);
        await upsertSdkSessionEntry({
          ...scope,
          entry: {
            sessionId: "session-1",
            updatedAt: 1,
            skillsSnapshot: { prompt: "", skills: [], version: 0 },
          },
        });
        const view = expectDefined(getSdkSessionEntry(scope), "released child view");
        applyModelOverrideToSessionEntry({
          entry: view,
          selection: { provider: "fixture", model: "default", isDefault: true },
        });
        await upsertSdkSessionEntry({ ...scope, entry: view });
        const child = expectDefined(
          sessionAccessor.loadSessionEntryReadOnly(scope),
          "staged child",
        );
        expect(child.parentSessionKey).toBeUndefined();
        expect(child.executionSelection).toMatchObject({
          state: "deferred",
          request: { defaultSelection: "inherit" },
        });
        state.runtimeConfigMock = {
          agents: {
            defaults: {
              model: "fixture/default",
              models: { "fixture/default": {}, "fixture/parent": {} },
            },
          },
        };
        state.resolvedSessionKeyMock = sessionKey;
        state.storePathMock = storePath;
        state.sessionEntryMock = child;
        state.sessionStoreMock = { [sessionKey]: child, [parentKey]: parent };
        setupSuccessfulAttempt("fixture", "parent");

        await agentCommand({ message: "Continue the thread", sessionKey });

        expect(state.runAgentAttemptMock).toHaveBeenCalledWith(
          expect.objectContaining({
            executionSelection: {
              model: { provider: "fixture", id: "parent" },
              executor: { kind: "harness", id: "openclaw" },
            },
          }),
        );
        expect(sessionAccessor.loadSessionEntryReadOnly(scope)?.executionSelection).toEqual({
          state: "accepted",
          selection: {
            model: { provider: "fixture", id: "parent" },
            executor: { kind: "harness", id: "openclaw" },
          },
          fallbackPermission,
        });
        expect(sessionAccessor.loadSessionEntryReadOnly(parentScope)?.executionSelection).toEqual(
          parent.executionSelection,
        );
      });
    },
  );

  it("uses current threaded session key for parent channel model overrides", async () => {
    setupSingleAttemptFallback();
    state.runtimeConfigMock = createChannelModelRuntimeConfig({
      channel: "slack",
      matchKey: "general",
      model: "openai/parent-channel-model",
    });
    state.resolvedSessionKeyMock = "agent:main:slack:channel:general:thread:thread-1";
    state.sessionEntryMock = createCommandSessionEntry({
      sessionId: "session-1",
      updatedAt: 1,
      channel: "slack",
      groupId: "thread-1",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    });
    state.runAgentAttemptMock.mockResolvedValue(
      makeSuccessResult("openai", "parent-channel-model"),
    );

    await runBasicAgentCommand();

    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.provider).toBe("openai");
    expect(fallbackParams.model).toBe("parent-channel-model");
  });

  it("keeps stored session model overrides ahead of channel model overrides", async () => {
    setupSingleAttemptFallback();
    state.runtimeConfigMock = createChannelModelRuntimeConfig({
      additionalModels: { "anthropic/stored-model": {} },
    });
    state.sessionEntryMock = createCommandSessionEntry({
      sessionId: "session-1",
      updatedAt: 1,
      channel: "discord",
      groupId: "channel-123",
      executionSelection: acceptedModelSelection("anthropic", "stored-model"),
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "stored-model"));

    await runBasicAgentCommand();

    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.provider).toBe("anthropic");
    expect(fallbackParams.model).toBe("stored-model");
  });

  it("keeps explicit run model overrides ahead of channel model overrides", async () => {
    setupSingleAttemptFallback();
    state.runtimeConfigMock = createChannelModelRuntimeConfig({
      additionalModels: { "openai/explicit-model": {} },
    });
    state.sessionEntryMock = createCommandSessionEntry({
      sessionId: "session-1",
      updatedAt: 1,
      channel: "discord",
      groupId: "channel-123",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "explicit-model"));

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      model: "openai/explicit-model",
      allowModelOverride: true,
    });

    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.provider).toBe("openai");
    expect(fallbackParams.model).toBe("explicit-model");
  });

  it("uses the accepted compaction identity for all post-run session persistence", async () => {
    setupSingleAttemptFallback();
    setupStoredSession();
    const rotatedEntry: SessionEntry = {
      sessionId: "rotated-session",
      sessionFile: "/tmp/rotated-session.jsonl",
      updatedAt: 2,
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    const result = makeSuccessResult("openai", "gpt-5.4") as ReturnType<
      typeof makeSuccessResult
    > & {
      meta: Record<string, unknown> & { agentMeta: Record<string, unknown> };
    };
    result.meta.executionTrace = {
      runner: "cli",
      fallbackUsed: false,
      winnerProvider: "openai",
      winnerModel: "gpt-5.4",
    };
    result.meta.finalAssistantVisibleText = "ok";
    result.meta.agentMeta = {
      ...result.meta.agentMeta,
      sessionId: "native-thread-session",
      sessionFile: "/tmp/native-thread-session.jsonl",
    };
    state.runAgentAttemptMock.mockImplementationOnce(
      async (
        params: Parameters<typeof import("./command/attempt-execution.js").runAgentAttempt>[0],
      ) => {
        const target = expectDefined(params.sessionTarget, "accepted compaction target");
        params.onCompactionAccounting?.({
          kind: "durable",
          count: 0,
          target: {
            ...target,
            sessionId: rotatedEntry.sessionId,
            lifecycleRevision: undefined,
            activeWriterRunId: undefined,
          },
        });
        return result;
      },
    );
    state.updateSessionStoreAfterAgentRunMock.mockImplementation(async () => {
      state.sessionStoreMock = { "agent:main:main": rotatedEntry };
    });
    state.persistCliTurnTranscriptMock.mockResolvedValue({
      kind: "persisted",
      sessionEntry: rotatedEntry,
    });
    state.runCliTurnCompactionLifecycleMock.mockResolvedValue(rotatedEntry);

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.updateSessionStoreAfterAgentRunMock), {
      sessionId: "rotated-session",
    });
    expectRecordFields(mockCallArg(state.persistCliTurnTranscriptMock), {
      sessionId: "rotated-session",
      sessionKey: "agent:main:main",
    });
    expectRecordFields(mockCallArg(state.runCliTurnCompactionLifecycleMock), {
      sessionId: "rotated-session",
      sessionKey: "agent:main:main",
    });
    expectRecordFields(mockCallArg(state.deliverAgentCommandResultMock), {
      expectedSessionIdForFreshDelivery: "rotated-session",
    });
  });

  it("skips post-run persistence after the session is deleted", async () => {
    setupSingleAttemptFallback();
    setupStoredSession();
    const result = makeSuccessResult("openai", "gpt-5.4") as ReturnType<
      typeof makeSuccessResult
    > & {
      meta: Record<string, unknown> & { executionTrace: Record<string, unknown> };
    };
    result.meta.executionTrace = {
      runner: "cli",
      fallbackUsed: false,
      winnerProvider: "openai",
      winnerModel: "gpt-5.4",
    };
    state.runAgentAttemptMock.mockResolvedValue(result);
    state.persistCliTurnTranscriptMock.mockResolvedValue({
      kind: "session-rebound",
      sessionEntry: undefined,
    });

    await runBasicAgentCommand();

    expect(state.persistCliTurnTranscriptMock).toHaveBeenCalledTimes(1);
    expect(state.runMemoryFlushIfNeededMock).not.toHaveBeenCalled();
    expect(state.runCliTurnCompactionLifecycleMock).not.toHaveBeenCalled();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledTimes(1);
  });

  it("repairs pending assistant transcript state before the next model attempt", async () => {
    setupSingleAttemptFallback();
    setupStoredSession({
      pendingTranscriptRepair: [{ id: "repair-1", text: "missing assistant", createdAt: 10 }],
    });
    state.runAgentAttemptMock.mockImplementation(async () => {
      expect(state.appendExactAssistantMessageMock).toHaveBeenCalledTimes(1);
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await runBasicAgentCommand();

    expect(state.runAgentAttemptMock).toHaveBeenCalledTimes(1);
  });

  it("queues transcript repair when post-run transcript persistence fails", async () => {
    setupSingleAttemptFallback();
    setupStoredSession();
    const result = makeSuccessResult("openai", "gpt-5.4") as ReturnType<
      typeof makeSuccessResult
    > & {
      meta: Record<string, unknown>;
    };
    result.meta.executionTrace = {
      runner: "cli",
      fallbackUsed: false,
      winnerProvider: "openai",
      winnerModel: "gpt-5.4",
    };
    state.runAgentAttemptMock.mockResolvedValue(result);
    state.persistCliTurnTranscriptMock.mockRejectedValue(new Error("transcript unavailable"));

    await runBasicAgentCommand();

    expect(findPersistedTranscriptRepair()).toEqual([
      expect.objectContaining({ text: "ok", provider: "openai", model: "gpt-5.4" }),
    ]);
    expect(state.runMemoryFlushIfNeededMock).not.toHaveBeenCalled();
  });

  it("does not queue repair for a final owned by another transcript writer", async () => {
    setupSingleAttemptFallback();
    setupStoredSession();
    const result = makeSuccessResult("openai", "gpt-5.4") as ReturnType<
      typeof makeSuccessResult
    > & {
      meta: Record<string, unknown>;
    };
    result.payloads = [
      setReplyPayloadMetadata({ text: "runtime-owned" }, { assistantTranscriptOwned: true }),
    ];
    result.meta.executionTrace = {
      runner: "cli",
      fallbackUsed: false,
      winnerProvider: "openai",
      winnerModel: "gpt-5.4",
    };
    state.runAgentAttemptMock.mockResolvedValue(result);
    state.persistCliTurnTranscriptMock.mockRejectedValue(new Error("transcript unavailable"));

    await runBasicAgentCommand();

    expect(findPersistedTranscriptRepair()).toBeUndefined();
  });

  it("preserves restart recovery ownership when delivery fails after a session rebound", async () => {
    setupSingleAttemptFallback();
    setupStoredSession();
    const sessionStore = state.sessionStoreMock as Record<string, SessionEntry>;
    const claimedEntry = expectDefined(
      sessionStore["agent:main:main"],
      "preclaimed restart recovery session",
    );
    claimedEntry.restartRecoveryDeliveryRunId = "session-1";
    claimedEntry.restartRecoveryDeliveryContext = {
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
    };
    const result = makeSuccessResult("openai", "gpt-5.4") as ReturnType<
      typeof makeSuccessResult
    > & {
      meta: Record<string, unknown> & { executionTrace: Record<string, unknown> };
    };
    result.meta.executionTrace = {
      runner: "cli",
      fallbackUsed: false,
      winnerProvider: "openai",
      winnerModel: "gpt-5.4",
    };
    state.runAgentAttemptMock.mockResolvedValue(result);
    state.persistCliTurnTranscriptMock.mockResolvedValue({
      kind: "session-rebound",
      sessionEntry: undefined,
    });
    state.deliverAgentCommandResultMock.mockRejectedValue(new Error("delivery failed"));

    await expect(
      agentCommand({
        message: "hello",
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
        deliver: true,
      }),
    ).rejects.toThrow("delivery failed");

    expect(sessionStore["agent:main:main"]?.restartRecoveryDeliveryRunId).toBe("session-1");
  });

  it.each([true, false])(
    "does not duplicate a recorder-owned CLI input after completion (persisted=%s)",
    async (persisted) => {
      type AttemptCall = {
        onUserMessagePersisted?: () => void;
        userTurnTranscriptRecorder: UserTurnTranscriptRecorder;
      };
      setupSingleAttemptFallback();
      setupStoredSession();
      const result = makeSuccessResult("openai", "gpt-5.4") as ReturnType<
        typeof makeSuccessResult
      > & {
        meta: Record<string, unknown> & { executionTrace: Record<string, unknown> };
      };
      result.meta.executionTrace = {
        runner: "cli",
        fallbackUsed: false,
        winnerProvider: "openai",
        winnerModel: "gpt-5.4",
      };
      state.runAgentAttemptMock.mockImplementation(async (attemptParams: AttemptCall) => {
        if (persisted) {
          attemptParams.userTurnTranscriptRecorder.markRuntimePersisted();
          attemptParams.onUserMessagePersisted?.();
        }
        return result;
      });
      state.persistCliTurnTranscriptMock.mockResolvedValue({
        kind: "persisted",
        sessionEntry: state.sessionEntryMock,
      });
      const userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
        input: { text: "hello", idempotencyKey: "canonical-user:user" },
        target: () => undefined,
      });

      await agentCommand({
        message: "hello",
        to: "+1234567890",
        userTurnTranscriptRecorder,
      });

      expect(mockCallArg(state.runAgentAttemptMock)).toMatchObject({
        userTurnTranscriptRecorder,
      });
      expect(mockCallArg(state.persistCliTurnTranscriptMock)).toMatchObject({
        skipUserTurn: true,
      });
    },
  );

  it("does not treat backend CLI session id as OpenClaw session identity", async () => {
    setupSingleAttemptFallback();
    setupStoredSession();
    const result = makeSuccessResult("openai", "gpt-5.4") as ReturnType<
      typeof makeSuccessResult
    > & {
      meta: Record<string, unknown> & { agentMeta: Record<string, unknown> };
    };
    result.meta.agentMeta = {
      ...result.meta.agentMeta,
      sessionId: "backend-cli-session",
    };
    state.runAgentAttemptMock.mockResolvedValue(result);

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.updateSessionStoreAfterAgentRunMock), {
      sessionId: "session-1",
    });
    expectRecordFields(mockCallArg(state.deliverAgentCommandResultMock), {
      expectedSessionIdForFreshDelivery: "session-1",
    });
  });

  it("persists explicit overrides even when ingress skips the initial touch", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    setupStoredSession();

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      thinking: "medium",
      skipInitialSessionTouch: true,
    });

    const touchWrite = state.persistSessionEntryMock.mock.calls.find((call) => {
      const entry = (call[0] as { entry?: Record<string, unknown> } | undefined)?.entry;
      return entry?.thinkingLevel === "medium";
    })?.[0] as { entry?: Record<string, unknown> } | undefined;
    expect(touchWrite?.entry?.lastInteractionAt).toBeDefined();
    expect(state.updateSessionStoreAfterAgentRunMock).toHaveBeenCalledTimes(1);
  });

  it("forwards an explicit OpenClaw runtime override into fallback and attempt execution", async () => {
    setupSingleAttemptFallback();
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: { "openai/gpt-5.4": {} },
        },
      },
    };
    setupStoredSession({
      agentHarnessId: "codex",
      executionSelection: acceptedModelSelection("openai", "gpt-5.4"),
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      executionSelection: expect.objectContaining({
        model: expect.objectContaining({ provider: "openai", id: "gpt-5.4" }),
        executor: expect.objectContaining({ id: "openclaw" }),
      }),
    });
  });

  it("does not persist turn-local thinking fallback over a stored session override", async () => {
    setupSingleAttemptFallback();
    const { entry: sessionEntry, store: sessionStore } = setupStoredSession({
      thinkingLevel: "high",
    });
    state.isThinkingLevelSupportedMock.mockReturnValue(false);
    state.resolveSupportedThinkingLevelMock.mockReturnValue("off");
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      resolvedThinkLevel: "off",
    });
    expect(sessionEntry.thinkingLevel).toBe("high");
    expect(sessionStore["agent:main:main"]?.thinkingLevel).toBe("high");
    expect(state.persistSessionEntryMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ thinkingLevel: "off" }),
      }),
    );
  });

  it("revalidates immutable Ultra for each model fallback without persisting the remap", async () => {
    const { entry: sessionEntry } = setupStoredSession({ thinkingLevel: "ultra" });
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-luna" },
          models: {
            "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
            "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
          },
        },
      },
    };
    state.isThinkingLevelSupportedMock.mockImplementation((args: unknown) => {
      const { model, level } = args as { model?: string; level?: string };
      return model !== "gpt-5.6-luna" || level !== "ultra";
    });
    state.resolveSupportedThinkingLevelMock.mockImplementation(
      ({ level, model }: { level?: string; model?: string }) =>
        model === "gpt-5.6-luna" && level === "ultra" ? "max" : level,
    );
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      await runInitialFallbackAttempt(params);
      const result = await runSubsequentFallbackAttempt(params, "openai", "gpt-5.6-sol", "unknown");
      return {
        result,
        provider: "openai",
        model: "gpt-5.6-sol",
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockImplementation(
      async ({
        executionSelection,
      }: Parameters<typeof import("./command/attempt-execution.js").runAgentAttempt>[0]) => {
        if (!isModelExecutionSelection(executionSelection)) {
          throw new Error("Expected a concrete fixture model");
        }
        return makeSuccessResult(executionSelection.model.provider, executionSelection.model.id);
      },
    );

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.runAgentAttemptMock, 0), {
      executionSelection: expect.objectContaining({
        model: expect.objectContaining({ id: "gpt-5.6-luna" }),
      }),
      resolvedThinkLevel: "max",
    });
    expectRecordFields(mockCallArg(state.runAgentAttemptMock, 1), {
      executionSelection: expect.objectContaining({
        model: expect.objectContaining({ id: "gpt-5.6-sol" }),
      }),
      resolvedThinkLevel: "ultra",
    });
    expect(state.resolveSupportedThinkingLevelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.6-luna",
        level: "ultra",
        agentRuntime: "codex",
      }),
    );
    expect(sessionEntry.thinkingLevel).toBe("ultra");
    expect(state.persistSessionEntryMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ thinkingLevel: "max" }),
      }),
    );
    expectRecordFields(mockCallArg(state.updateSessionStoreAfterAgentRunMock), {
      preserveRuntimeModel: true,
    });
  });

  it("recomputes a model-derived thinking default for each fallback candidate", async () => {
    const policyModule = await import("./model-visibility-policy.js");
    const { createModelVisibilityPolicyWithFallbacks } =
      await import("./model-selection-shared.js");
    vi.spyOn(policyModule, "createModelVisibilityPolicy").mockImplementation((params) =>
      createModelVisibilityPolicyWithFallbacks({ ...params, fallbackModels: [] }),
    );
    setupStoredSession();
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          modelPolicy: { allow: ["openai/manual-only"] },
          models: {
            "openai/gpt-5.6-sol": {
              agentRuntime: { id: "codex" },
              params: { thinking: "off" },
            },
            "openai/gpt-5.6-terra": { agentRuntime: { id: "codex" } },
          },
        },
      },
    };
    state.resolveThinkingDefaultMock.mockImplementation((args: unknown) => {
      const { model, catalog } = args as {
        model?: string;
        catalog?: Array<{ provider: string; id: string; reasoning?: boolean }>;
      };
      if (model === "gpt-5.6-terra") {
        expect(catalog).toEqual([
          expect.objectContaining({
            provider: "openai",
            id: "gpt-5.6-terra",
            reasoning: true,
          }),
        ]);
        return "medium";
      }
      return "low";
    });
    state.loadProviderScopedThinkingCatalogMock.mockResolvedValue([
      {
        provider: "OpenAI",
        id: "gpt-5.6-terra",
        name: "GPT 5.6 Terra",
        reasoning: true,
      },
    ]);
    state.loadPreparedModelCatalogSnapshotMock.mockImplementation(async () => {
      await state.loadFullModelCatalogMock();
      return { entries: [], routeVariants: [] };
    });
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      await runInitialFallbackAttempt(params);
      const result = await runSubsequentFallbackAttempt(
        params,
        "openai",
        "gpt-5.6-terra",
        "unknown",
      );
      return {
        result,
        provider: "openai",
        model: "gpt-5.6-terra",
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockImplementation(
      async ({
        executionSelection,
      }: Parameters<typeof import("./command/attempt-execution.js").runAgentAttempt>[0]) => {
        if (!isModelExecutionSelection(executionSelection)) {
          throw new Error("Expected a concrete fixture model");
        }
        return makeSuccessResult(executionSelection.model.provider, executionSelection.model.id);
      },
    );

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.runAgentAttemptMock, 0), {
      executionSelection: expect.objectContaining({
        model: expect.objectContaining({ id: "gpt-5.6-sol" }),
      }),
      resolvedThinkLevel: "off",
    });
    expectRecordFields(mockCallArg(state.runAgentAttemptMock, 1), {
      executionSelection: expect.objectContaining({
        model: expect.objectContaining({ id: "gpt-5.6-terra" }),
      }),
      resolvedThinkLevel: "medium",
    });
    expect(state.loadProviderScopedThinkingCatalogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: state.runtimeConfigMock,
        provider: "openai",
        model: "gpt-5.6-terra",
        agentId: "default",
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(state.loadPreparedModelCatalogSnapshotMock).not.toHaveBeenCalled();
    expect(state.loadFullModelCatalogMock).not.toHaveBeenCalled();
  });

  it("keeps later provider capability metadata after hydrating a Codex primary", async () => {
    const nativeModel = {
      provider: "openai",
      id: "gpt-5.6-sol",
      name: "GPT 5.6 Sol",
      reasoning: true,
      compat: { supportedReasoningEfforts: ["max", "ultra"] },
    };
    const evaluateSupported = expectDefined(
      vi.mocked(evaluatePublishedModelRuntimeChoice).getMockImplementation(),
      "fixture runtime evaluator",
    );
    vi.mocked(evaluatePublishedModelRuntimeChoice).mockImplementation(async (params) =>
      params.runtimeId === "codex" && params.provider === "gmn"
        ? { kind: "unsupported", message: "The fixture app cannot run this route." }
        : evaluateSupported(params),
    );
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: {
            "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
            "gmn/gpt-5.4": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
    };
    state.loadManifestModelCatalogMock.mockReturnValue([
      { ...nativeModel, compat: { supportedReasoningEfforts: ["max"] } },
      {
        provider: "gmn",
        id: "gpt-5.4",
        name: "GPT 5.4 via GMN",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
      },
    ]);
    state.loadProviderScopedThinkingCatalogMock.mockImplementation(async (params: unknown) => {
      const { provider } = params as { provider?: string };
      if (provider !== "openai") {
        throw new Error(`unexpected scoped thinking hydration for ${provider}`);
      }
      return [structuredClone(nativeModel)];
    });
    state.resolveThinkingDefaultMock.mockImplementation((args: unknown) => {
      const { provider, catalog } = args as {
        provider?: string;
        catalog?: Array<{ provider: string; id: string }>;
      };
      if (provider === "gmn") {
        expect(catalog).toContainEqual(expect.objectContaining({ provider: "gmn", id: "gpt-5.4" }));
        return "xhigh";
      }
      return "ultra";
    });
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      await runInitialFallbackAttempt(params);
      const result = await runSubsequentFallbackAttempt(params, "gmn", "gpt-5.4", "unknown");
      return { result, provider: "gmn", model: "gpt-5.4", attempts: [] };
    });
    state.runAgentAttemptMock.mockImplementation(
      async ({
        executionSelection,
      }: Parameters<typeof import("./command/attempt-execution.js").runAgentAttempt>[0]) => {
        if (!isModelExecutionSelection(executionSelection)) {
          throw new Error("Expected a concrete fixture model");
        }
        return makeSuccessResult(executionSelection.model.provider, executionSelection.model.id);
      },
    );

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.runAgentAttemptMock, 0), {
      executionSelection: expect.objectContaining({
        model: expect.objectContaining({ id: "gpt-5.6-sol" }),
      }),
      resolvedThinkLevel: "ultra",
    });
    expectRecordFields(mockCallArg(state.runAgentAttemptMock, 1), {
      executionSelection: expect.objectContaining({
        model: expect.objectContaining({ provider: "gmn", id: "gpt-5.4" }),
      }),
      resolvedThinkLevel: "xhigh",
    });
    expect(state.loadProviderScopedThinkingCatalogMock).toHaveBeenCalledTimes(2);
    for (const [scope] of state.loadProviderScopedThinkingCatalogMock.mock.calls) {
      expectRecordFields(scope, {
        provider: "openai",
        model: "gpt-5.6-sol",
        agentRuntime: "codex",
      });
    }
  });

  registerAgentCommandRecoveryCases(getAgentCommandRecoveryFixture);

  it("records generated-media delivery runs as durable terminal sources", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    setupBareStoredSession();
    state.deliverAgentCommandResultMock.mockImplementation(async (params: unknown) => {
      const onDeliveryResult = (params as { onDeliveryResult?: (result: unknown) => void })
        .onDeliveryResult;
      const deliveryResult = {
        payloads: [{ isReasoning: true }, { text: "ready", mediaUrls: ["/tmp/payload.png"] }],
        meta: {},
        deliverySucceeded: true,
        deliveryStatus: {
          status: "partial_failed",
          payloadOutcomes: [
            { index: 0, status: "suppressed" },
            { index: 1, status: "failed", sentBeforeError: false },
          ],
        },
        messagingToolSentTargets: [
          {
            provider: "discord",
            to: "discord:dm:123",
            threadId: 42,
            mediaUrls: ["/tmp/proof.png"],
          },
        ],
      };
      onDeliveryResult?.(deliveryResult);
      return deliveryResult;
    });

    await agentCommand({
      message: "generated image ready",
      channel: "discord",
      to: "discord:dm:123",
      deliver: false,
      runId: "image:task-1:agent-loop",
      sourceReplyDeliveryMode: "automatic",
      disableMessageTool: true,
      forceRestartSafeTools: true,
      internalDeliveryMediaUrls: ["/tmp/payload.png"],
      inputProvenance: {
        kind: "inter_session",
        sourceChannel: "internal",
        sourceTool: "image_generate",
      },
    });

    const persistedSourceRunIds = state.persistSessionEntryMock.mock.calls.map((call) => {
      const params = call[0] as { entry?: SessionEntry };
      return params.entry?.restartRecoveryDeliverySourceRunId;
    });
    expect(persistedSourceRunIds).toContain("image:task-1:agent-loop");
    expect(
      state.persistSessionEntryMock.mock.calls.some((call) => {
        const params = call[0] as { entry?: SessionEntry };
        return params.entry?.restartRecoverySourceReplyDeliveryMode === "automatic";
      }),
    ).toBe(true);
    const cleanupParams = state.persistSessionEntryMock.mock.calls.at(-1)?.[0] as
      | { sessionStore?: Record<string, SessionEntry> }
      | undefined;
    const stored = cleanupParams?.sessionStore?.["agent:main:main"];
    expect(stored?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(stored?.restartRecoverySourceReplyDeliveryMode).toBeUndefined();
    expect(stored?.restartRecoveryTerminalRunIds).toEqual(["image:task-1:agent-loop"]);
    expect(stored?.restartRecoveryTerminalDeliveryEvidence).toEqual([
      {
        runId: "image:task-1:agent-loop",
        transcriptRunId: "image:task-1:agent-loop",
        captured: true,
        payloads: [{ visible: false }, { mediaUrls: ["/tmp/payload.png"], visible: true }],
        deliveryStatus: {
          status: "partial_failed",
          payloadOutcomes: [
            { index: 0, status: "suppressed" },
            { index: 1, status: "failed", sentBeforeError: false },
          ],
        },
        messagingToolSentTargets: [
          {
            provider: "discord",
            to: "discord:dm:123",
            threadId: "42",
            mediaUrls: ["/tmp/proof.png"],
            visible: true,
          },
        ],
        restartUnsafeSideEffectsDetected: true,
      },
    ]);
  });

  it("does not make an unconstrained message-tool completion replayable", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    setupBareStoredSession();

    await agentCommand({
      message: "generated image ready",
      sessionKey: "agent:main:main",
      deliver: false,
      runId: "image:unsafe-message-tool:agent-loop",
      sourceReplyDeliveryMode: "message_tool_only",
      inputProvenance: {
        kind: "inter_session",
        sourceChannel: "internal",
        sourceTool: "image_generate",
      },
    });

    expect(
      state.persistSessionEntryMock.mock.calls.some((call) => {
        const params = call[0] as { entry?: SessionEntry };
        return params.entry?.restartRecoveryDeliverySourceRunId !== undefined;
      }),
    ).toBe(false);
  });

  it("constrains recovery delivery to host-owned media before persistence and send", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue({
      ...makeSuccessResult("openai", "gpt-5.4"),
      payloads: [{ text: "ready", mediaUrls: ["/tmp/already-delivered.png"] }],
    });

    await agentCommand({
      message: "deliver only missing generated media",
      channel: "discord",
      to: "channel:123",
      deliver: true,
      sourceReplyDeliveryMode: "automatic",
      disableMessageTool: true,
      forceRestartSafeTools: true,
      internalDeliveryMediaUrls: ["/tmp/missing.png"],
      runId: "image:task-policy:agent-loop",
      inputProvenance: {
        kind: "inter_session",
        sourceChannel: "internal",
        sourceTool: "image_generate",
      },
    });

    const deliveryParams = requireRecord(
      mockCallArg(state.deliverAgentCommandResultMock),
      "delivery params",
    );
    const expectedRecoveryPayloads = [
      {
        text: "ready",
        mediaUrl: "/tmp/missing.png",
        mediaUrls: ["/tmp/missing.png"],
        audioAsVoice: undefined,
        trustedLocalMedia: true,
      },
    ];
    expect(requireRecord(deliveryParams.result, "delivery result").payloads).toEqual(
      expectedRecoveryPayloads,
    );
    expect(deliveryParams.payloads).toEqual(expectedRecoveryPayloads);
    expect(
      state.persistSessionEntryMock.mock.calls.some((call) => {
        const params = call[0] as { entry?: SessionEntry };
        return (
          params.entry?.restartRecoveryDeliveryMediaUrls?.[0] === "/tmp/missing.png" &&
          params.entry.restartRecoveryDisableMessageTool === true &&
          params.entry.restartRecoveryForceSafeTools === true
        );
      }),
    ).toBe(true);
  });

  it("restores the exact generated-media policy for a preclaimed recovery run", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue({
      ...makeSuccessResult("openai", "gpt-5.4"),
      payloads: [{ text: "ready", mediaUrls: ["/tmp/model-selected.png"] }],
    });
    setupBareStoredSession({
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "image:task-policy:agent-loop",
      restartRecoveryDeliveryContext: { channel: "discord", to: "channel:123" },
      restartRecoveryDeliveryMediaUrls: ["/tmp/missing.png"],
      restartRecoveryDisableMessageTool: true,
      restartRecoverySuppressTextDelivery: true,
      restartRecoverySourceReplyDeliveryMode: "automatic",
      restartRecoveryForceSafeTools: true,
    });

    await agentCommand({
      message: "continue generated media delivery",
      sessionKey: "agent:main:main",
      channel: "discord",
      to: "channel:123",
      deliver: true,
      runId: "recovery-run",
    });

    const deliveryParams = requireRecord(
      mockCallArg(state.deliverAgentCommandResultMock),
      "delivery params",
    );
    expect(requireRecord(deliveryParams.result, "delivery result").payloads).toEqual([
      { mediaUrls: ["/tmp/missing.png"], trustedLocalMedia: true },
    ]);
    const persistedPolicies = state.persistSessionEntryMock.mock.calls.map((call) => {
      const params = call[0] as { entry?: SessionEntry };
      return {
        mediaUrls: params.entry?.restartRecoveryDeliveryMediaUrls,
        disableMessageTool: params.entry?.restartRecoveryDisableMessageTool,
        forceSafeTools: params.entry?.restartRecoveryForceSafeTools,
        suppressText: params.entry?.restartRecoverySuppressTextDelivery,
      };
    });
    expect(persistedPolicies).toContainEqual({
      mediaUrls: undefined,
      disableMessageTool: undefined,
      forceSafeTools: undefined,
      suppressText: undefined,
    });
  });

  it("rejects host-owned media constraints without the scoped recovery policy", async () => {
    await expect(
      agentCommand({
        message: "unsafe delivery constraint",
        sessionKey: "agent:main:main",
        internalDeliveryMediaUrls: ["/tmp/proof.png"],
      }),
    ).rejects.toThrow(
      "internal delivery media constraints require automatic delivery with restart-safe tools and no message tool",
    );

    expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
  });

  it("clears the recovery cycle when a preclaimed transcript-only recovery run completes", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    setupBareStoredSession({
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "control-ui-run",
      restartRecoveryRuns: [
        { runId: "older-recovery", lifecycleGeneration: "pre-restart" },
        { runId: "recovery-run", lifecycleGeneration: "test-generation" },
      ],
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 5,
        chargedAttempts: 2,
      },
    });

    await agentCommand({
      message: "continue after restart",
      sessionKey: "agent:main:main",
      deliver: false,
      runId: "recovery-run",
      preserveUserFacingSessionModelState: true,
    });

    const persistedClaims = state.persistSessionEntryMock.mock.calls.map((call) => {
      const params = call[0] as { entry?: SessionEntry };
      return {
        context: params.entry?.restartRecoveryDeliveryContext,
        runId: params.entry?.restartRecoveryDeliveryRunId,
        sourceRunId: params.entry?.restartRecoveryDeliverySourceRunId,
      };
    });
    expect(persistedClaims).toContainEqual({
      context: undefined,
      runId: "recovery-run",
      sourceRunId: "control-ui-run",
    });
    expect(persistedClaims.at(-1)).toEqual({
      context: undefined,
      runId: undefined,
      sourceRunId: undefined,
    });
    const cleanupParams = state.persistSessionEntryMock.mock.calls.at(-1)?.[0] as
      | {
          sessionStore?: Record<string, SessionEntry>;
        }
      | undefined;
    const stored = cleanupParams?.sessionStore?.["agent:main:main"];
    expect(stored?.restartRecoveryDeliveryContext).toBeUndefined();
    expect(stored?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(stored?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(stored?.restartRecoveryTerminalRunIds).toEqual(["control-ui-run", "recovery-run"]);
    expect(stored?.restartRecoveryRuns).toBeUndefined();
    expect(
      (stored as SessionEntry & { mainRestartRecovery?: unknown }).mainRestartRecovery,
    ).toBeUndefined();
  });

  it("uses freshly committed routing facts for delivery", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    const { store } = setupBareStoredSession();
    let deliveredRoute: ReturnType<typeof deliveryContextFromSession>;
    state.deliverAgentCommandResultMock.mockImplementation(
      async (
        params: Parameters<typeof import("./command/delivery.js").deliverAgentCommandResult>[0],
      ) => {
        const current = expectDefined(store["agent:main:main"], "current command session");
        const freshEntry = createCommandSessionEntry({
          ...current,
          updatedAt: current.updatedAt + 1,
          delivery: normalizeSessionDeliveryState({
            context: {
              channel: "discord",
              to: "discord:dm:sqlite",
              accountId: "main",
            },
          }),
        });
        await state.persistSessionEntryMock({
          sessionStore: store,
          sessionKey: "agent:main:main",
          storePath: "/tmp/openclaw-sessions.json",
          initialEntry: current,
          entry: freshEntry,
        });
        deliveredRoute = deliveryContextFromSession(
          await params.resolveFreshSessionEntryForDelivery?.(),
        );
        return { deliverySucceeded: true };
      },
    );

    await runDiscordDelivery();

    expect(deliveredRoute).toEqual({
      channel: "discord",
      to: "discord:dm:sqlite",
      accountId: "main",
    });
  });

  it("preserves parsed explicit target threads for restart recovery", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    setupBareStoredSession();
    state.deliverAgentCommandResultMock.mockResolvedValue({ deliverySucceeded: true });
    state.resolveAgentDeliveryPlanMock.mockReturnValueOnce({
      baseDelivery: {
        mode: "explicit",
        threadId: "thread-1",
        threadIdSource: "explicit",
      },
      resolvedChannel: "discord",
      resolvedTo: "discord:channel:general",
      resolvedAccountId: "main",
      resolvedThreadId: "thread-1",
      deliveryTargetMode: "explicit",
    });

    await runDiscordDelivery({ to: "discord:channel:general/thread:thread-1" });

    const persistedContexts = state.persistSessionEntryMock.mock.calls.map((call) => {
      const params = call[0] as { entry?: SessionEntry };
      return params.entry?.restartRecoveryDeliveryContext;
    });
    expect(persistedContexts).toContainEqual({
      channel: "discord",
      to: "discord:channel:general",
      accountId: "main",
      threadId: "thread-1",
    });
  });

  it("does not inherit a stale thread when restart recovery uses an explicit target", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    setupBareStoredSession({
      lastThreadId: "stale-thread",
    });
    state.deliverAgentCommandResultMock.mockResolvedValue({ deliverySucceeded: true });

    await runDiscordDelivery();

    const persistedContexts = state.persistSessionEntryMock.mock.calls.map((call) => {
      const params = call[0] as { entry?: SessionEntry };
      return params.entry?.restartRecoveryDeliveryContext;
    });
    expect(persistedContexts).toContainEqual({
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
    });
  });

  it("persists implicit session delivery route for restart recovery", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    setupBareStoredSession({
      delivery: normalizeSessionDeliveryState({
        context: {
          channel: "discord",
          to: "discord:channel:general",
          accountId: "main",
          threadId: "thread-1",
        },
      }),
    });
    state.deliverAgentCommandResultMock.mockResolvedValue({ deliverySucceeded: true });

    await agentCommand({
      message: "hello",
      sessionKey: "agent:main:main",
      deliver: true,
    });

    const persistedContexts = state.persistSessionEntryMock.mock.calls.map((call) => {
      const params = call[0] as { entry?: SessionEntry };
      return params.entry?.restartRecoveryDeliveryContext;
    });
    expect(persistedContexts).toContainEqual({
      channel: "discord",
      to: "discord:channel:general",
      accountId: "main",
      threadId: "thread-1",
    });
    expect(state.resolveAgentDeliveryPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        explicitTo: undefined,
        requestedChannel: undefined,
        sessionEntry: expect.objectContaining({
          delivery: expect.objectContaining({
            context: expect.objectContaining({ to: "discord:channel:general" }),
          }),
        }),
        wantsDelivery: true,
      }),
    );
  });

  it("persists default target delivery route for restart recovery", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    setupBareStoredSession();
    state.deliverAgentCommandResultMock.mockResolvedValue({ deliverySucceeded: true });
    state.resolveMessageChannelSelectionMock.mockResolvedValue({
      channel: "discord",
      configured: ["discord"],
      source: "single-configured",
    });
    state.resolveAgentOutboundTargetMock.mockReturnValue({
      resolvedTarget: { ok: true, to: "discord:channel:default" },
      resolvedTo: "discord:channel:default",
      targetMode: "implicit",
    });

    await agentCommand({
      message: "hello",
      sessionKey: "agent:main:main",
      deliver: true,
    });

    const persistedContexts = state.persistSessionEntryMock.mock.calls.map((call) => {
      const params = call[0] as { entry?: SessionEntry };
      return params.entry?.restartRecoveryDeliveryContext;
    });
    expect(persistedContexts).toContainEqual({
      channel: "discord",
      to: "discord:channel:default",
    });
  });

  it("does not overwrite another active run's restart recovery context", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeEmptyResult("openai", "gpt-5.4"));
    const staleEntry = createCommandSessionEntry();
    const laterRunEntry = createCommandSessionEntry({
      updatedAt: 2,
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "discord:dm:456",
        accountId: "main",
      },
      restartRecoveryDeliveryRunId: "later-run",
      restartRecoveryRuns: [{ runId: "later-run", lifecycleGeneration: "later-generation" }],
      mainRestartRecovery: {
        cycleId: "later-cycle",
        revision: 1,
        chargedAttempts: 0,
      },
    });
    const sessionStore = { "agent:main:main": laterRunEntry };
    state.sessionEntryMock = staleEntry;
    state.sessionStoreMock = sessionStore;
    state.storePathMock = "/tmp/openclaw-sessions.json";

    await runDiscordDelivery({ sessionKey: "agent:main:main", runId: "stale-run" });

    expect(sessionStore["agent:main:main"]?.restartRecoveryDeliveryContext).toEqual(
      laterRunEntry.restartRecoveryDeliveryContext,
    );
    expect(sessionStore["agent:main:main"]?.restartRecoveryDeliveryRunId).toBe("later-run");
    expect(sessionStore["agent:main:main"]?.restartRecoveryRuns).toEqual(
      laterRunEntry.restartRecoveryRuns,
    );
    expect(sessionStore["agent:main:main"]?.mainRestartRecovery).toEqual(
      laterRunEntry.mainRestartRecovery,
    );
  });

  it("preserves a newly marked recovery cycle when restart wins the cleanup race", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    const { store: sessionStore } = setupBareStoredSession();
    const nextRecoveryRuns = [{ runId: "session-1", lifecycleGeneration: "next-generation" }];
    const nextRecoveryCycle = {
      cycleId: "next-cycle",
      revision: 1,
      chargedAttempts: 0,
    };
    state.deliverAgentCommandResultMock.mockImplementation(async () => {
      const current = sessionStore["agent:main:main"] as
        | (SessionEntry & { mainRestartRecovery?: typeof nextRecoveryCycle })
        | undefined;
      if (current) {
        current.abortedLastRun = true;
        current.restartRecoveryRuns = nextRecoveryRuns;
        current.mainRestartRecovery = nextRecoveryCycle;
      }
      return { deliverySucceeded: false };
    });

    await runDiscordDelivery();

    expect(sessionStore["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(sessionStore["agent:main:main"]?.restartRecoveryRuns).toEqual(nextRecoveryRuns);
    expect(
      (
        sessionStore["agent:main:main"] as SessionEntry & {
          mainRestartRecovery?: typeof nextRecoveryCycle;
        }
      ).mainRestartRecovery,
    ).toEqual(nextRecoveryCycle);
    expect(state.persistSessionEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          restartRecoveryDeliveryContext: {
            channel: "discord",
            to: "discord:dm:123",
            accountId: "main",
          },
          restartRecoveryDeliveryRunId: "session-1",
        }),
      }),
    );
  });

  it("does not recreate a deleted session entry during restart recovery cleanup", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeEmptyResult("openai", "gpt-5.4"));
    const { store: sessionStore } = setupBareStoredSession();
    state.deliverAgentCommandResultMock.mockImplementation(async () => {
      delete sessionStore["agent:main:main"];
      return { deliverySucceeded: true };
    });

    await runDiscordDelivery();

    expect(sessionStore["agent:main:main"]).toBeUndefined();
  });

  it("does not clear restart recovery context from a rotated session entry", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeEmptyResult("openai", "gpt-5.4"));
    const { store: sessionStore } = setupBareStoredSession();
    const rotatedEntry = createCommandSessionEntry({
      sessionId: "session-2",
      updatedAt: 2,
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "discord:dm:456",
        accountId: "main",
      },
    });
    state.deliverAgentCommandResultMock.mockImplementation(async () => {
      sessionStore["agent:main:main"] = rotatedEntry;
      return { deliverySucceeded: true };
    });

    await runDiscordDelivery();

    expect(sessionStore["agent:main:main"]).toEqual(rotatedEntry);
  });

  it("does not clear restart recovery context from another active run in the same session", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeEmptyResult("openai", "gpt-5.4"));
    const { store: sessionStore } = setupBareStoredSession();
    const laterRunEntry = createCommandSessionEntry({
      updatedAt: 2,
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "discord:dm:456",
        accountId: "main",
      },
      restartRecoveryDeliveryRunId: "later-run",
    });
    state.deliverAgentCommandResultMock.mockImplementation(async () => {
      sessionStore["agent:main:main"] = laterRunEntry;
      return { deliverySucceeded: false };
    });

    await runDiscordDelivery();

    expect(sessionStore["agent:main:main"]).toEqual(laterRunEntry);
  });

  it("stores and delivers with the prepared canonical current-run target", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    setupBareStoredSession();
    state.deliverAgentCommandResultMock.mockResolvedValue({ deliverySucceeded: false });
    state.resolveAgentDeliveryPlanWithSessionRouteMock.mockResolvedValueOnce({
      baseDelivery: {},
      resolvedChannel: "discord",
      resolvedTo: "channel:1524410080953634829",
      resolvedAccountId: "main",
      deliveryTargetMode: "explicit",
    });

    await runDiscordDelivery({ to: "channel:general" });

    const pendingEntries = state.persistSessionEntryMock.mock.calls
      .map((call) => (call[0] as { entry?: SessionEntry }).entry)
      .filter((entry): entry is SessionEntry => entry?.pendingFinalDelivery !== undefined);
    expect(pendingEntries).toContainEqual(
      expect.objectContaining({
        pendingFinalDelivery: expect.objectContaining({
          kind: "replayable",
          text: "ok",
          context: {
            channel: "discord",
            to: "channel:1524410080953634829",
            accountId: "main",
          },
        }),
      }),
    );
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: expect.objectContaining({
          replyChannel: "discord",
          replyTo: "channel:1524410080953634829",
          replyAccountId: "main",
          deliveryTargetMode: "explicit",
        }),
      }),
    );
  });

  it("rejects a strict delivery target before the model run", async () => {
    setupSingleAttemptFallback();
    const targetError = new Error('Unknown Discord target "channel:missing"');
    state.resolveAgentDeliveryPlanWithSessionRouteMock.mockResolvedValueOnce({
      baseDelivery: {},
      resolvedChannel: "discord",
      resolvedTo: "channel:missing",
      deliveryTargetMode: "explicit",
      targetResolutionError: targetError,
    });

    await expect(
      agentCommand({
        message: "hello",
        channel: "discord",
        to: "channel:missing",
        deliver: true,
      }),
    ).rejects.toBe(targetError);

    expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
    expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
  });

  it("preserves rejected best-effort delivery intent through the model run", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    setupBareStoredSession();
    state.resolveAgentDeliveryPlanWithSessionRouteMock.mockResolvedValueOnce({
      baseDelivery: {},
      resolvedChannel: "discord",
      resolvedTo: "channel:missing",
      deliveryTargetMode: "explicit",
      targetResolutionError: new Error('Unknown Discord target "channel:missing"'),
    });

    await expect(
      agentCommand({
        message: "hello",
        channel: "discord",
        to: "channel:missing",
        deliver: true,
        bestEffortDeliver: true,
      }),
    ).resolves.toMatchObject({ payloads: [{ text: "ok" }] });

    expect(state.runAgentAttemptMock).toHaveBeenCalled();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ opts: expect.objectContaining({ deliver: true }) }),
    );
    const pendingEntries = state.persistSessionEntryMock.mock.calls
      .map((call) => (call[0] as { entry?: SessionEntry }).entry)
      .filter((entry): entry is SessionEntry => entry?.pendingFinalDelivery !== undefined);
    expect(pendingEntries).toEqual([]);
  });

  it("clears a pre-existing transport-only pending delivery after an empty delivered run", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeEmptyResult("openai", "gpt-5.4"));
    setupBareStoredSession({
      pendingFinalDelivery: {
        kind: "transport-only",
        createdAt: 2,
        context: { channel: "tui" },
        intentId: "intent-1",
      },
    });
    await agentCommand({
      message: "hello",
      channel: "whatsapp",
      to: "+1234567890",
      deliver: true,
    });

    expect(state.persistSessionEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ pendingFinalDelivery: undefined }),
      }),
    );
  });

  it("uses the session routing token instead of a persisted transcript marker for visible attempts", async () => {
    setupSingleAttemptFallback();
    const visibleEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      sessionFile: "sqlite:default:session-1:/tmp/openclaw-session-store.json",
    };
    const sessionStore: Record<string, SessionEntry> = { "agent:main:main": visibleEntry };
    state.sessionEntryMock = visibleEntry;
    state.sessionStoreMock = sessionStore;
    state.storePathMock = "/tmp/openclaw-session-store.json";
    const attemptCalls: Array<{ sessionFile?: string; sessionEntry?: SessionEntry }> = [];
    state.runAgentAttemptMock.mockImplementation(async (params) => {
      attemptCalls.push(params as { sessionFile?: string; sessionEntry?: SessionEntry });
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await agentCommand({
      message: "visible run",
      to: "+1234567890",
    });

    expect(attemptCalls).toHaveLength(1);
    expect(attemptCalls[0]?.sessionFile).toBe("agent:main:main");
  });

  it("keeps internal session-effect CLI runs out of visible session state", async () => {
    setupSingleAttemptFallback();
    const visibleEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      sessionFile: "/tmp/session.jsonl",
      executionSelection: acceptedModelSelection("anthropic", "claude"),
      skillsSnapshot: { prompt: "visible", skills: [{ name: "existing" }], version: 1 },
    };
    const sessionStore: Record<string, SessionEntry> = { "agent:main:main": visibleEntry };
    state.sessionEntryMock = visibleEntry;
    state.sessionStoreMock = sessionStore;
    state.storePathMock = "/tmp/openclaw-session-store.json";
    state.loadSessionEntryMock.mockReturnValue(visibleEntry);
    const attemptCalls: Array<{ sessionFile?: string; sessionEntry?: SessionEntry }> = [];
    state.runAgentAttemptMock.mockImplementation(async (params) => {
      attemptCalls.push(params as { sessionFile?: string; sessionEntry?: SessionEntry });
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await agentCommand({
      message: "internal resume",
      to: "+1234567890",
      sessionEffects: "internal",
      suppressPromptPersistence: true,
    });

    expect(state.prepareInternalSessionEffectsSessionMock).toHaveBeenCalledWith({
      agentId: "default",
      cwd: "/tmp/workspace",
      runId: "session-1",
      source: {
        agentId: "default",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: "/tmp/openclaw-session-store.json",
      },
      storePath: "/tmp/openclaw-session-store.json",
    });
    expect(attemptCalls).toHaveLength(1);
    expect(attemptCalls[0]?.sessionFile).toBe(
      "sqlite:default:internal-session:/tmp/openclaw-session-store.json",
    );
    expect(attemptCalls[0]?.sessionEntry).toStrictEqual(visibleEntry);
    expect(state.trajectoryRecorderParamsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: "sqlite:default:internal-session:/tmp/openclaw-session-store.json",
      }),
    );
    expect(state.persistSessionEntryMock).not.toHaveBeenCalled();
    expect(state.updateSessionStoreAfterAgentRunMock).not.toHaveBeenCalled();
    expect(sessionStore["agent:main:main"]).toBe(visibleEntry);
    expect(state.registerAgentRunContextMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sessionKey: "agent:main:main",
        sessionId: "session-1",
        isControlUiVisible: false,
      }),
    );
    expect(state.applySessionEntryLifecycleMutationMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "rejects session-id-resolved model runs for harness-owned sessions",
      sessionKey: "agent:main:harness:codex:supervision:native-thread",
    },
    {
      name: "rejects one-shot model runs for locked harness sessions with ordinary keys",
      sessionKey: "agent:main:plugin-owned",
    },
  ])("$name", async ({ sessionKey }) => {
    state.resolvedSessionKeyMock = sessionKey;
    state.sessionEntryMock = createCommandSessionEntry({
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    });

    await expect(
      agentCommand({
        message: "probe",
        sessionId: "session-1",
        modelRun: true,
        promptMode: "none",
        sessionEffects: "internal",
      }),
    ).rejects.toThrow("Agent harness-owned sessions cannot be used for one-shot model runs.");
    expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
  });

  it("continues a grandfathered unlocked harness-prefixed session as an ordinary run", async () => {
    setupSingleAttemptFallback();
    state.resolvedSessionKeyMock = "agent:main:harness:notes";
    state.sessionEntryMock = {
      agentHarnessId: "codex",
      modelSelectionLocked: false,
      sessionId: "session-1",
      sessionFile: "/tmp/legacy-session.jsonl",
      updatedAt: 1,
    };
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude"));

    await runBasicAgentCommand();

    expect(state.runAgentAttemptMock).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      executionSelection: expect.objectContaining({
        executor: expect.objectContaining({ id: "openclaw" }),
      }),
      sessionEntry: expect.objectContaining({
        agentHarnessId: "codex",
        modelSelectionLocked: false,
        sessionId: "session-1",
      }),
    });
  });

  it("rejects a locked harness row with the wrong owner before transcript or model work", async () => {
    state.resolvedSessionKeyMock = "agent:main:harness:codex:supervision:native-thread";
    state.sessionEntryMock = {
      agentHarnessId: "other",
      modelSelectionLocked: true,
      sessionId: "session-1",
      sessionFile: "/tmp/native-session.jsonl",
      updatedAt: 1,
    };

    await expect(agentCommand({ message: "continue", sessionId: "session-1" })).rejects.toThrow(
      "Session key namespace is reserved for agent harness-owned sessions.",
    );
    expect(state.prepareInternalSessionEffectsSessionMock).not.toHaveBeenCalled();
    expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
  });

  it("removes the one-shot internal model-run SQLite session after success", async () => {
    setupSingleAttemptFallback();
    const result = makeSuccessResult("openai", "gpt-5.4");
    state.runAgentAttemptMock.mockImplementationOnce(
      async (
        params: Parameters<typeof import("./command/attempt-execution.js").runAgentAttempt>[0],
      ) => {
        const target = expectDefined(params.sessionTarget, "internal model-run target");
        params.onCompactionAccounting?.({
          kind: "durable",
          count: 0,
          target: {
            ...target,
            sessionId: "rotated-model-run-session",
            lifecycleRevision: undefined,
            activeWriterRunId: undefined,
          },
        });
        return {
          ...result,
          meta: {
            ...result.meta,
            executionTrace: {
              runner: "embedded",
              fallbackUsed: false,
              winnerProvider: "openai",
              winnerModel: "gpt-5.4",
            },
            finalAssistantVisibleText: "ok",
            agentMeta: {
              provider: "openai",
              model: "gpt-5.4",
              sessionId: "rotated-model-run-session",
              sessionFile:
                "sqlite:default:rotated-model-run-session:/tmp/openclaw-session-store.json",
            },
          },
        };
      },
    );

    const cleanupStarted = createDeferred();
    const releaseCleanup = createDeferred();
    state.applySessionEntryLifecycleMutationMock.mockImplementationOnce(async () => {
      cleanupStarted.resolve();
      await releaseCleanup.promise;
    });
    let settled = false;
    const pending = runInternalModelCommand("model-run-success").finally(() => {
      settled = true;
    });
    try {
      await Promise.race([cleanupStarted.promise, pending]);
      expect(settled).toBe(false);
    } finally {
      releaseCleanup.resolve();
      await pending;
    }

    expect(state.createTrajectoryRuntimeRecorderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: "sqlite:default:internal-session:/tmp/openclaw-session-store.json",
      }),
    );
    expect(state.persistCliTurnTranscriptMock).not.toHaveBeenCalled();
    expect(state.applySessionEntryLifecycleMutationMock).toHaveBeenCalledWith({
      agentId: "default",
      storePath: "/tmp/openclaw-session-store.json",
      removals: [
        {
          sessionKey: "agent:default:internal-session-effects:run",
          expectedSessionId: "rotated-model-run-session",
          archiveRemovedTranscript: false,
        },
      ],
      skipMaintenance: true,
    });
    const deliveryOrder = state.deliverAgentCommandResultMock.mock.invocationCallOrder[0] ?? 0;
    const cleanupOrder =
      state.applySessionEntryLifecycleMutationMock.mock.invocationCallOrder[0] ?? 0;
    expect(deliveryOrder).toBeLessThan(cleanupOrder);
  });

  it("removes the one-shot internal model-run SQLite session after provider failure", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockRejectedValueOnce(new Error("probe failed"));

    await expect(runInternalModelCommand("model-run-failure")).rejects.toThrow("probe failed");

    expect(state.applySessionEntryLifecycleMutationMock).toHaveBeenCalledWith({
      agentId: "default",
      storePath: "/tmp/openclaw-session-store.json",
      removals: [
        {
          sessionKey: "agent:default:internal-session-effects:run",
          expectedSessionId: "internal-session",
          archiveRemovedTranscript: false,
        },
      ],
      skipMaintenance: true,
    });
  });

  it("cleans the deterministic model-run session when preparation fails", async () => {
    state.storePathMock = "/tmp/openclaw-session-store.json";
    state.loadSessionEntryMock.mockReturnValue({ sessionId: "session-1", updatedAt: 1 });
    state.prepareInternalSessionEffectsSessionMock.mockRejectedValueOnce(
      new Error("session preparation failed"),
    );

    await expect(runInternalModelCommand("model-run-prepare-failure")).rejects.toThrow(
      "session preparation failed",
    );

    const target = resolveInternalSessionEffectsTarget({
      agentId: "default",
      runId: "model-run-prepare-failure",
      storePath: "/tmp/openclaw-session-store.json",
    });
    expect(state.applySessionEntryLifecycleMutationMock).toHaveBeenCalledWith({
      agentId: target.agentId,
      storePath: target.storePath,
      removals: [
        {
          sessionKey: target.sessionKey,
          expectedSessionId: target.sessionId,
          archiveRemovedTranscript: false,
        },
      ],
      skipMaintenance: true,
    });
  });

  it("does not replace a completed model-run result with a SQLite cleanup failure", async () => {
    setupSingleAttemptFallback();
    state.storePathMock = "/tmp/openclaw-session-store.json";
    state.loadSessionEntryMock.mockReturnValue({ sessionId: "session-1", updatedAt: 1 });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    state.applySessionEntryLifecycleMutationMock.mockRejectedValue(new Error("database is locked"));

    await expect(runInternalModelCommand("model-run-cleanup-failure")).resolves.toMatchObject({
      payloads: [{ text: "ok" }],
    });

    expect(state.applySessionEntryLifecycleMutationMock).toHaveBeenCalled();
  });

  it("does not duplicate finishing lifecycle when an attempt already emitted finishing", async () => {
    setupModelSwitchRetry({
      provider: "openai",
      model: "gpt-5.4",
    });
    state.runAgentAttemptMock.mockImplementation(async (attemptParams: unknown) => {
      state.emitAgentEventMock({
        runId: "run-live-switch",
        stream: "lifecycle",
        data: { phase: "finishing" },
      });
      (attemptParams as { onAgentEvent?: (evt: unknown) => void }).onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: "finishing" },
      });
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await runBasicAgentCommand();

    const lifecycleFinishingCalls = state.emitAgentEventMock.mock.calls.filter(
      (call: unknown[]) => {
        const arg = call[0] as { stream?: string; data?: { phase?: string } };
        return arg?.stream === "lifecycle" && arg?.data?.phase === "finishing";
      },
    );
    expect(lifecycleFinishingCalls).toHaveLength(1);
  });

  it("forwards harness-augmented GPT-5.6 thinking capability to the attempt", async () => {
    const modelId = "gpt-5.6-sol";
    const modelKey = `openai/${modelId}`;
    const providerReasoningEfforts = ["low", "medium", "high", "xhigh", "max"];
    const harnessReasoningEfforts = [...providerReasoningEfforts, "ultra"];
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: { primary: modelKey },
          models: { [modelKey]: { agentRuntime: { id: "codex" } } },
        },
      },
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    };
    state.loadManifestModelCatalogMock.mockReturnValue([
      {
        provider: "openai",
        id: modelId,
        name: modelId,
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        compat: {
          thinkingFormat: "openai",
          supportedReasoningEfforts: providerReasoningEfforts,
        },
      },
    ]);
    state.loadProviderScopedThinkingCatalogMock.mockResolvedValue([
      {
        provider: "openai",
        id: modelId,
        name: modelId,
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        reasoning: true,
        compat: {
          thinkingFormat: "openai",
          supportedReasoningEfforts: harnessReasoningEfforts,
        },
      },
    ]);
    setupSuccessfulAttempt("openai", modelId);

    await agentCommand({ message: "hello", to: "+1234567890", thinking: "ultra" });

    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      executionSelection: expect.objectContaining({
        model: expect.objectContaining({ id: modelId }),
      }),
      resolvedThinkLevel: "ultra",
      modelThinkingCapability: {
        provider: "openai",
        modelId,
        agentRuntime: "codex",
        compat: {
          thinkingFormat: "openai",
          supportedReasoningEfforts: harnessReasoningEfforts,
        },
      },
    });
  });

  it.each([
    {
      name: "validates explicit thinking against configured model compat without an allowlist",
      allowlisted: false,
      excluded: false,
    },
    {
      name: "validates explicit thinking against allowlisted configured model compat when manifest catalog is empty",
      allowlisted: true,
      excluded: false,
    },
    {
      name: "retains automatic-primary thinking metadata outside the manual allowlist",
      allowlisted: true,
      excluded: true,
    },
  ])("$name", async ({ allowlisted, excluded }) => {
    if (excluded) {
      const policyModule = await import("./model-visibility-policy.js");
      const { createModelVisibilityPolicyWithFallbacks } =
        await import("./model-selection-shared.js");
      vi.spyOn(policyModule, "createModelVisibilityPolicy").mockImplementation((params) =>
        createModelVisibilityPolicyWithFallbacks({ ...params, fallbackModels: [] }),
      );
    }
    state.runtimeConfigMock = createConfiguredModelCompatRuntimeConfig(allowlisted, excluded);
    if (allowlisted) {
      state.loadManifestModelCatalogMock.mockReturnValue([]);
    }
    setupSuccessfulAttempt("gmn", "gpt-5.4");

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      thinking: "xhigh",
    });

    if (allowlisted) {
      expect(state.loadManifestModelCatalogMock).toHaveBeenCalledTimes(1);
      expect(state.loadManifestModelCatalogMock).toHaveBeenCalledWith(
        expect.objectContaining({ metadataSnapshot: manifestMetadataSnapshot }),
      );
    }
    const thinkingArgs = requireRecord(
      mockCallArg(state.isThinkingLevelSupportedMock),
      "thinking args",
    );
    expect(thinkingArgs.provider).toBe("gmn");
    expect(thinkingArgs.model).toBe("gpt-5.4");
    expect(thinkingArgs.level).toBe("xhigh");
    const catalog = requireArray(thinkingArgs.catalog, "thinking catalog");
    expectRecordFields(catalog[0], {
      provider: "gmn",
      id: "gpt-5.4",
      compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
    });
  });

  it("hydrates live catalog metadata before validating an explicit thinking level", async () => {
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          thinkingDefault: "low",
          model: { primary: "openai/gpt-5.4" },
          models: {
            "openai/*": {},
            "ollama/*": {},
          },
        },
      },
    };
    state.loadManifestModelCatalogMock.mockReturnValue([]);
    state.loadPreparedModelCatalogSnapshotMock.mockResolvedValue({
      entries: [
        {
          provider: "OLLAMA",
          id: "minimax-m3:cloud",
          name: "minimax-m3:cloud",
          reasoning: true,
        },
      ],
      routeVariants: [],
    });
    state.isThinkingLevelSupportedMock.mockImplementation((args: unknown) => {
      const { catalog, level } = args as {
        catalog?: Array<{ reasoning?: boolean }>;
        level?: string;
      };
      return level === "off" || catalog?.some((entry) => entry.reasoning === true) === true;
    });
    setupSuccessfulAttempt("ollama", "minimax-m3:cloud");

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      model: "ollama/minimax-m3:cloud",
      thinking: "medium",
      allowModelOverride: true,
    });

    expect(state.loadProviderScopedThinkingCatalogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: state.runtimeConfigMock,
        provider: "ollama",
        model: "minimax-m3:cloud",
        agentId: "default",
        workspaceDir: "/tmp/workspace",
      }),
    );
    const thinkingArgs = requireRecord(
      mockCallArg(state.isThinkingLevelSupportedMock),
      "thinking args",
    );
    expect(thinkingArgs.level).toBe("medium");
    expect(thinkingArgs.catalog).toEqual([
      expect.objectContaining({
        provider: "ollama",
        id: "minimax-m3:cloud",
        reasoning: true,
      }),
    ]);
  });

  it("does not hydrate live catalog metadata when the selected model config disables thinking", async () => {
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {
            "openai/*": {},
            "ollama/minimax-m3:cloud": {
              params: { thinking: "off" },
            },
          },
        },
      },
    };
    state.loadManifestModelCatalogMock.mockReturnValue([]);
    setupSuccessfulAttempt("ollama", "minimax-m3:cloud");

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      model: "ollama/minimax-m3:cloud",
      allowModelOverride: true,
    });

    expect(state.loadPreparedModelCatalogSnapshotMock).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(state.runAgentAttemptMock), {
      executionSelection: expect.objectContaining({
        model: expect.objectContaining({ id: "minimax-m3:cloud" }),
      }),
      resolvedThinkLevel: "off",
    });
  });

  it("resolves explicit model aliases before thinking validation", async () => {
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {
            "openai/*": {},
            "codex/gpt-5.5": {
              alias: "code",
            },
          },
        },
      },
      models: {
        providers: {
          codex: {
            models: [
              {
                id: "gpt-5.5",
                name: "GPT 5.5 Codex",
                reasoning: true,
                compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
              },
            ],
          },
        },
      },
    };
    state.loadManifestModelCatalogMock.mockReturnValue([]);
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      const result = await runInitialFallbackAttempt(params);
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("codex", "gpt-5.5"));

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      model: "code",
      thinking: "xhigh",
      allowModelOverride: true,
    });

    const fallbackParams = mockCallArg(state.runWithModelFallbackMock) as FallbackRunnerParams;
    expect(fallbackParams.provider).toBe("codex");
    expect(fallbackParams.model).toBe("gpt-5.5");
    const thinkingArgs = requireRecord(
      mockCallArg(state.isThinkingLevelSupportedMock),
      "thinking args",
    );
    expect(thinkingArgs.provider).toBe("codex");
    expect(thinkingArgs.model).toBe("gpt-5.5");
    expect(thinkingArgs.level).toBe("xhigh");
  });

  it("keeps an accepted exact route ahead of a colliding model alias", async () => {
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude" },
          models: {
            "anthropic/claude": {},
            "cloudflare-ai-gateway/gemini-2.5-flash-lite": {},
            "google/gemini-2.5-flash-lite": { alias: "gemini-2.5-flash-lite" },
          },
        },
      },
    };
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      executionSelection: acceptedModelSelection("cloudflare-ai-gateway", "gemini-2.5-flash-lite", {
        fallbackPermission: "configured",
      }),
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    state.sessionEntryMock = sessionEntry;
    state.sessionStoreMock = { "agent:main:main": sessionEntry };
    setupSuccessfulAttempt("cloudflare-ai-gateway", "gemini-2.5-flash-lite");

    await runBasicAgentCommand();

    expectRecordFields(mockCallArg(state.runWithModelFallbackMock), {
      provider: "cloudflare-ai-gateway",
      model: "gemini-2.5-flash-lite",
      requestedRouteResolution: "resolved",
    });
  });

  it("records fallback steps to the session trajectory runtime", async () => {
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      await params.onFallbackStep?.({
        fallbackStepType: "fallback_step",
        fallbackStepFromModel: "ollama/llama3",
        fallbackStepToModel: "openai/gpt-5.4",
        fallbackStepFromFailureReason: "overloaded",
        fallbackStepChainPosition: 1,
        fallbackStepFinalOutcome: "next_fallback",
      });
      const result = await runInitialFallbackAttempt(params);
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await runBasicAgentCommand();

    expect(state.trajectoryRecordEventMock).toHaveBeenCalledTimes(1);
    expect(mockCallArg(state.trajectoryRecordEventMock, 0, 0)).toBe("model.fallback_step");
    expectRecordFields(mockCallArg(state.trajectoryRecordEventMock, 0, 1), {
      fallbackStepType: "fallback_step",
      fallbackStepFromModel: "ollama/llama3",
      fallbackStepToModel: "openai/gpt-5.4",
      fallbackStepFromFailureReason: "overloaded",
      fallbackStepChainPosition: 1,
      fallbackStepFinalOutcome: "next_fallback",
    });
    expect(state.trajectoryFlushMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses duplicate user persistence only after the current turn has flushed", async () => {
    type AttemptCall = {
      onUserMessagePersisted?: () => void;
      suppressPromptPersistenceOnRetry?: boolean;
    };
    const attemptCalls: AttemptCall[] = [];
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      const first = await runInitialFallbackAttempt(params);
      const result = await runSubsequentFallbackAttempt(
        params,
        params.provider,
        params.model,
        "unknown",
      );
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [first],
      };
    });
    state.runAgentAttemptMock.mockImplementation(async (attemptParams: AttemptCall) => {
      const firstAttempt = attemptCalls.length === 0;
      attemptCalls.push(attemptParams);
      if (firstAttempt) {
        if (!attemptParams.onUserMessagePersisted) {
          throw new Error("expected retry persistence callback on first attempt");
        }
        attemptParams.onUserMessagePersisted();
      } else {
        attemptParams.onUserMessagePersisted?.();
      }
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await runBasicAgentCommand();

    expect(attemptCalls).toHaveLength(2);
    expect(attemptCalls[0]?.suppressPromptPersistenceOnRetry).not.toBe(true);
    expect(attemptCalls[1]?.suppressPromptPersistenceOnRetry).toBe(true);
  });

  it("keeps a hook-blocked user turn suppressed across model fallback", async () => {
    type AttemptCall = {
      suppressPromptPersistenceOnRetry?: boolean;
      userTurnTranscriptRecorder?: {
        markBlocked: () => void;
      };
    };
    const attemptCalls: AttemptCall[] = [];
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      const first = await runInitialFallbackAttempt(params);
      const result = await runSubsequentFallbackAttempt(
        params,
        params.provider,
        params.model,
        "unknown",
      );
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [first],
      };
    });
    state.runAgentAttemptMock.mockImplementation(async (attemptParams: AttemptCall) => {
      attemptCalls.push(attemptParams);
      if (attemptCalls.length === 1) {
        attemptParams.userTurnTranscriptRecorder?.markBlocked();
      }
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await runBasicAgentCommand();

    expect(attemptCalls).toHaveLength(2);
    expect(attemptCalls[1]?.userTurnTranscriptRecorder).toBe(
      attemptCalls[0]?.userTurnTranscriptRecorder,
    );
    expect(attemptCalls[0]?.suppressPromptPersistenceOnRetry).toBe(false);
    expect(attemptCalls[1]?.suppressPromptPersistenceOnRetry).toBe(true);
  });

  it("suppresses prompt persistence for internal handoffs on every fallback attempt", async () => {
    type AttemptCall = {
      suppressPromptPersistenceOnRetry?: boolean;
    };
    const attemptCalls: AttemptCall[] = [];
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      const first = await runInitialFallbackAttempt(params);
      const result = await runSubsequentFallbackAttempt(
        params,
        params.provider,
        params.model,
        "unknown",
      );
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [first],
      };
    });
    state.runAgentAttemptMock.mockImplementation(async (attemptParams: AttemptCall) => {
      attemptCalls.push(attemptParams);
      const result = makeSuccessResult("openai", "gpt-5.4") as ReturnType<
        typeof makeSuccessResult
      > & {
        meta: Record<string, unknown> & { executionTrace?: Record<string, unknown> };
      };
      result.meta.executionTrace = {
        runner: "cli",
        fallbackUsed: false,
        winnerProvider: "openai",
        winnerModel: "gpt-5.4",
      };
      return result;
    });

    await agentCommand({
      message: "internal handoff",
      to: "+1234567890",
      suppressPromptPersistence: true,
    });

    expect(attemptCalls).toHaveLength(2);
    expect(attemptCalls[0]?.suppressPromptPersistenceOnRetry).toBe(true);
    expect(attemptCalls[1]?.suppressPromptPersistenceOnRetry).toBe(true);
    expectRecordFields(mockCallArg(state.persistCliTurnTranscriptMock), {
      skipUserTurn: true,
    });
  });

  it("preserves an explicit empty transcript message as user-turn omission", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await agentCommand({
      message: "synthetic announce prompt",
      transcriptMessage: "",
      to: "+1234567890",
    });

    const attempt = mockCallArg(state.runAgentAttemptMock) as {
      suppressPromptPersistenceOnRetry?: boolean;
      userTurnTranscriptRecorder?: { message?: unknown };
    };
    expect(attempt.suppressPromptPersistenceOnRetry).toBe(true);
    expect(attempt.userTurnTranscriptRecorder?.message).toBeUndefined();
  });

  it("uses a tracker-only recorder for text plus image turns", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await agentCommand({
      message: "inspect this image",
      transcriptMessage: "canonical image caption",
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      to: "+1234567890",
    });

    const attempt = mockCallArg(state.runAgentAttemptMock) as {
      transcriptBody?: string;
      suppressPromptPersistenceOnRetry?: boolean;
      userTurnTranscriptRecorder?: { message?: unknown };
    };
    expect(attempt.transcriptBody).toBe("canonical image caption");
    expect(attempt.suppressPromptPersistenceOnRetry).toBe(false);
    expect(attempt.userTurnTranscriptRecorder?.message).toMatchObject({
      role: "user",
      content: "canonical image caption",
    });
  });

  it("persists structured transcript media without a caption", async () => {
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await agentCommand({
      message: "[media attached: media://inbound/image-1]",
      transcriptMessage: "",
      transcriptMedia: [{ path: "/media/inbound/image-1.png", contentType: "image/png" }],
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      to: "+1234567890",
    });

    const attempt = mockCallArg(state.runAgentAttemptMock) as {
      suppressPromptPersistenceOnRetry?: boolean;
      userTurnTranscriptRecorder?: { message?: unknown };
    };
    expect(attempt.suppressPromptPersistenceOnRetry).toBe(false);
    expect(attempt.userTurnTranscriptRecorder?.message).toMatchObject({
      role: "user",
      content: "",
      __openclaw: {
        media: [
          expect.objectContaining({ path: "/media/inbound/image-1.png", contentType: "image/png" }),
        ],
      },
    });
  });

  it("propagates non-switch errors without retrying and emits lifecycle error", async () => {
    state.runWithModelFallbackMock.mockRejectedValueOnce(new Error("provider down"));

    await expect(
      agentCommand({
        message: "hello",
        to: "+1234567890",
      }),
    ).rejects.toThrow("provider down");

    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(1);

    const lifecycleErrorCalls = state.emitAgentEventMock.mock.calls.filter((call: unknown[]) => {
      const arg = call[0] as { stream?: string; data?: { phase?: string } };
      return arg?.stream === "lifecycle" && arg?.data?.phase === "error";
    });
    expect(lifecycleErrorCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("marks lifecycle errors aborted when cancellation reaches post-turn handling", async () => {
    const abortController = new AbortController();
    state.runWithModelFallbackMock.mockImplementationOnce(async () => {
      abortController.abort();
      throw new Error("request aborted");
    });

    await expect(
      agentCommand({
        message: "hello",
        to: "+1234567890",
        abortSignal: abortController.signal,
      }),
    ).rejects.toThrow("request aborted");

    expect(
      state.emitAgentEventMock.mock.calls.some(([event]) => {
        const candidate = event as {
          stream?: string;
          data?: { phase?: string; aborted?: boolean };
        };
        return (
          candidate.stream === "lifecycle" &&
          candidate.data?.phase === "error" &&
          candidate.data.aborted === true
        );
      }),
    ).toBe(true);
  });

  it("marks direct active-run cancellation aborted without a caller signal", async () => {
    state.runWithModelFallbackMock.mockRejectedValueOnce(createAgentRunDirectAbortError());

    await expect(
      agentCommand({
        message: "hello",
        to: "+1234567890",
      }),
    ).rejects.toThrow("agent run aborted");

    expect(
      state.emitAgentEventMock.mock.calls.some(([event]) => {
        const candidate = event as {
          stream?: string;
          data?: { phase?: string; aborted?: boolean; stopReason?: string };
        };
        return (
          candidate.stream === "lifecycle" &&
          candidate.data?.phase === "error" &&
          candidate.data.aborted === true &&
          candidate.data.stopReason === "aborted"
        );
      }),
    ).toBe(true);
  });

  it("propagates authProfileId from the switch error to the retried session entry", async () => {
    let capturedAuthProfileProvider: string | undefined;
    setupModelSwitchRetry({
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "profile-openai-prod",
      authProfileIdSource: "user",
    });

    state.runAgentAttemptMock.mockImplementation(async (...args: unknown[]) => {
      const attemptParams = args[0] as { authProfileProvider?: string } | undefined;
      capturedAuthProfileProvider = attemptParams?.authProfileProvider;
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await runBasicAgentCommand();

    expect(capturedAuthProfileProvider).toBe("openai");
    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(2);
  });

  it("does not persist a user live switch as an auto fallback probe result", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      executionSelection: acceptedModelSelection("anthropic", "claude", {
        fallbackPermission: "configured",
      }),
      fallbackNotice: {
        kind: "active",
        selectedModel: "anthropic/claude",
        activeModel: "openai/claude",
      },
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    state.sessionEntryMock = sessionEntry;
    const sessionStore: Record<string, SessionEntry> = { "agent:main:main": sessionEntry };
    state.sessionStoreMock = sessionStore;
    state.storePathMock = "/tmp/openclaw-session-store.json";
    setupModelSwitchRetry({
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "openai:primary",
      authProfileIdSource: "user",
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await runBasicAgentCommand();

    expect(sessionStore["agent:main:main"]?.executionSelection).toEqual({
      state: "accepted",
      selection: {
        executor: { kind: "harness", id: "openclaw" },
        model: { provider: "openai", id: "gpt-5.4" },
      },
      fallbackPermission: "explicit",
    });
    expectRecordFields(mockCallArg(state.updateSessionStoreAfterAgentRunMock), {
      fallbackProvider: "openai",
      fallbackModel: "gpt-5.4",
    });
  });

  it("does not overwrite a concurrent user model switch after a primary probe", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      executionSelection: acceptedModelSelection("anthropic", "claude", {
        fallbackPermission: "configured",
      }),
      fallbackNotice: {
        kind: "active",
        selectedModel: "anthropic/claude",
        activeModel: "openai/claude",
      },
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    };
    state.sessionEntryMock = sessionEntry;
    const sessionStore: Record<string, SessionEntry> = { "agent:main:main": sessionEntry };
    state.sessionStoreMock = sessionStore;
    state.storePathMock = "/tmp/openclaw-session-store.json";
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await runInitialFallbackAttempt(params);
      const current = sessionStore["agent:main:main"];
      const next = { ...current };
      commitSessionExecutionSelection(
        next,
        {
          executor: { kind: "harness", id: "openclaw" },
          model: { provider: "google", id: "gemini-3-pro" },
        },
        { cause: { kind: "user" } },
      );
      await state.persistSessionEntryMock({
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: state.storePathMock,
        initialEntry: current,
        entry: next,
      });
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude"));

    await runBasicAgentCommand();

    expect(sessionStore["agent:main:main"]?.executionSelection).toEqual({
      state: "accepted",
      selection: {
        executor: { kind: "harness", id: "openclaw" },
        model: { provider: "google", id: "gemini-3-pro" },
      },
      fallbackPermission: "explicit",
    });
  });

  it("keeps accepted intent when a temporary fallback completes after the session becomes locked", async () => {
    const { entry } = setupStoredSession({
      executionSelection: acceptedModelSelection("anthropic", "claude", {
        fallbackPermission: "configured",
      }),
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    });
    const accepted = structuredClone(entry.executionSelection);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await runSubsequentFallbackAttempt(params, "openai", "claude", "unknown");
      entry.modelSelectionLocked = true;
      return { result, provider: "openai", model: "claude", attempts: [] };
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "claude"));

    await runBasicAgentCommand();

    expect(entry.executionSelection).toEqual(accepted);
    expect(entry.modelSelectionLocked).toBe(true);
  });

  it.each([
    { source: "user" as const, profileProvider: "openai", preserve: true },
    { source: "auto" as const, profileProvider: "openai", preserve: false },
    { source: "user" as const, profileProvider: "anthropic", preserve: false },
  ])(
    "handles removed $source $profileProvider selections without replacing explicit same-provider intent",
    async ({ source, profileProvider, preserve }) => {
      const profileId = `${profileProvider}:selected`;
      state.sessionEntryMock = createCommandSessionEntry({
        sessionId: "session-1",
        updatedAt: Date.now(),
        executionSelection: acceptedModelSelection("openai", "gpt-future", {
          fallbackPermission: source === "user" ? "explicit" : "configured",
        }),
        authProfileOverride: profileId,
        authProfileOverrideSource: source,
        skillsSnapshot: { prompt: "", skills: [], version: 0 },
      });
      state.runtimeConfigMock = {
        agents: { defaults: { models: { "openai/gpt-future": {} } } },
      };
      setupSingleAttemptFallback();
      state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-future"));
      state.authProfileStoreMock = {
        profiles: { [profileId]: { type: "api_key", provider: profileProvider, key: "synthetic" } },
      };
      await runBasicAgentCommand();
      if (profileProvider === "openai") {
        expect(state.clearSessionAuthProfileOverrideMock).not.toHaveBeenCalled();
      }
      state.clearSessionAuthProfileOverrideMock.mockClear();
      state.authProfileStoreMock = { profiles: {} };

      await runBasicAgentCommand();

      expect(state.clearSessionAuthProfileOverrideMock).toHaveBeenCalledTimes(preserve ? 0 : 1);
      const { ensureAuthProfileStore } = await import("./auth-profiles/store-runtime.js");
      expect(ensureAuthProfileStore).toHaveBeenCalledWith(
        "/tmp/agent",
        expect.objectContaining({ profileId, allowKeychainPrompt: false }),
      );
    },
  );

  it("keeps aliased session auth profiles for codex-cli runs", async () => {
    const registry = expectDefined(getActivePluginRegistry(), "fixture registry");
    registry.cliBackends.push({
      pluginId: "fixture-cli",
      source: "test",
      backend: { id: "codex-cli", modelProvider: "openai", config: { command: "fixture-cli" } },
    });
    let capturedAuthProfileProvider: string | undefined;
    const sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      executionSelection: acceptedModelSelection("openai", "gpt-5.4", {
        executor: { kind: "cli", id: "codex-cli" },
      }),
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
    } satisfies SessionEntry;
    state.sessionEntryMock = sessionEntry;
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": {},
          },
        },
      },
    };
    state.authProfileStoreMock = {
      profiles: {
        "openai:work": createApiKeyCredential("codex-cli", "sk-test"),
      },
    };
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      const result = await runInitialFallbackAttempt(params);
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockImplementation(async (...args: unknown[]) => {
      const attemptParams = args[0] as { authProfileProvider?: string } | undefined;
      capturedAuthProfileProvider = attemptParams?.authProfileProvider;
      return makeSuccessResult("openai", "gpt-5.4");
    });

    await runBasicAgentCommand();

    expect(capturedAuthProfileProvider).toBe("openai");
    expect(state.runWithModelFallbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ userLockedAuthProfileId: "openai:work" }),
    );
    expect(state.clearSessionAuthProfileOverrideMock).not.toHaveBeenCalled();
  });

  it("hydrates stripped persisted skill snapshots before running the CLI path", async () => {
    const persistedSnapshot = {
      prompt: "persisted prompt",
      skills: [{ name: "cli-skill" }],
      skillFilter: ["cli-skill"],
      version: 0,
    };
    const rebuiltSkills = [
      {
        name: "cli-skill",
        description: "CLI skill",
        filePath: "/tmp/workspace/skills/cli-skill/SKILL.md",
        baseDir: "/tmp/workspace/skills/cli-skill",
        source: "# CLI skill",
      },
    ];
    state.sessionEntryMock = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      skillsSnapshot: persistedSnapshot,
    };
    state.buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "rebuilt prompt",
      skills: [{ name: "different-skill" }],
      resolvedSkills: rebuiltSkills,
      version: 99,
    });
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      const result = await runInitialFallbackAttempt(params);
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude"));

    await runBasicAgentCommand();

    const attemptParams = mockCallArg(state.runAgentAttemptMock) as {
      skillsSnapshot?: Record<string, unknown>;
    };
    expectRecordFields(attemptParams?.skillsSnapshot, {
      prompt: "persisted prompt",
      skills: [{ name: "cli-skill" }],
      skillFilter: ["cli-skill"],
      version: 0,
      resolvedSkills: rebuiltSkills,
    });
    expect(state.buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("classifies empty embedded run results before model fallback accepts them", async () => {
    let observedClassification: unknown;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      const primaryResult = await runInitialFallbackAttempt(params);
      observedClassification = await params.classifyResult?.({
        provider: params.provider,
        model: params.model,
        result: primaryResult,
        attempt: 1,
        total: 2,
      });
      const fallbackResult = await runSubsequentFallbackAttempt(
        params,
        "openai",
        "gpt-5.4",
        "format",
      );
      return {
        result: fallbackResult,
        provider: "openai",
        model: "gpt-5.4",
        attempts: [
          {
            provider: params.provider,
            model: params.model,
            error: "empty result",
            reason: "format",
            code: "empty_result",
          },
        ],
      };
    });
    state.runAgentAttemptMock
      .mockResolvedValueOnce(makeEmptyResult("anthropic", "claude"))
      .mockResolvedValueOnce(makeSuccessResult("openai", "gpt-5.4"));

    await runBasicAgentCommand();

    expectRecordFields(observedClassification, {
      reason: "format",
      code: "empty_result",
    });
    expect(state.runAgentAttemptMock).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(state.runAgentAttemptMock, 1), {
      executionSelection: expect.objectContaining({
        model: expect.objectContaining({ provider: "openai", id: "gpt-5.4" }),
      }),
      isFallbackRetry: true,
    });
    const deliveryParams = requireRecord(
      mockCallArg(state.deliverAgentCommandResultMock),
      "delivery params",
    );
    const result = requireRecord(deliveryParams.result, "delivery result");
    const meta = requireRecord(result.meta, "delivery result meta");
    const agentMeta = requireRecord(meta.agentMeta, "delivery agent meta");
    const fallbackAttempts = requireArray(agentMeta.fallbackAttempts, "fallback attempts");
    expectRecordFields(fallbackAttempts[0], {
      provider: "anthropic",
      model: "claude",
      reason: "format",
    });
  });

  it("emits a failure lifecycle after delivering a preserved exhausted result", async () => {
    const exhaustedResult = {
      payloads: [{ text: "Terminal tool summary", isError: true }],
      meta: {
        durationMs: 100,
        aborted: false,
        stopReason: "end_turn",
        error: {
          kind: "incomplete_turn",
          message: "All fallback candidates ended incomplete",
          fallbackSafe: true,
          terminalPresentation: true,
        },
        agentMeta: { provider: "anthropic", model: "claude" },
      },
    };
    state.runAgentAttemptMock.mockImplementationOnce(async (attemptParams: unknown) => {
      const params = attemptParams as {
        deferTerminalLifecycle?: boolean;
        onAgentEvent?: (event: { stream: string; data: Record<string, unknown> }) => void;
      };
      expect(params.deferTerminalLifecycle).toBe(true);
      params.onAgentEvent?.({
        stream: "lifecycle",
        data: {
          phase: "finishing",
          error: "All fallback candidates ended incomplete",
        },
      });
      return exhaustedResult;
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "exhausted",
      result: await runInitialFallbackAttempt(params, "anthropic", "claude"),
      provider: "anthropic",
      model: "claude",
      attempts: [
        {
          provider: "anthropic",
          model: "claude",
          error: "All fallback candidates ended incomplete",
          reason: "format",
        },
      ],
    }));

    const onModelFallbackExhausted = vi.fn();
    await agentCommand({
      message: "hello",
      to: "+1234567890",
      onModelFallbackExhausted,
    });

    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledTimes(1);
    expect(onModelFallbackExhausted).toHaveBeenCalledTimes(1);
    const lifecycleEvents = state.emitAgentEventMock.mock.calls
      .map((call) => call[0] as { stream?: string; data?: Record<string, unknown> })
      .filter((event) => event.stream === "lifecycle");
    expect(lifecycleEvents.some((event) => event.data?.phase === "finishing")).toBe(false);
    expect(lifecycleEvents.some((event) => event.data?.phase === "end")).toBe(false);
    expect(lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "error",
            error: "All fallback candidates ended incomplete",
            executionSettled: true,
          }),
        }),
      ]),
    );
  });

  it("emits a failure lifecycle for completed non-fallbackable error results", async () => {
    const terminalErrorResult = {
      payloads: [{ text: "Command may have changed state", isError: true }],
      meta: {
        durationMs: 100,
        aborted: false,
        stopReason: "end_turn",
        replayInvalid: true,
        error: {
          kind: "incomplete_turn",
          message: "raw provider detail should stay private",
          fallbackSafe: false,
        },
        agentMeta: { provider: "anthropic", model: "claude" },
      },
    };
    state.runAgentAttemptMock.mockImplementationOnce(async (attemptParams: unknown) => {
      const params = attemptParams as {
        onAgentEvent?: (event: { stream: string; data: Record<string, unknown> }) => void;
      };
      params.onAgentEvent?.({
        stream: "lifecycle",
        data: {
          phase: "finishing",
          error: "Command may have changed state",
          replayInvalid: true,
        },
      });
      return terminalErrorResult;
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await runInitialFallbackAttempt(params, "anthropic", "claude"),
      provider: "anthropic",
      model: "claude",
      attempts: [],
    }));

    const onResultErrorPayload = vi.fn();
    await agentCommand({
      message: "hello",
      to: "+1234567890",
      onResultErrorPayload,
    });

    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledTimes(1);
    expect(onResultErrorPayload).toHaveBeenCalledWith("Command may have changed state");
    const lifecycleEvents = state.emitAgentEventMock.mock.calls
      .map((call) => call[0] as { stream?: string; data?: Record<string, unknown> })
      .filter((event) => event.stream === "lifecycle");
    expect(lifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "error",
            error: "Command may have changed state",
            executionSettled: true,
            replayInvalid: true,
          }),
        }),
      ]),
    );
    expect(
      lifecycleEvents.some(
        (event) => event.data?.phase === "end" || event.data?.fallbackExhaustedFailure === true,
      ),
    ).toBe(false);
    expect(JSON.stringify(lifecycleEvents)).not.toContain("raw provider detail");
  });

  it("sends internal completion wakes to ACP sessions as plain prompt text", async () => {
    setupAcpSession();

    const internalEvents: AgentInternalEvent[] = [
      {
        type: "task_completion",
        source: "subagent",
        childSessionKey: "agent:main:subagent:child",
        childSessionId: "child-session-id",
        announceType: "subagent task",
        taskLabel: "inspect ACP delivery",
        status: "ok",
        statusLabel: "completed successfully",
        result: "child output",
        replyInstruction: "Summarize the result for the user.",
      },
    ];
    await agentCommand({
      message: formatAgentInternalEventsForPrompt(internalEvents),
      sessionKey: "agent:main:main",
      internalEvents,
    });

    expect(state.acpRunTurnMock).toHaveBeenCalledTimes(1);
    const runTurnParams = mockCallArg(state.acpRunTurnMock) as { text?: string };
    expect(runTurnParams.text).toContain("A background task completed.");
    expect(runTurnParams.text).toContain("inspect ACP delivery");
    expect(runTurnParams.text).toContain("child output");
    expect(runTurnParams.text).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
    expect(runTurnParams.text).not.toContain(INTERNAL_RUNTIME_CONTEXT_END);

    expect(state.persistAcpTurnTranscriptMock).toHaveBeenCalledTimes(1);
    const transcriptParams = mockCallArg(state.persistAcpTurnTranscriptMock) as {
      body?: string;
      transcriptBody?: string;
    };
    expect(transcriptParams.body).toBe(runTurnParams.text);
    expect(transcriptParams.transcriptBody).toContain("A background task completed.");
    expect(transcriptParams.transcriptBody).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
    expect(transcriptParams.transcriptBody).not.toContain(INTERNAL_RUNTIME_CONTEXT_END);
  });

  it("refuses a local installation target only when dispatching an ACP turn", async () => {
    setupAcpSession();
    await expect(
      withInstallationTarget(
        {
          stateDir: "/fixture/diagnosed",
          configPath: "/fixture/custom.json",
          defaultWorkspaceDir: "/fixture/default-workspace",
        },
        runBasicAgentCommand,
      ),
    ).rejects.toThrow("saved prompt");
    expect(state.acpRunTurnMock).not.toHaveBeenCalled();
    expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
    await runBasicAgentCommand();
    expect(state.acpRunTurnMock).toHaveBeenCalledOnce();
  });

  it("marks ACP execution start before prompt submission", async () => {
    setupAcpSession();
    const onExecutionStarted = vi.fn();
    state.acpRunTurnMock.mockImplementationOnce(async (params: unknown) => {
      const callbacks = params as {
        onBeforePrompt?: () => Promise<void> | void;
        onLifecycle?: (event: { type: string; at: number }) => void;
        onEvent?: (event: unknown) => void;
      };
      expect(onExecutionStarted).not.toHaveBeenCalled();
      await callbacks.onBeforePrompt?.();
      expect(onExecutionStarted).toHaveBeenCalledOnce();
      callbacks.onLifecycle?.({ type: "prompt_submitted", at: Date.now() });
      callbacks.onEvent?.({ type: "done", stopReason: "end_turn" });
    });

    await agentCommand({
      message: "ACP execution boundary",
      sessionKey: "agent:main:main",
      onExecutionStarted,
    });

    expect(onExecutionStarted).toHaveBeenCalledTimes(1);
  });

  it("rejects an ACP prompt before execution when its accepted input cannot enter the transcript", async () => {
    setupAcpSession();
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "accepted ACP input", idempotencyKey: "acp-input:user" },
      target: () => undefined,
    });
    const onExecutionStarted = vi.fn();
    const submitPrompt = vi.fn();
    state.acpRunTurnMock.mockImplementationOnce(async (params: unknown) => {
      const callbacks = params as { onBeforePrompt?: () => Promise<void> | void };
      await callbacks.onBeforePrompt?.();
      submitPrompt();
    });

    await expect(
      agentCommand({
        message: "accepted ACP input",
        sessionKey: "agent:main:main",
        userTurnTranscriptRecorder: recorder,
        onExecutionStarted,
      }),
    ).rejects.toThrow("ACP input could not enter the session transcript");

    expect(onExecutionStarted).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(state.persistAcpTurnTranscriptMock).not.toHaveBeenCalled();
  });

  it("keeps session provenance for internal ACP turns", async () => {
    setupAcpSession();

    await agentCommand({
      message: "internal ACP turn",
      sessionKey: "agent:main:main",
      sessionEffects: "internal",
    });

    expect(state.registerAgentRunContextMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        sessionId: "session-1",
        isControlUiVisible: false,
        projectSessionActive: false,
      }),
    );
  });

  it("allows manual ACP spawn turns when ACP dispatch is disabled", async () => {
    setupAcpSession();
    state.resolveAcpDispatchPolicyErrorMock.mockReturnValue(
      new Error("ACP dispatch is disabled by policy (`acp.dispatch.enabled=false`)."),
    );

    await agentCommand({
      message: "bootstrap ACP child",
      sessionKey: "agent:main:main",
      acpTurnSource: "manual_spawn",
    });

    expect(state.resolveAcpExplicitTurnPolicyErrorMock).toHaveBeenCalledTimes(1);
    expect(state.resolveAcpDispatchPolicyErrorMock).not.toHaveBeenCalled();
    expect(state.acpRunTurnMock).toHaveBeenCalledTimes(1);
  });

  it("keeps manual ACP elicitation owned by the child turn without channel delivery", async () => {
    setupAcpSession();
    const childSessionKey = "agent:codex:acp:child";
    state.resolvedSessionKeyMock = childSessionKey;
    let answerQuestion: ((value: unknown) => void) | undefined;
    let questionRequest:
      | { id: string; questions: Array<{ questionId: string }>; sessionKey?: string }
      | undefined;
    state.gatewayCallMock.mockImplementation(
      async (method: string, _opts: unknown, rawParams: unknown) => {
        const params = rawParams as { id: string; questions: Array<{ questionId: string }> };
        if (method === "question.request") {
          questionRequest = params;
          return { id: params.id };
        }
        if (method === "question.waitAnswer") {
          return await new Promise((resolve) => {
            answerQuestion = resolve;
          });
        }
        if (method === "question.resolve") {
          return { status: "cancelled" };
        }
        throw new Error(`unexpected Gateway question method: ${method}`);
      },
    );
    state.acpRunTurnMock.mockImplementationOnce(async (rawTurn: unknown) => {
      const turn = rawTurn as {
        onElicitation?: (
          request: Record<string, unknown>,
          context: { requestId: string; signal: AbortSignal },
        ) => Promise<{ action: string; content?: Record<string, unknown> }>;
        onEvent?: (event: unknown) => void;
      };
      expect(turn.onElicitation).toBeTypeOf("function");
      const response = turn.onElicitation!(
        {
          mode: "form",
          sessionId: "acp-session",
          message: "Choose a flavor",
          requestedSchema: {
            type: "object",
            properties: {
              flavor: { type: "string", enum: ["Vanilla", "Chocolate"] },
            },
            required: ["flavor"],
          },
        },
        { requestId: "elicitation-1", signal: new AbortController().signal },
      );
      await vi.waitFor(() =>
        expect(state.emitAcpRuntimeEventMock).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey: childSessionKey,
            event: expect.objectContaining({
              type: "status",
              text: expect.stringContaining("flavor"),
            }),
          }),
        ),
      );
      const questionId = expectDefined(
        questionRequest?.questions[0]?.questionId,
        "manual ACP question id",
      );
      answerQuestion?.({
        status: "answered",
        answers: { answers: { [questionId]: ["Vanilla"] } },
      });
      const resolved = await response;
      expect(resolved).toEqual({ action: "accept", content: { flavor: "Vanilla" } });
      turn.onEvent?.({ type: "text_delta", stream: "output", text: "FLAVOR:Vanilla" });
      turn.onEvent?.({ type: "done", stopReason: "end_turn" });
    });

    await agentCommand({
      message: "bootstrap ACP child",
      sessionKey: childSessionKey,
      acpTurnSource: "manual_spawn",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:parent",
        sourceTool: "sessions_spawn",
      },
    });

    expect(questionRequest).toMatchObject({ sessionKey: childSessionKey });
    expect(state.buildAcpResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ payloadText: "FLAVOR:Vanilla" }),
    );
  });

  it("keeps ordinary ACP turns blocked when ACP dispatch is disabled", async () => {
    setupAcpSession();
    state.resolveAcpDispatchPolicyErrorMock.mockReturnValue(
      new Error("ACP dispatch is disabled by policy (`acp.dispatch.enabled=false`)."),
    );

    await expect(
      agentCommand({
        message: "automatic ACP turn",
        sessionKey: "agent:main:main",
      }),
    ).rejects.toThrow("ACP dispatch is disabled");

    expect(state.resolveAcpExplicitTurnPolicyErrorMock).not.toHaveBeenCalled();
    expect(state.resolveAcpDispatchPolicyErrorMock).toHaveBeenCalledTimes(1);
    expect(state.acpRunTurnMock).not.toHaveBeenCalled();
    expect(state.emitAcpLifecycleErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ terminalOutcome: "blocked" }),
    );
  });

  it("preserves ACP cancelled results without a stop reason", async () => {
    setupAcpSession();
    state.resolveAcpLifecycleEndFieldsMock.mockReturnValueOnce({
      aborted: true,
      stopReason: "stop",
      status: "cancelled",
    });
    state.acpRunTurnMock.mockImplementationOnce(async (params: unknown) => {
      const onEvent = (params as { onEvent?: (event: unknown) => void }).onEvent;
      onEvent?.({ type: "done", status: "cancelled" });
    });

    await agentCommand({
      message: "cancelled ACP turn",
      sessionKey: "agent:main:main",
    });

    expect(state.emitAcpLifecycleEndMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endFields: { aborted: true, stopReason: "stop", status: "cancelled" },
      }),
    );
    expect(state.buildAcpResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ resultStatus: "cancelled", stopReason: undefined }),
    );
    const signal = requireRecord(mockCallArg(state.acpRunTurnMock), "ACP turn").signal;
    expect(signal).toHaveProperty("aborted", false);
    expect(mockCallArg(state.resolveAcpLifecycleEndFieldsMock)).toBe(signal);
    expect(state.resolveAcpLifecycleEndFieldsMock).toHaveBeenCalledWith(
      signal,
      undefined,
      "cancelled",
    );
    expect(state.persistAcpTurnTranscriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalOutcome: expect.objectContaining({ reason: "cancelled", status: "error" }),
      }),
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
