import path from "node:path";
import { vi } from "vitest";
import type { PreparedAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { acceptCompactionSuccessor } from "../../agents/embedded-agent-runner/compaction-successor.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import type { ModelFallbackAttemptProvenance } from "../../agents/model-fallback.types.js";
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import {
  registerMemoryCapability,
  type MemoryFlushPlan,
  type MemoryFlushPlanResolver,
} from "../../plugins/memory-state.test-fixtures.js";
import {
  runMemoryFlushIfNeeded as runMemoryFlushIfNeededRaw,
  runSessionCompactionIfNeeded as runSessionCompactionIfNeededRaw,
} from "./agent-runner-memory.js";
import { withTestModelContextTokens } from "./agent-runner.test-fixtures.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { createMockReplyOperation } from "./test-helpers.js";

export type MemoryFlushTestParams = Parameters<typeof runMemoryFlushIfNeededRaw>[0] & {
  modelContextTokens?: number;
};

export async function runMemoryFlushIfNeeded(params: MemoryFlushTestParams) {
  const { modelContextTokens, ...runParams } = params;
  return await runMemoryFlushIfNeededRaw({
    ...runParams,
    cfg: withTestModelContextTokens({
      cfg: runParams.cfg,
      followupRun: runParams.followupRun,
      defaultModel: runParams.defaultModel,
      contextTokens: modelContextTokens,
    }),
  });
}

export type PreflightCompactionTestParams = Parameters<
  typeof runSessionCompactionIfNeededRaw
>[0] & {
  modelContextTokens?: number;
};

export async function runSessionCompactionIfNeeded(params: PreflightCompactionTestParams) {
  const { modelContextTokens, ...runParams } = params;
  return await runSessionCompactionIfNeededRaw({
    ...runParams,
    cfg: withTestModelContextTokens({
      cfg: runParams.cfg,
      followupRun: runParams.followupRun,
      defaultModel: runParams.defaultModel,
      contextTokens: modelContextTokens,
    }),
  });
}

export function createMemoryFlushPlan(): MemoryFlushPlan {
  return {
    softThresholdTokens: 4_000,
    forceFlushTranscriptBytes: 1_000_000_000,
    reserveTokensFloor: 20_000,
    prompt: "Pre-compaction memory flush.\nNO_REPLY",
    systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
    relativePath: "memory/2023-11-14.md",
  };
}

export function createModifiedMemoryFlushPlan(
  overrides: Partial<MemoryFlushPlan>,
): MemoryFlushPlan {
  return { ...createMemoryFlushPlan(), ...overrides };
}

export function createFlushSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session",
    updatedAt: Date.now(),
    totalTokens: 80_000,
    totalTokensFresh: true,
    totalTokensVersion: 1,
    compactionCount: 1,
    ...overrides,
  };
}

export function registerMemoryFlushPlanResolverForTest(resolver: MemoryFlushPlanResolver): void {
  registerMemoryCapability("memory-core", { flushPlanResolver: resolver });
}

export function registerClaudeCliBackend(ownsNativeCompaction = false): void {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        modelProvider: "anthropic",
        pluginId: "anthropic",
        config: { command: "claude" },
        ownsNativeCompaction,
      },
    ],
  });
}

type TestReplyOperation = ReplyOperation & {
  setPhase: ReturnType<typeof vi.fn<ReplyOperation["setPhase"]>>;
  updateSessionId: ReturnType<typeof vi.fn<ReplyOperation["updateSessionId"]>>;
};

export function createReplyOperation(): TestReplyOperation {
  const { replyOperation } = createMockReplyOperation({ key: "test" });
  return Object.assign(replyOperation, {
    phase: "queued" as const,
    setPhase: vi.fn<ReplyOperation["setPhase"]>(),
    updateSessionId: vi.fn<ReplyOperation["updateSessionId"]>(),
  });
}

export function createCompactionLifecycle(replyOperation: ReplyOperation) {
  return {
    abortSignal: replyOperation.abortSignal,
    onCompactionStart: () => replyOperation.setPhase("preflight_compacting"),
    onSessionIdChanged: (sessionId: string) => replyOperation.updateSessionId(sessionId),
  };
}

export function loadMainSessionEntry(storePath: string): SessionEntry {
  const entry = loadSessionEntry({ storePath, sessionKey: "main" });
  if (!entry) {
    throw new Error("expected persisted main session entry");
  }
  return entry;
}

export async function writeTestSessionTranscript(params: {
  rootDir: string;
  events: Parameters<typeof replaceTranscriptEvents>[1];
  sessionKey?: string;
  sessionId?: string;
}): Promise<void> {
  const sessionId = params.sessionId ?? "session";
  const sessionKey = params.sessionKey ?? "main";
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: path.join(params.rootDir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 10 });
  await replaceTranscriptEvents(scope, params.events);
  await waitForSessionTranscriptProjection(scope);
}

export type ModelFallbackParams = {
  provider: string;
  model: string;
  abortSignal?: AbortSignal;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  fallbacksOverride?: unknown[];
  requestedRouteResolution?: "raw" | "resolved";
  userLockedAuthProfileId?: string;
  resolveAgentHarnessRuntimeOverride?: (provider: string, model: string) => string | undefined;
  prepareAgentHarnessRuntime?: (params: {
    provider: string;
    model: string;
    agentHarnessRuntimeOverride?: string;
  }) => Promise<void> | void;
  run: (
    provider: string,
    model: string,
    options: {
      allowTransientCooldownProbe?: boolean;
      isFinalFallbackAttempt?: boolean;
      modelRoutingProvenance: ModelFallbackAttemptProvenance;
    },
  ) => Promise<EmbeddedAgentRunResult>;
};

export function modelRoutingProvenance(
  requestedProvider: string,
  requestedModel: string,
  stage: ModelFallbackAttemptProvenance["stage"] = "initial",
): ModelFallbackAttemptProvenance {
  return { requestedProvider, requestedModel, stage };
}

export type EmbeddedAgentParams = {
  preparedRunAdmission?: PreparedAgentRunAdmission;
  sessionManager?: SessionManager;
  provider?: string;
  model?: string;
  thinkLevel?: string;
  agentHarnessId?: string;
  agentHarnessRuntimeOverride?: string;
  authProfileId?: unknown;
  authProfileIdSource?: unknown;
  prompt?: string;
  transcriptPrompt?: string;
  memoryFlushWritePath?: string;
  silentExpected?: boolean;
  allowEmptyAssistantReplyAsSilent?: boolean;
  terminalReplyExpectation?: "required" | "optional";
  extraSystemPrompt?: string;
  bootstrapPromptWarningSignaturesSeen?: string[];
  bootstrapPromptWarningSignature?: string;
  abortSignal?: AbortSignal;
  isFinalFallbackAttempt?: boolean;
  onAgentEvent?: (evt: {
    stream: string;
    data: { completed?: boolean; isError?: boolean; name?: string; phase?: string };
  }) => void;
};

export type CompactEmbeddedAgentSessionParams = {
  agentId?: string;
  agentHarnessId?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  contextTokenBudget?: number;
  sessionKey?: string;
  sandboxSessionKey?: string;
  currentTokenCount?: number;
  cwd?: string;
  force?: boolean;
  forcePreflight?: boolean;
  modelSelectionLocked?: boolean;
  preflightRequired?: boolean;
  preflightCompactionTrigger?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  sessionId?: string;
  trigger?: string;
};

export async function commitSourceCompaction(params: { sessionKey: string; storePath: string }) {
  const entry = loadSessionEntry({ sessionKey: params.sessionKey, storePath: params.storePath });
  if (!entry) {
    throw new Error("expected compaction predecessor");
  }
  const accepted = await acceptCompactionSuccessor({
    currentTarget: {
      agentId: "main",
      sessionId: entry.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    expectedEntry: {
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      activeWriterRunId: entry.activeWriterRunId,
    },
    assertActive: () => {},
    result: {
      ok: true,
      compacted: true,
      result: { sessionId: "session-rotated", tokensBefore: 120, tokensAfter: 42 },
    },
  });
  return accepted;
}
