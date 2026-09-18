// Shared mocks and fixtures for agent-runner execution tests.
import path from "node:path";
import { afterEach, beforeEach, expect, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { DeferredEmbeddedRunLifecycleOwner } from "../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { FailoverError, type FallbackAttemptRecord } from "../../agents/failover-error.js";
import { AUTH_INVALID_TOKEN_USER_TEXT } from "../../agents/failover/user-copy.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { runWithModelFallback } from "../../agents/model-fallback-runner.js";
import { loadNativeHarnessFixture } from "../../agents/test-helpers/bundled-native-harness.test-support.js";
import { createSessionModelCatalogFixture } from "../../agents/test-helpers/session-model-catalog.test-support.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { commitSessionExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
import {
  isModelExecutionSelection,
  type ModelExecutionSelection,
} from "../../model-picker/execution-selection.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  requireActivePluginRegistry,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  createUserTurnTranscriptRecorder,
  type PersistedUserTurnMessage,
} from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
// Register mocks before fixture dependencies can load their production targets.
import { state, resetExecutionMocks } from "./agent-runner-execution-mocks.test-support.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import type { FollowupRun } from "./queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import type { TypingSignaler } from "./typing-mode.js";

type RunCliAgent = typeof import("../../agents/cli-runner.js").runCliAgent;

export const PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE = `⚠️ ${AUTH_INVALID_TOKEN_USER_TEXT}`;
export { createMockReplyOperation } from "./test-helpers.js";
export const PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE =
  "⚠️ The model provider returned HTTP 429 before replying. This can mean rate limiting, exhausted quota, or an account balance/billing issue. Check the selected provider/model, API key, and provider billing/quota dashboard, then try again.";
export const PROVIDER_INTERNAL_ERROR_USER_MESSAGE =
  "⚠️ The model provider returned a temporary internal error before replying. Try again in a moment, or switch to another model if it keeps happening.";

type TestFallbackAttempt = FallbackAttemptRecord & { authMode?: string };

export function createTestFallbackSummaryError(params: {
  message: string;
  attempts: TestFallbackAttempt[];
  soonestCooldownExpiry?: number | null;
  cause?: unknown;
}): FailoverError {
  const lastAttempt = params.attempts.at(-1);
  return new FailoverError(params.message, {
    reason: lastAttempt?.reason ?? "unknown",
    provider: lastAttempt?.provider,
    model: lastAttempt?.model,
    attempts: params.attempts,
    soonestCooldownExpiry: params.soonestCooldownExpiry ?? null,
    cause: params.cause,
  });
}

export const GENERIC_RUN_FAILURE_TEXT =
  "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";
export function makeTestModel(id: string, contextTokens: number): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextTokens,
    contextTokens,
    maxTokens: 4096,
  };
}

function publishTestExecutionCatalog(followupRun: FollowupRun): void {
  const fixture = executionFixtures.get(followupRun);
  if (!fixture) {
    throw new Error("The execution test must declare its catalog and accounts.");
  }
  const cfg = followupRun.run.config;
  const agentId = followupRun.run.agentId;
  followupRun.run.config = {
    ...cfg,
    agents: {
      ...cfg.agents,
      ...(fixture.fallbacks
        ? {
            defaults: {
              ...cfg.agents?.defaults,
              model: {
                ...(typeof cfg.agents?.defaults?.model === "object"
                  ? cfg.agents.defaults.model
                  : { primary: cfg.agents?.defaults?.model }),
                fallbacks: fixture.fallbacks,
              },
            },
          }
        : {}),
      entries: {
        ...cfg.agents?.entries,
        [agentId]: {
          ...cfg.agents?.entries?.[agentId],
          agentDir: followupRun.run.agentDir,
          workspace: followupRun.run.workspaceDir,
        },
      },
    },
  };
  publishedExecutionCatalog.publish({
    ...fixture,
    config: followupRun.run.config,
    agentId: followupRun.run.agentId,
  });
}

export async function getExecuteAgentTurnForTest() {
  const execute = (await import("./agent-runner-execution.js")).executeAgentTurn;
  return async (...args: Parameters<typeof execute>) => {
    publishTestExecutionCatalog(args[0].followupRun);
    const execution = await execute(...args);
    const outcome = execution.outcome;
    if (outcome.kind === "settled") {
      return {
        kind: "success" as const,
        runId: execution.runId,
        runResult: outcome.result,
        fallbackProvider: outcome.resolved.provider,
        fallbackModel: outcome.resolved.model,
        ...(outcome.fallback.exhausted ? { fallbackExhausted: true as const } : {}),
        fallbackAttempts: outcome.fallback.attempts,
        didLogHeartbeatStrip: outcome.didLogHeartbeatStrip,
        autoCompactionCount: outcome.autoCompactionCount,
        directlySentBlockKeys: outcome.directlySentBlockKeys,
        directBlockDeliveries: outcome.directBlockDeliveries,
        terminalFailurePayload: outcome.terminalFailurePayload,
        postCompactionModelFailure: outcome.postCompactionModelFailure,
      };
    }
    if (outcome.kind === "rejected") {
      return {
        kind: "final" as const,
        payload: outcome.payload,
        postCompactionModelFailure: outcome.postCompactionModelFailure,
      };
    }
    const payload: ReplyPayload = { text: "NO_REPLY" };
    return { kind: "final" as const, payload };
  };
}

export async function useProductionEmbeddedRunExecutionParamsForTest(): Promise<void> {
  const actual =
    await vi.importActual<typeof import("./agent-runner-utils.js")>("./agent-runner-utils.js");
  state.productionBuildEmbeddedRunExecutionParams = actual.buildEmbeddedRunExecutionParams;
}

export async function loadActualRunCliAgentForTest(): Promise<RunCliAgent> {
  return (
    await vi.importActual<typeof import("../../agents/cli-runner.js")>("../../agents/cli-runner.js")
  ).runCliAgent;
}

export type FallbackRunnerParams = Parameters<typeof runWithModelFallback<unknown>>[0];

export {
  fallbackModelAttemptOptions as fallbackAttemptOptions,
  initialModelFallbackAttemptOptions as initialFallbackAttemptOptions,
  runInitialModelFallbackAttempt as runInitialFallbackAttempt,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";

export type EmbeddedAgentParams = {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  prompt?: string;
  transcriptPrompt?: string;
  currentInboundContext?: RunEmbeddedAgentInternalParams["currentInboundContext"];
  lifecycleGeneration?: string;
  onDeferredLifecycleOwner?: (owner: DeferredEmbeddedRunLifecycleOwner) => void;
  onCompactionAccounting?: RunEmbeddedAgentInternalParams["onCompactionAccounting"];
  onExecutionStarted?: (info?: { lifecycleGeneration?: string }) => void;
  onExecutionPhase?: (info: {
    phase:
      | "runner_entered"
      | "workspace"
      | "runtime_plugins"
      | "before_agent_reply"
      | "model_resolution"
      | "auth"
      | "context_engine"
      | "attempt_dispatch"
      | "context_assembled"
      | "turn_accepted"
      | "process_spawned"
      | "tool_execution_started"
      | "assistant_output_started"
      | "model_call_started";
    provider?: string;
    model?: string;
    backend?: string;
    source?: string;
    tool?: string;
    toolCallId?: string;
    itemId?: string;
  }) => void;
  onLaneWait?: (info: { waitMs: number; queuedAhead: number; waiting?: boolean }) => void;
  onBlockReply?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  onAssistantMessageStart?: () => Promise<void> | void;
  onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  onAutoCompactionSucceeded?: (count: number) => void;
  onReasoningStream?: (payload: {
    text?: string;
    mediaUrls?: string[];
    isReasoningSnapshot?: boolean;
    requiresReasoningProgressOptIn?: boolean;
  }) => Promise<void> | void;
  onReasoningEnd?: () => Promise<void> | void;
  onItemEvent?: (payload: {
    itemId?: string;
    toolCallId?: string;
    kind?: string;
    title?: string;
    name?: string;
    phase?: string;
    status?: string;
    summary?: string;
    progressText?: string;
    approvalId?: string;
    approvalSlug?: string;
  }) => Promise<void> | void;
  onAgentEvent?: (payload: {
    stream: string;
    data: Record<string, unknown>;
    sessionKey?: string;
  }) => Promise<void> | void;
};

export function createMockTypingSignaler(): TypingSignaler {
  return {
    mode: "message",
    shouldStartImmediately: false,
    shouldStartOnMessageStart: true,
    shouldStartOnText: true,
    shouldStartOnReasoning: false,
    signalRunStart: vi.fn(async () => {}),
    signalMessageStart: vi.fn(async () => {}),
    signalTextDelta: vi.fn(async () => {}),
    signalReasoningDelta: vi.fn(async () => {}),
    signalToolStart: vi.fn(async () => {}),
    signalExecutionActivity: vi.fn(async () => {}),
  };
}

type ExecutionCatalogFixture = Pick<
  Parameters<ReturnType<typeof createSessionModelCatalogFixture>["publish"]>[0],
  "catalog" | "runtimeAuthModes"
> & { profiles: AuthProfileStore["profiles"]; fallbacks?: string[] };
const executionFixtures = new WeakMap<FollowupRun, ExecutionCatalogFixture>();
const publishedExecutionCatalog = createSessionModelCatalogFixture();

export function testModel(
  provider: string,
  id: string,
  facts: Omit<Partial<ModelCatalogEntry>, "provider" | "id"> = {},
): ModelCatalogEntry {
  return { provider, id, name: id, input: ["text"], ...facts };
}

export function testAuthProfiles(...providers: string[]): AuthProfileStore["profiles"] {
  return Object.fromEntries(
    providers.map((provider) => [
      provider + ":fixture",
      { type: "api_key" as const, provider, key: "synthetic-credential" },
    ]),
  );
}

export function configureTestExecution(
  followupRun: FollowupRun,
  fixture: {
    config?: OpenClawConfig;
    selection?: ModelExecutionSelection;
    fallbacks?: string[];
    catalog: ModelCatalogEntry[];
    profiles: AuthProfileStore["profiles"];
    runtimeAuthModes?: ExecutionCatalogFixture["runtimeAuthModes"];
  },
): void {
  if (fixture.config) {
    followupRun.run.config = fixture.config;
  }
  if (fixture.selection) {
    followupRun.run.executionSelection = fixture.selection;
  }
  executionFixtures.set(followupRun, {
    catalog: { entries: fixture.catalog, routeVariants: fixture.catalog },
    profiles: fixture.profiles,
    runtimeAuthModes: fixture.runtimeAuthModes,
    fallbacks: fixture.fallbacks,
  });
}

export async function configureTestNativeHarness() {
  const fixture = await loadNativeHarnessFixture();
  registerAgentHarness(fixture.harness);
  return fixture;
}

export function configureTestHarness(
  followupRun: FollowupRun,
  id: string,
  models: readonly { provider: string; id: string }[],
  fallbackModels: readonly { provider: string; id: string }[] = [],
): void {
  registerAgentHarness({
    id,
    label: "Execution test app",
    supports: ({ provider, modelId }) => {
      if (models.some((model) => model.provider === provider && model.id === modelId)) {
        return { supported: true };
      }
      const fallback = fallbackModels.find(
        (model) => model.provider === provider && model.id === modelId,
      );
      return {
        supported: false,
        reason: "This test app does not implement this route.",
        ...(fallback ? { fallbackRuntime: "openclaw" as const } : {}),
      };
    },
    runAttempt: async () => {
      throw new Error("This test observes the embedded runner boundary.");
    },
  });
  if (!isModelExecutionSelection(followupRun.run.executionSelection)) {
    throw new Error("Expected a concrete fixture selection.");
  }
  followupRun.run.executionSelection = {
    ...followupRun.run.executionSelection,
    executor: { kind: "harness", id },
  };
}

export function configureTestCliModel(
  followupRun: FollowupRun,
  provider: string,
  model: string,
  backendId = provider,
  modelProvider = provider,
): ModelExecutionSelection {
  const registry = requireActivePluginRegistry();
  setActivePluginRegistry({
    ...registry,
    cliBackends: [
      ...registry.cliBackends.filter(({ backend }) => backend.id !== backendId),
      {
        pluginId: "execution-test-cli",
        source: "test",
        backend: { id: backendId, modelProvider, config: { command: "test-cli" } },
      },
    ],
  });
  const cfg = followupRun.run.config;
  followupRun.run.config = {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models: {
          ...cfg.agents?.defaults?.models,
          [`${provider}/${model}`]: { agentRuntime: { id: backendId } },
        },
      },
    },
  };
  return { model: { provider, id: model }, executor: { kind: "cli", id: backendId } };
}

export function createFollowupRun(
  fixture?: Parameters<typeof configureTestExecution>[1],
): FollowupRun {
  const rootDir = useAutoCleanupTempDirTracker(onTestFinished).make("openclaw-agent-execution-");
  const followupRun: FollowupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: path.join(rootDir, "agent"),
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      sessionFile: path.join(rootDir, "session.jsonl"),
      workspaceDir: rootDir,
      config: {},
      skillsSnapshot: {},
      executionSelection: {
        model: { provider: "anthropic", id: "claude" },
        executor: { kind: "harness", id: "openclaw" },
      },

      // Missing fixture modalities trigger real provider catalog discovery during execution.
      thinkingCatalog: [
        { provider: "anthropic", id: "claude", input: ["text"] },
        { provider: "anthropic", id: "claude-opus-4-7", input: ["text", "image"] },
        { provider: "claude-cli", id: "sonnet-4.6", input: ["text", "image"] },
        { provider: "claude-cli", id: "claude-sonnet-4-6", input: ["text", "image"] },
        { provider: "claude-cli", id: "claude-opus-4-6", input: ["text", "image"] },
        { provider: "claude-cli", id: "claude-opus-4-7", input: ["text", "image"] },
        { provider: "claude-cli", id: "claude-opus-5", input: ["text", "image"] },
        { provider: "claude-cli", id: "claude-opus-4-8", input: ["text", "image"] },
        { provider: "codex-cli", id: "gpt-5.4", input: ["text", "image"] },
        { provider: "codex-cli", id: "gpt-5.5", input: ["text", "image"] },
      ],
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;
  const entry = testModel("anthropic", "claude");
  executionFixtures.set(followupRun, {
    catalog: { entries: [entry], routeVariants: [entry] },
    profiles: testAuthProfiles("anthropic"),
  });
  if (fixture) {
    configureTestExecution(followupRun, fixture);
  }
  return followupRun;
}

export function createTestUserTurnRecorder(message: PersistedUserTurnMessage) {
  return createUserTurnTranscriptRecorder({
    message,
    target: createTestUserTurnTranscriptTarget(),
    updateMode: "none",
  });
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

export function expectRecordFields(
  record: Record<string, unknown>,
  fields: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

export function requireMockCall(mock: unknown, index: number, label: string): unknown[] {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.[index];
  if (!call) {
    throw new Error(`missing ${label} call ${index + 1}`);
  }
  return call;
}

export function expectMockCallArgFields(
  mock: unknown,
  index: number,
  label: string,
  fields: Record<string, unknown>,
) {
  expectRecordFields(requireRecord(requireMockCall(mock, index, label)[0], label), fields);
}

export function expectNoMockCallWithFields(mock: unknown, fields: Record<string, unknown>) {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls ?? [];
  const hasMatchingCall = calls.some((call) => {
    const value = call[0];
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return Object.entries(fields).every(([key, expected]) => record[key] === expected);
  });
  expect(hasMatchingCall).toBe(false);
}

export function expectBlockReplyCall(
  onBlockReply: unknown,
  index: number,
  fields: Record<string, unknown>,
) {
  expectMockCallArgFields(onBlockReply, index, "block reply payload", fields);
}

/**
 * Session-store paths reach production resolution, which derives a real agent
 * SQLite file from the store's directory. A shared /tmp path would therefore
 * open the machine-wide agent database and make unrelated suites depend on it.
 */
export function makeTestSessionStorePath(): string {
  return path.join(
    useAutoCleanupTempDirTracker(onTestFinished).make("openclaw-agent-execution-store-"),
    "sessions.json",
  );
}

export function createAgentTurnExecutionDefaults() {
  return {
    blockReplyPipeline: null,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    applyReplyToMode: (payload) => payload,
    shouldEmitToolResult: () => true,
    shouldEmitToolOutput: () => false,
    pendingToolTasks: new Set<Promise<void>>(),
    resetSessionAfterRoleOrderingConflict: async () => false,
    isHeartbeat: false,
    sessionKey: "main",
    getActiveSessionEntry: () => undefined,
    resolvedVerboseLevel: "off",
  } satisfies Partial<AgentTurnParams>;
}

export function createLiveSwitchSession(followupRun: FollowupRun) {
  let entry: SessionEntry = {
    sessionId: followupRun.run.sessionId,
    updatedAt: 1,
    lifecycleRevision: "reply-fixture-generation",
    executionSelection: {
      state: "accepted",
      selection: followupRun.run.executionSelection,
      fallbackPermission: "configured",
    },
    authProfileOverride: followupRun.run.authProfileId,
    authProfileOverrideSource: followupRun.run.authProfileIdSource,
  };
  return {
    getActiveSessionEntry: () => entry,
    publish(error: LiveSessionModelSwitchError, cause: "user" | "reset" = "user") {
      const next = { ...entry };
      commitSessionExecutionSelection(next, error.selection, { cause: { kind: cause } });
      next.authProfileOverride = error.authProfileId;
      next.authProfileOverrideSource = error.authProfileId ? error.authProfileIdSource : undefined;
      next.authProfileOverrideCompactionCount = undefined;
      entry = next;
      return error;
    },
  };
}

export function createRunAgentTurnParams(followupRun: FollowupRun): AgentTurnParams {
  publishTestExecutionCatalog(followupRun);
  return {
    commandBody: "hello",
    followupRun,
    sessionCtx: {
      Provider: "whatsapp",
      MessageSid: "msg",
    },
    opts: {},
    typingSignals: createMockTypingSignaler(),
    ...createAgentTurnExecutionDefaults(),
  };
}

export function createMinimalRunAgentTurnParams(overrides?: {
  followupRun?: FollowupRun;
  opts?: GetReplyOptions;
  replyOperation?: ReplyOperation;
  sessionCtx?: TemplateContext;
  typingSignals?: TypingSignaler;
}): AgentTurnParams {
  const followupRun = overrides?.followupRun ?? createFollowupRun();
  publishTestExecutionCatalog(followupRun);
  return {
    commandBody: "fix it",
    followupRun,
    sessionCtx:
      overrides?.sessionCtx ??
      ({
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext),
    opts: overrides?.opts ?? ({} satisfies GetReplyOptions),
    replyOperation: overrides?.replyOperation,
    typingSignals: overrides?.typingSignals ?? createMockTypingSignaler(),
    ...createAgentTurnExecutionDefaults(),
  };
}

export const NON_DIRECT_FAILURE_SURFACE_CASES = [
  { label: "Discord group", provider: "discord", chatType: "group" },
  { label: "Discord channel", provider: "discord", chatType: "channel" },
  { label: "Slack channel", provider: "slack", chatType: "channel" },
  { label: "Telegram group", provider: "telegram", chatType: "group" },
  { label: "WhatsApp group", provider: "whatsapp", chatType: "group" },
  { label: "Microsoft Teams channel", provider: "msteams", chatType: "channel" },
] as const;

export function createNonDirectFailureSessionCtx(
  testCase: (typeof NON_DIRECT_FAILURE_SURFACE_CASES)[number],
): TemplateContext {
  return {
    Provider: testCase.provider,
    Surface: testCase.provider,
    ChatType: testCase.chatType,
    GroupSubject: `${testCase.label} fixture`,
    GroupChannel: "#general",
    MessageSid: "msg",
  } as unknown as TemplateContext;
}

export async function setupAgentRunnerExecutionTestState() {
  // Each suite awaits collection readiness after its imported mock harnesses register.
  // Hook timeouts cannot cancel imports; cleanup must not overtake module readiness.
  await getExecuteAgentTurnForTest();

  beforeEach(() => {
    vi.useRealTimers();
    const registry = captureActivePluginRegistrySnapshot();
    setActivePluginRegistry(createEmptyPluginRegistry());
    onTestFinished(() => restoreActivePluginRegistrySnapshot(registry));
    resetExecutionMocks();
  });

  afterEach(() => {
    // Fake-timer tests must not leak into --isolate=false peers.
    vi.useRealTimers();
    cliBackendsTesting.resetDepsForTest();
    vi.clearAllMocks();
  });

  return state;
}
