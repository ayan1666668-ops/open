// Isolated run test harness builds cron run inputs, mocks, and assertions.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { vi, type Mock } from "vitest";
import {
  type ContextTokenResolutionParams,
  resolveAuthoredModelContextTokens,
} from "../../agents/context-resolution.js";
import type { FallbackRunnerParams } from "../../agents/embedded-agent-runner/run-entry.test-support.js";
import { resolveFastModeState as resolveFastModeStateImpl } from "../../agents/fast-mode.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import {
  runInitialModelFallbackAttempt,
  withModelFallbackPreparation,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSqliteScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
} from "../../config/sessions/types.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db-registry.js";
import {
  resetCronModelRuntimeFixture,
  selectionMetadata,
} from "./run.model-runtime.test-support.js";

// Central mock harness for isolated cron agent run orchestration tests.
type CronSessionEntry = {
  sessionId: string;
  updatedAt: number;
  systemSent: boolean;
  skillsSnapshot: unknown;
  model?: string;
  modelProvider?: string;
  cliSessionBindings?: SessionEntry["cliSessionBindings"];
  [key: string]: unknown;
};

type CronSession = {
  storePath: string;
  store: Record<string, unknown>;
  sessionEntry: CronSessionEntry;
  lifecycleRevision: string;
  systemSent: boolean;
  isNewSession: boolean;
  [key: string]: unknown;
};

type SessionAccessorModule = typeof import("../../config/sessions/session-accessor.js");

function createMock(): Mock {
  return vi.fn();
}

function normalizeModelSelectionForTest(value: unknown): string | undefined {
  const direct = normalizeOptionalString(value);
  if (direct) {
    return direct;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return normalizeOptionalString((value as { primary?: unknown }).primary);
}

const SYNTHETIC_STORE_PATH = "/tmp/store.json";

function resolveSyntheticSessionStoreKey(
  scope: Parameters<SessionAccessorModule["patchSessionEntryCore"]>[0],
): string | undefined {
  const requested = resolveSqliteScope({
    ...scope,
    storePath: scope.storePath || SYNTHETIC_STORE_PATH,
  });
  const synthetic = resolveSqliteScope({
    ...scope,
    agentId: requested.agentId,
    storePath: SYNTHETIC_STORE_PATH,
  });
  if (
    synthetic.ownerStorePath !== SYNTHETIC_STORE_PATH ||
    !synthetic.path ||
    !requested.path ||
    !isSameOpenClawAgentDatabasePath(synthetic.path, requested.path)
  ) {
    return undefined;
  }
  return JSON.stringify([synthetic.path, synthetic.sessionKey]);
}

export const buildWorkspaceSkillSnapshotMock = createMock();
export const resolveAgentConfigMock = createMock();
const resolveAgentWorkspaceDirMock = vi.fn(
  (cfg: { agents?: { list?: Array<{ id?: string; workspace?: string }> } }, agentId: string) =>
    cfg.agents?.list?.find((entry) => entry.id === agentId)?.workspace ?? "/tmp/workspace",
);
const resolveSubagentModelFallbacksOverrideMock = createMock();
export const resolveAgentSkillsFilterMock = createMock();
export const getModelRefStatusMock = createMock();
export const isCliProviderMock = createMock();
export const resolveAllowedModelRefMock = createMock();
export const resolveConfiguredModelRefMock = createMock();
export const resolveHooksGmailModelMock = createMock();
export const resolveThinkingDefaultMock = createMock();
export const resolveEffectiveAgentRuntimeMock = createMock();
export const runWithModelFallbackMock = createMock();
export const runEmbeddedAgentMock = createMock();
export const runCliAgentMock = createMock();
export const lookupModelContextTokensMock =
  vi.fn<(params: ContextTokenResolutionParams) => number | undefined>();
export const getCliSessionBindingMock = createMock();
export const loadSessionEntryMock = createMock();
const loadSessionEntryReadOnlyMock = createMock();
const replaceSessionEntryMock = createMock();
export const patchSessionEntryMock = createMock();
export const resolveCronSessionMock = createMock();
export const logWarnMock = createMock();
export const countActiveDescendantRunsMock = createMock();
export const listDescendantRunsForRequesterMock = createMock();
export const pickLastNonEmptyTextFromPayloadsMock = createMock();
export const resolveCronPayloadOutcomeMock = createMock();
export const resolveCronDeliveryPlanMock = createMock();
export const resolveDeliveryTargetMock = createMock();
export const dispatchCronDeliveryMock = createMock();
export const queueCronMessageToolDeliveryAwarenessMock = createMock();
export const preflightCronModelProviderMock = createMock();
export const resolveSessionAuthSelectionMock = createMock();
export const resolveFastModeStateMock = createMock();
export const getChannelPluginMock = createMock();
export const retireSessionMcpRuntimeMock = createMock();
export const cleanupBrowserSessionsForLifecycleEndMock = createMock();
export const removeCronRunContinuationSessionIfIdleMock = createMock();
export const callGatewayMock = createMock();
export const hasUsableWebSearchProviderMock = createMock();
export const readSessionMessagesAsyncMock = createMock();

const resolveBootstrapWarningSignaturesSeenMock = createMock();
const resolveCronStyleNowMock = createMock();
export const resolveCronAgentLaneMock = createMock();
const resolveAgentTimeoutMsMock = createMock();
export const deriveSessionTotalTokensMock = createMock();
export const ensureAgentWorkspaceMock = createMock();
const normalizeThinkLevelMock = createMock();
const normalizeVerboseLevelMock = createMock();
export const isThinkingLevelSupportedMock = createMock();
export const resolveSupportedThinkingLevelMock = createMock();
const supportsXHighThinkingMock = createMock();
const resolveSessionTranscriptPathMock = createMock();
const setSessionRuntimeModelMock = createMock();
const registerAgentRunContextMock = createMock();
export const buildSafeExternalPromptMock = createMock();
const detectSuspiciousPatternsMock = createMock();
const mapHookExternalContentSourceMock = createMock();
const isExternalHookSessionMock = createMock();
const resolveHookExternalContentSourceMock = createMock();
const getSkillsSnapshotVersionMock = createMock();
export const loadModelCatalogMock = createMock();
export const loadModelCatalogOwnerMock = createMock();
export const preparedRunPluginRegistryMock = createMock();
export const acquirePreparedModelRuntimeMock = createMock();
export const loadPublishedReplyDispatchRuntimeMock = createMock();
const getRemoteSkillEligibilityMock = createMock();

vi.mock("../../agents/thinking-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/thinking-runtime.js")>()),
  resolveEffectiveAgentRuntimeCore: resolveEffectiveAgentRuntimeMock,
}));

vi.mock("../../agents/model-runtime-choice.js", () => ({
  evaluatePublishedModelRuntimeChoice: vi.fn(),
}));

vi.mock("../../agents/prepared-model-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/prepared-model-runtime.js")>()),
  acquireAgentRunPreparedModelRuntime: acquirePreparedModelRuntimeMock,
  loadPublishedGatewayReplyDispatchRuntime: loadPublishedReplyDispatchRuntimeMock,
}));

vi.mock("./run.runtime.js", async () => ({
  resolveAgentConfig: resolveAgentConfigMock,
  resolveAgentDir: vi.fn().mockReturnValue("/tmp/agent-dir"),
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  resolveCronStyleNow: resolveCronStyleNowMock,
  DEFAULT_CONTEXT_TOKENS: 128000,
  isCliProvider: isCliProviderMock,
  resolveThinkingSelection: (params: { level?: string }) => {
    const requestedLevel = params.level ?? resolveThinkingDefaultMock(params);
    const policy = { ...params, level: requestedLevel };
    const supported = isThinkingLevelSupportedMock(policy);
    return {
      requestedLevel,
      level: supported ? requestedLevel : resolveSupportedThinkingLevelMock(policy),
      supported,
    };
  },
  resolveAcceptedSessionRuntimeId: (
    await vi.importActual<typeof import("../../agents/session-runtime-compat.js")>(
      "../../agents/session-runtime-compat.js",
    )
  ).resolveAcceptedSessionRuntimeId,
  buildWorkspaceSkillSnapshot: buildWorkspaceSkillSnapshotMock,
  getSkillsSnapshotVersion: getSkillsSnapshotVersionMock,
  resolveAgentTimeoutMs: resolveAgentTimeoutMsMock,
  deriveSessionTotalTokens: deriveSessionTotalTokensMock,
  hasNonzeroUsage: (
    await vi.importActual<typeof import("../../agents/usage.js")>("../../agents/usage.js")
  ).hasNonzeroUsage,
  DEFAULT_IDENTITY_FILENAME: "IDENTITY.md",
  ensureAgentWorkspace: ensureAgentWorkspaceMock,
  normalizeThinkLevel: normalizeThinkLevelMock,
  supportsXHighThinking: supportsXHighThinkingMock,
  resolveSessionTranscriptPath: resolveSessionTranscriptPathMock,
  setSessionRuntimeModel: setSessionRuntimeModelMock,
  logWarn: (...args: unknown[]) => logWarnMock(...args),
  normalizeAgentId: vi.fn((id: string) => id),
  mapHookExternalContentSource: mapHookExternalContentSourceMock,
  isExternalHookSession: isExternalHookSessionMock,
  resolveHookExternalContentSource: resolveHookExternalContentSourceMock,
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
}));

vi.mock("./run-external-content.runtime.js", () => ({
  buildSafeExternalPrompt: buildSafeExternalPromptMock,
  detectSuspiciousPatterns: detectSuspiciousPatternsMock,
}));

vi.mock("./run-context.runtime.js", () => ({
  resolveModelContextTokenProjection: (params: ContextTokenResolutionParams) => ({
    contextTokens: lookupModelContextTokensMock(params),
    authoredContextTokens: resolveAuthoredModelContextTokens(params),
  }),
}));

vi.mock("../../web-search/runtime.js", () => ({
  hasUsableWebSearchProvider: hasUsableWebSearchProviderMock,
}));

vi.mock("../../skills/runtime/cron-snapshot.runtime.js", () => ({
  resolveNodeExecEligibility: vi.fn(() => ({ canExec: false })),
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
  resolveEffectiveAgentSkillFilter: resolveAgentSkillsFilterMock,
  resolveReusableWorkspaceSkillSnapshot: (params: {
    workspaceDir: string;
    config?: unknown;
    agentId?: string;
    existingSnapshot?: { version?: number; skillFilter?: string[] };
    skillFilter?: string[];
    eligibility?: unknown;
  }) => {
    const normalize = (skillFilter?: string[]) =>
      Array.from(new Set(skillFilter?.map((entry) => entry.trim()).filter(Boolean))).toSorted();
    const sameFilter =
      JSON.stringify(normalize(params.existingSnapshot?.skillFilter)) ===
      JSON.stringify(normalize(params.skillFilter));
    const snapshotVersion = getSkillsSnapshotVersionMock(params.workspaceDir);
    const shouldRefresh =
      !params.existingSnapshot ||
      params.existingSnapshot.version !== snapshotVersion ||
      !sameFilter;
    return {
      snapshot: shouldRefresh
        ? buildWorkspaceSkillSnapshotMock(params.workspaceDir, {
            config: params.config,
            agentId: params.agentId,
            skillFilter: params.skillFilter,
            eligibility: params.eligibility,
            snapshotVersion,
          })
        : params.existingSnapshot,
      shouldRefresh,
      snapshotVersion,
    };
  },
}));

vi.mock("./run-model-selection.runtime.js", () => ({
  DEFAULT_MODEL: "gpt-5.4",
  DEFAULT_PROVIDER: "openai",
  loadPreparedModelCatalogSnapshot: async (params: unknown) => ({
    entries: await loadModelCatalogMock(params),
    routeVariants: [],
  }),
  loadProviderScopedThinkingCatalog: async (params: unknown) => await loadModelCatalogMock(params),
  loadResolvedPublishedModelCatalogOwner: loadModelCatalogOwnerMock,
  publishedModelCatalogOwnerMatchesAgent: (owner: { agentId: string }, agentId: string) =>
    owner.agentId === agentId.trim().toLowerCase(),
  resolveAgentConfig: resolveAgentConfigMock,
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  getModelRefStatus: getModelRefStatusMock,
  normalizeModelSelection: normalizeModelSelectionForTest,
  resolveAllowedModelRefCore: resolveAllowedModelRefMock,
  resolveConfiguredModelRef: resolveConfiguredModelRefMock,
  resolveHooksGmailModel: resolveHooksGmailModelMock,
  resolveSubagentModelConfigSelectionResult: ({
    cfg,
    agentConfigOverride,
  }: {
    cfg?: { agents?: { defaults?: { subagents?: { model?: unknown } } } };
    agentConfigOverride?: { model?: unknown; subagents?: { model?: unknown } };
  }) => {
    for (const candidate of [
      { raw: agentConfigOverride?.subagents?.model, source: "subagent" as const },
      { raw: cfg?.agents?.defaults?.subagents?.model, source: "default-subagent" as const },
      { raw: agentConfigOverride?.model, source: "agent" as const },
    ]) {
      if (normalizeModelSelectionForTest(candidate.raw)) {
        return candidate;
      }
    }
    return undefined;
  },
}));

vi.mock("../../agents/model-fallback-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/model-fallback-runner.js")>()),
  runWithModelFallback: (params: FallbackRunnerParams) =>
    withModelFallbackPreparation(params, runWithModelFallbackMock),
}));

vi.mock("./run-execution.runtime.js", () => ({
  resolveSubagentModelFallbacksOverride: resolveSubagentModelFallbacksOverrideMock,
  resolveBootstrapWarningSignaturesSeen: resolveBootstrapWarningSignaturesSeenMock,
  getCliSessionBinding: getCliSessionBindingMock,
  runCliAgent: runCliAgentMock,
  resolveFastModeState: resolveFastModeStateMock,
  resolveCronAgentLane: resolveCronAgentLaneMock,
  LiveSessionModelSwitchError,
  runEmbeddedAgent: runEmbeddedAgentMock,
  countActiveDescendantRuns: countActiveDescendantRunsMock,
  listDescendantRunsForRequester: listDescendantRunsForRequesterMock,
  normalizeVerboseLevel: normalizeVerboseLevelMock,
  resolveSessionTranscriptPath: resolveSessionTranscriptPathMock,
  registerAgentRunContext: registerAgentRunContextMock,
  logWarn: (...args: unknown[]) => logWarnMock(...args),
}));

vi.mock("../../agents/model-runtime-aliases.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/model-runtime-aliases.js")>()),
  resolveCliRuntimeExecutionProvider: ({
    provider,
    cfg,
    modelId,
  }: {
    provider?: string;
    cfg?: {
      agents?: {
        defaults?: {
          models?: Record<string, { agentRuntime?: { id?: string } }>;
        };
      };
    };
    modelId?: string;
  }) => {
    const key = provider && modelId ? `${provider}/${modelId}` : undefined;
    const runtime = key
      ? cfg?.agents?.defaults?.models?.[key]?.agentRuntime?.id?.trim()
      : undefined;
    return runtime || provider;
  },
}));

vi.mock("./run-auth-profile.runtime.js", () => ({
  resolveSessionAuthSelection: resolveSessionAuthSelectionMock,
}));

vi.mock("./run-embedded.runtime.js", () => ({
  resolveFastModeState: resolveFastModeStateMock,
  resolveCronAgentLane: resolveCronAgentLaneMock,
  runEmbeddedAgent: runEmbeddedAgentMock,
}));

vi.mock("./run-subagent-registry.runtime.js", () => ({
  countActiveDescendantRuns: countActiveDescendantRunsMock,
  listDescendantRunsForRequester: listDescendantRunsForRequesterMock,
}));

vi.mock("../../agents/agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntime: retireSessionMcpRuntimeMock,
}));

vi.mock("../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: cleanupBrowserSessionsForLifecycleEndMock,
}));

vi.mock("../../tasks/cron-run-continuation-cleanup.js", () => ({
  removeCronRunContinuationSessionIfIdle: removeCronRunContinuationSessionIfIdleMock,
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

vi.mock("../../gateway/session-transcript-readers.js", () => ({
  readSessionMessagesAsync: readSessionMessagesAsyncMock,
}));

vi.mock("../delivery-plan.js", async () => ({
  ...(await vi.importActual<typeof import("../delivery-plan.js")>("../delivery-plan.js")),
  resolveCronDeliveryPlan: resolveCronDeliveryPlanMock,
}));

vi.mock("./run-delivery.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./run-delivery.runtime.js")>(
    "./run-delivery.runtime.js",
  );
  return {
    ...actual,
    resolveDeliveryTarget: resolveDeliveryTargetMock,
    dispatchCronDelivery: dispatchCronDeliveryMock,
    queueCronMessageToolDeliveryAwareness: queueCronMessageToolDeliveryAwarenessMock,
  };
});

vi.mock("./model-preflight.runtime.js", () => ({
  preflightCronModelProvider: preflightCronModelProviderMock,
}));

vi.mock("./helpers.js", () => ({
  pickLastNonEmptyTextFromPayloads: pickLastNonEmptyTextFromPayloadsMock,
  pickSummaryFromOutput: vi.fn().mockReturnValue("summary"),
  resolveCronPayloadOutcome: resolveCronPayloadOutcomeMock,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: getChannelPluginMock,
  getLoadedChannelPlugin: getChannelPluginMock,
}));

vi.mock("./session.js", () => ({
  loadCronSessionEntryLatest: loadSessionEntryMock,
  resolveCronSession: resolveCronSessionMock,
}));

export function makeCronSessionEntry(overrides?: Record<string, unknown>): CronSessionEntry {
  return {
    sessionId: "test-session-id",
    updatedAt: 0,
    systemSent: false,
    skillsSnapshot: undefined,
    ...overrides,
  };
}

export function makeCronSession(overrides?: Record<string, unknown>): CronSession {
  const session = {
    storePath: SYNTHETIC_STORE_PATH,
    store: {},
    sessionEntry: makeCronSessionEntry(),
    lifecycleRevision: "test-lifecycle-revision",
    initialSessionEntry: undefined,
    systemSent: false,
    isNewSession: true,
    ...overrides,
  } as CronSession;
  // Real resolveCronSession stamps the run's lifecycleRevision onto the live
  // sessionEntry so the accessor-backed persist path can prove ownership on
  // later writes. Mirror that here unless a test seeds its own revision.
  if (session.sessionEntry.lifecycleRevision === undefined) {
    session.sessionEntry.lifecycleRevision = session.lifecycleRevision;
  }
  return session;
}

function makeDefaultEmbeddedResult() {
  return {
    payloads: [{ text: "test output" }],
    meta: { agentMeta: {} },
  };
}

export function mockRunCronFallbackPassthrough(): void {
  runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
    return {
      result: await runInitialModelFallbackAttempt(params),
      provider: params.provider,
      model: params.model,
      attempts: [],
    };
  });
}

function resetRunConfigMocks(): void {
  buildWorkspaceSkillSnapshotMock.mockReturnValue({
    prompt: "<available_skills></available_skills>",
    resolvedSkills: [],
    version: 42,
  });
  resolveAgentConfigMock.mockReturnValue(undefined);
  resolveSubagentModelFallbacksOverrideMock.mockReset();
  resolveSubagentModelFallbacksOverrideMock.mockImplementation((cfg, agentId) => {
    const agentConfig = resolveAgentConfigMock(cfg, agentId) as
      | { model?: unknown; subagents?: { model?: unknown } }
      | undefined;
    const resolveOverride = (raw: unknown): string[] | undefined => {
      const primary = normalizeModelSelectionForTest(raw);
      if (!raw) {
        return undefined;
      }
      if (typeof raw === "string") {
        return primary ? [] : undefined;
      }
      if (typeof raw !== "object" || Array.isArray(raw)) {
        return undefined;
      }
      if (!Object.hasOwn(raw, "fallbacks")) {
        return Object.hasOwn(raw, "primary") && primary ? [] : undefined;
      }
      const fallbacks = (raw as { fallbacks?: unknown }).fallbacks;
      return Array.isArray(fallbacks)
        ? fallbacks.filter((entry) => typeof entry === "string")
        : undefined;
    };
    const subagentFallbacks = resolveOverride(agentConfig?.subagents?.model);
    if (subagentFallbacks !== undefined) {
      return subagentFallbacks;
    }
    const selectedConfig = [
      agentConfig?.subagents?.model,
      (cfg as { agents?: { defaults?: { subagents?: { model?: unknown } } } })?.agents?.defaults
        ?.subagents?.model,
      agentConfig?.model,
    ].find((raw) => normalizeModelSelectionForTest(raw));
    return resolveOverride(selectedConfig);
  });
  resolveAgentSkillsFilterMock.mockReturnValue(undefined);
  resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-5.4" });
  resolveAllowedModelRefMock.mockReturnValue({ ref: { provider: "openai", model: "gpt-5.4" } });
  resolveHooksGmailModelMock.mockReturnValue(null);
  resolveThinkingDefaultMock.mockReturnValue("off");
  resolveEffectiveAgentRuntimeMock.mockReturnValue("openclaw");
  getModelRefStatusMock.mockReturnValue({ allowed: false });
  resolveCronStyleNowMock.mockReturnValue({
    formattedTime: "2026-02-10 12:00",
    timeLine: "Current time: 2026-02-10 12:00 UTC",
  });
  resolveAgentTimeoutMsMock.mockReturnValue(60_000);
  deriveSessionTotalTokensMock.mockReturnValue(30);
  ensureAgentWorkspaceMock.mockResolvedValue({ dir: "/tmp/workspace" });
  normalizeThinkLevelMock.mockImplementation((value: unknown) => value);
  isThinkingLevelSupportedMock.mockReturnValue(true);
  resolveSupportedThinkingLevelMock.mockImplementation(({ level }: { level?: unknown }) => level);
  supportsXHighThinkingMock.mockReturnValue(false);
  buildSafeExternalPromptMock.mockImplementation(
    ({ message }: { message?: string }) => message ?? "",
  );
  detectSuspiciousPatternsMock.mockReturnValue([]);
  mapHookExternalContentSourceMock.mockReturnValue("unknown");
  isExternalHookSessionMock.mockReturnValue(false);
  resolveHookExternalContentSourceMock.mockReturnValue(undefined);
  getSkillsSnapshotVersionMock.mockReturnValue(42);
  resetCronModelRuntimeFixture({
    loadModelCatalog: loadModelCatalogMock,
    loadModelCatalogOwner: loadModelCatalogOwnerMock,
    loadPublishedReplyDispatchRuntime: loadPublishedReplyDispatchRuntimeMock,
    acquirePreparedModelRuntime: acquirePreparedModelRuntimeMock,
    preparedRunPluginRegistry: preparedRunPluginRegistryMock,
    resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  });
  getRemoteSkillEligibilityMock.mockResolvedValue({ remoteSkillsEnabled: false });
}

function resetRunExecutionMocks(): void {
  isCliProviderMock.mockReturnValue(false);
  resolveBootstrapWarningSignaturesSeenMock.mockReturnValue(new Set());
  resolveFastModeStateMock.mockImplementation((params) => resolveFastModeStateImpl(params));
  resolveCronAgentLaneMock.mockReturnValue(undefined);
  normalizeVerboseLevelMock.mockImplementation((value: unknown) => value ?? "off");
  resolveSessionTranscriptPathMock.mockReturnValue("/tmp/transcript.jsonl");
  registerAgentRunContextMock.mockReturnValue(undefined);
  runWithModelFallbackMock.mockReset();
  mockRunCronFallbackPassthrough();
  runEmbeddedAgentMock.mockReset();
  runEmbeddedAgentMock.mockResolvedValue(makeDefaultEmbeddedResult());
  runCliAgentMock.mockReset();
  getCliSessionBindingMock.mockReturnValue(undefined);
  countActiveDescendantRunsMock.mockReset();
  countActiveDescendantRunsMock.mockReturnValue(0);
  listDescendantRunsForRequesterMock.mockReset();
  listDescendantRunsForRequesterMock.mockReturnValue([]);
}

function resetRunOutcomeMocks(): void {
  lookupModelContextTokensMock.mockReset();
  lookupModelContextTokensMock.mockReturnValue(undefined);
  pickLastNonEmptyTextFromPayloadsMock.mockReset();
  pickLastNonEmptyTextFromPayloadsMock.mockReturnValue("test output");
  resolveCronPayloadOutcomeMock.mockReset();
  resolveCronPayloadOutcomeMock.mockImplementation(
    ({
      payloads,
      failureSignal,
      runLevelError,
    }: {
      payloads: Array<{ isError?: boolean }>;
      failureSignal?: { fatalForCron?: boolean; message?: string };
      runLevelError?: unknown;
    }) => {
      const runLevelErrorMessage =
        typeof runLevelError === "string" && runLevelError.trim()
          ? `cron isolated run failed: ${runLevelError.trim()}`
          : runLevelError && typeof runLevelError === "object"
            ? (() => {
                const record = runLevelError as { message?: unknown; kind?: unknown };
                const message =
                  typeof record.message === "string" && record.message.trim()
                    ? record.message.trim()
                    : undefined;
                if (message) {
                  return `cron isolated run failed: ${message}`;
                }
                const kind =
                  typeof record.kind === "string" && record.kind.trim()
                    ? record.kind.trim()
                    : undefined;
                return kind ? `cron isolated run failed: ${kind}` : "cron isolated run failed";
              })()
            : undefined;
      const failureMessage =
        failureSignal?.fatalForCron === true
          ? (failureSignal.message ?? "cron isolated run returned a fatal failure signal")
          : undefined;
      const errorPayloadMessage = payloads.some((payload) => payload?.isError === true)
        ? "cron isolated run returned an error payload"
        : undefined;
      const outputText =
        errorPayloadMessage ??
        failureMessage ??
        runLevelErrorMessage ??
        pickLastNonEmptyTextFromPayloadsMock(payloads);
      const synthesizedText = outputText?.trim() || "summary";
      const hasFatalErrorPayload =
        errorPayloadMessage !== undefined ||
        failureMessage !== undefined ||
        runLevelErrorMessage !== undefined;
      const hasFatalStructuredErrorPayload = errorPayloadMessage !== undefined;
      const deliveryPayload =
        errorPayloadMessage || failureMessage || runLevelErrorMessage
          ? { text: errorPayloadMessage ?? failureMessage ?? runLevelErrorMessage, isError: true }
          : undefined;
      return {
        summary: errorPayloadMessage ?? failureMessage ?? runLevelErrorMessage ?? "summary",
        outputText,
        synthesizedText,
        deliveryPayload,
        deliveryPayloads: deliveryPayload
          ? [deliveryPayload]
          : synthesizedText
            ? [{ text: synthesizedText }]
            : [],
        deliveryDisposition: { kind: "visible" },
        deliveryPayloadHasStructuredContent: false,
        hasFatalErrorPayload,
        hasFatalStructuredErrorPayload,
        embeddedRunError:
          errorPayloadMessage ?? failureMessage ?? runLevelErrorMessage ?? undefined,
      };
    },
  );
  resolveCronDeliveryPlanMock.mockReset();
  resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "none" });
  resolveDeliveryTargetMock.mockReset();
  resolveDeliveryTargetMock.mockResolvedValue({
    ok: true,
    channel: "messagechat",
    to: "test-target",
    accountId: undefined,
    threadId: undefined,
    mode: "explicit",
    error: undefined,
  });
  dispatchCronDeliveryMock.mockReset();
  dispatchCronDeliveryMock.mockImplementation(
    ({
      deliveryPayloads,
      summary,
      outputText,
      synthesizedText,
      deliveryRequested,
      skipDelivery,
      sourceDeliveryOutcome,
      resolvedDelivery,
    }) => ({
      result: undefined,
      delivered: Boolean(
        sourceDeliveryOutcome?.verifiedMessageToolDelivery ||
        (deliveryRequested &&
          !skipDelivery &&
          !sourceDeliveryOutcome?.satisfiesSourceDelivery &&
          resolvedDelivery.ok),
      ),
      deliveryAttempted: Boolean(
        sourceDeliveryOutcome?.verifiedMessageToolDelivery ||
        (deliveryRequested &&
          !skipDelivery &&
          !sourceDeliveryOutcome?.satisfiesSourceDelivery &&
          resolvedDelivery.ok),
      ),
      summary,
      outputText,
      synthesizedText,
      deliveryPayloads,
    }),
  );
  queueCronMessageToolDeliveryAwarenessMock.mockReset();
  queueCronMessageToolDeliveryAwarenessMock.mockResolvedValue(undefined);
  preflightCronModelProviderMock.mockReset();
  preflightCronModelProviderMock.mockResolvedValue({ status: "available" });
  resolveSessionAuthSelectionMock.mockReset();
  resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
}

function resetRunSessionMocks(): void {
  vi.spyOn(sessionAccessor, "replaceSessionEntry").mockImplementation(replaceSessionEntryMock);
  vi.spyOn(sessionAccessor, "patchSessionEntryCore").mockImplementation(patchSessionEntryMock);
  vi.spyOn(sessionAccessor, "loadSessionEntryReadOnly").mockImplementation(
    loadSessionEntryReadOnlyMock,
  );
  loadSessionEntryMock.mockReset();
  loadSessionEntryMock.mockReturnValue(undefined);
  replaceSessionEntryMock.mockReset();
  patchSessionEntryMock.mockReset();
  installPatchSessionEntryStore();
  resolveCronSessionMock.mockReset();
  resolveCronSessionMock.mockReturnValue(makeCronSession());
  callGatewayMock.mockReset();
  callGatewayMock.mockResolvedValue({ ok: true, deleted: true });
  removeCronRunContinuationSessionIfIdleMock.mockReset();
  removeCronRunContinuationSessionIfIdleMock.mockResolvedValue(undefined);
  retireSessionMcpRuntimeMock.mockReset();
  retireSessionMcpRuntimeMock.mockResolvedValue(true);
}

// Only synthetic orchestration stores use this map; real paths use the full accessor.
function installPatchSessionEntryStore(): void {
  const rows = new Map<string, SessionEntry>();
  replaceSessionEntryMock.mockImplementation(
    async (...args: Parameters<SessionAccessorModule["replaceSessionEntry"]>) => {
      const [scope, entry] = args;
      const key = resolveSyntheticSessionStoreKey(scope);
      if (key === undefined) {
        return actualReplaceSessionEntry(...args);
      }
      rows.set(key, structuredClone(entry));
      return structuredClone(entry);
    },
  );
  loadSessionEntryReadOnlyMock.mockImplementation(
    (scope: Parameters<SessionAccessorModule["loadSessionEntryReadOnly"]>[0]) => {
      const key = resolveSyntheticSessionStoreKey(scope);
      if (key === undefined) {
        return actualLoadSessionEntryReadOnly(scope);
      }
      const entry: SessionEntry | undefined =
        rows.get(key) ?? loadSessionEntryMock(SYNTHETIC_STORE_PATH, scope.sessionKey);
      return entry ? structuredClone(entry) : undefined;
    },
  );
  patchSessionEntryMock.mockImplementation(
    async (...args: Parameters<SessionAccessorModule["patchSessionEntryCore"]>) => {
      const [scope, update, options = {}] = args;
      const key = resolveSyntheticSessionStoreKey(scope);
      if (key === undefined) {
        return actualPatchSessionEntryCore(...args);
      }
      const existingEntry: SessionEntry | undefined =
        rows.get(key) ?? loadSessionEntryMock(SYNTHETIC_STORE_PATH, scope.sessionKey);
      const writeBase = existingEntry ?? options.fallbackEntry;
      if (!writeBase) {
        return null;
      }
      const patch = await update(structuredClone(writeBase), {
        existingEntry: existingEntry ? structuredClone(existingEntry) : undefined,
      });
      if (options.shouldCommit?.() === false) {
        return null;
      }
      options.assertCommitAllowed?.();
      if (!patch) {
        return structuredClone(writeBase);
      }
      const creationPatch = existingEntry ? patch : { ...writeBase, ...patch };
      const mergeBase = existingEntry ? writeBase : undefined;
      // The accessor's replaceEntry contract supplies a complete session snapshot.
      const committed = options.replaceEntry
        ? structuredClone(patch as SessionEntry)
        : options.preserveActivity
          ? mergeSessionEntryPreserveActivity(mergeBase, creationPatch)
          : mergeSessionEntry(mergeBase, creationPatch);
      rows.set(key, structuredClone(committed));
      options.onCommitted?.(structuredClone(committed));
      return structuredClone(committed);
    },
  );
}

export function resetRunCronIsolatedAgentTurnHarness(): void {
  vi.clearAllMocks();
  resetRunConfigMocks();
  resetRunExecutionMocks();
  resetRunOutcomeMocks();
  resetRunSessionMocks();
  setSessionRuntimeModelMock.mockImplementation(
    (
      entry: { modelProvider?: string; model?: string },
      runtime: { provider: string; model: string },
    ) => {
      const provider = runtime.provider.trim();
      const model = runtime.model.trim();
      if (!provider || !model) {
        return false;
      }
      entry.modelProvider = provider;
      entry.model = model;
      return true;
    },
  );
  logWarnMock.mockReset();
  hasUsableWebSearchProviderMock.mockReset();
  hasUsableWebSearchProviderMock.mockImplementation(
    (params?: { runtimeWebSearch?: { selectedProvider?: string } }) =>
      Boolean(params?.runtimeWebSearch?.selectedProvider),
  );
  readSessionMessagesAsyncMock.mockReset();
  readSessionMessagesAsyncMock.mockResolvedValue([]);
}

export function clearFastTestEnv(): string | undefined {
  const previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
  delete process.env.OPENCLAW_TEST_FAST;
  return previousFastTestEnv;
}

export function restoreFastTestEnv(previousFastTestEnv: string | undefined): void {
  if (previousFastTestEnv == null) {
    delete process.env.OPENCLAW_TEST_FAST;
    return;
  }
  process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
}

// Session metadata loads the mocked channel registry; its mock values must exist first.
const sessionAccessor = await import("../../config/sessions/session-accessor.js");
const {
  replaceSessionEntry: actualReplaceSessionEntry,
  patchSessionEntryCore: actualPatchSessionEntryCore,
  loadSessionEntryReadOnly: actualLoadSessionEntryReadOnly,
} = sessionAccessor;

export async function loadRunCronIsolatedAgentTurn() {
  const { runCronIsolatedAgentTurn } = await import("./run.js");
  return (...args: Parameters<typeof runCronIsolatedAgentTurn>) =>
    withPluginMetadataSnapshotScope(selectionMetadata, () => runCronIsolatedAgentTurn(...args), {
      trustConfigIdentity: true,
    });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
