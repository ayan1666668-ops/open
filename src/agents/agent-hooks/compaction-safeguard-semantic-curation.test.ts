/* eslint-disable no-unused-vars -- this split regression suite retains the shared hoisted mock harness so Vitest initialization stays identical across the compaction suites. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage, StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionAPI, ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
/** Tests compaction safeguard summaries, quality audit, providers, and runtime settings. */
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as decisionRuntimeModule from "../../decisions/runtime.js";
import type { DecisionOutcome } from "../../decisions/types.js";
import type { CompactionProvider } from "../../plugins/compaction-provider.js";
import {
  requireActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "../../plugins/runtime.js";
import * as compactionModule from "../compaction.js";
import { buildEmbeddedExtensionFactories } from "../embedded-agent-runner/extensions.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { timestampedTextAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { jsonResult } from "../tools/common.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../workspace-bootstrap-read.js";
import * as compactionInputCurationModule from "./compaction-input-curation.js";
import * as compactionQualityModule from "./compaction-safeguard-quality.js";
import {
  consumeCompactionSafeguardCancellation,
  getCompactionSafeguardRuntime,
  setCompactionSafeguardCancellation,
  setCompactionSafeguardRuntime,
} from "./compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "./compaction-safeguard.js";
import { testing } from "./compaction-safeguard.test-support.js";

const { compactionLogger } = vi.hoisted(() => {
  const logger = {
    subsystem: "compaction-safeguard",
    isEnabled: vi.fn(() => false),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { compactionLogger: logger };
});

vi.mock("../../decisions/runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../decisions/runtime.js")>(
    "../../decisions/runtime.js",
  );
  return { ...actual, evaluateDecision: vi.fn(actual.evaluateDecision) };
});

vi.mock("../../logging/subsystem.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging/subsystem.js")>(
    "../../logging/subsystem.js",
  );
  return { ...actual, createSubsystemLogger: () => compactionLogger };
});

vi.mock("./compaction-input-curation.js", async () => {
  const actual = await vi.importActual<typeof compactionInputCurationModule>(
    "./compaction-input-curation.js",
  );
  return {
    ...actual,
    curateCompactionSummarizerInput: vi.fn(actual.curateCompactionSummarizerInput),
  };
});

vi.mock("./compaction-safeguard-quality.js", async () => {
  const actual = await vi.importActual<typeof compactionQualityModule>(
    "./compaction-safeguard-quality.js",
  );
  return { ...actual, auditSummaryQuality: vi.fn(actual.auditSummaryQuality) };
});

vi.mock("../compaction.js", async () => {
  const actual = await vi.importActual<typeof compactionModule>("../compaction.js");
  return {
    ...actual,
    summarizeInStages: vi.fn(actual.summarizeInStages),
  };
});

const mockSummarizeInStages = vi.mocked(compactionModule.summarizeInStages);
const mockCurateCompactionSummarizerInput = vi.mocked(
  compactionInputCurationModule.curateCompactionSummarizerInput,
);
const mockEvaluateDecision = vi.mocked(decisionRuntimeModule.evaluateDecision);
const actualCompactionInputCurationModule = await vi.importActual<
  typeof compactionInputCurationModule
>("./compaction-input-curation.js");
const actualCompactionModule = await vi.importActual<typeof compactionModule>("../compaction.js");
const actualCompactionQualityModule = await vi.importActual<typeof compactionQualityModule>(
  "./compaction-safeguard-quality.js",
);
const mockAuditSummaryQuality = vi.mocked(compactionQualityModule.auditSummaryQuality);

function summaryResult(text: string) {
  return text;
}

// Local projections of the surviving primitives (the .text/.summary wrapper
// helpers were deleted with their prod-dead exports).
function budgetCompactionSummaryText(
  body: string,
  suffix: string,
  maxChars = MAX_COMPACTION_SUMMARY_CHARS,
): string {
  return (budgetCompactionSummary(body, suffix, maxChars) as { summary: string }).summary;
}

function preservedTurnsText(messages: AgentMessage[]): string {
  return (buildPreservedTurnsSection(messages) as { text: string }).text;
}

const {
  collectToolFailures,
  formatToolFailuresSection,
  splitPreservedRecentTurns,
  buildPreservedTurnsSection,
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  prependPreviousSummaryForRedistill,
  appendSummarySection,
  resolveRecentTurnsPreserve,
  resolveQualityGuardMaxRetries,
  extractOpaqueIdentifiers,
  auditSummaryQuality: auditSummaryQualityOwner,
  capCompactionSummary,
  budgetCompactionSummary,
  formatFileOperations,
  computeAdaptiveChunkRatio,
  readWorkspaceContextForSummary,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  MAX_COMPACTION_SUMMARY_CHARS,
  MAX_FILE_OPS_SECTION_CHARS,
  SUMMARY_TRUNCATED_MARKER,
  CONTEXT_TRUNCATED_MARKER,
  MAX_SPLIT_TURN_CONTEXT_CHARS,
} = testing;

function auditSummaryQuality(
  params: Omit<
    Parameters<typeof compactionQualityModule.auditSummaryQuality>[0],
    "structuralSummary"
  >,
) {
  return auditSummaryQualityOwner({ ...params, structuralSummary: params.summary });
}

beforeEach(() => {
  testing.setSummarizeInStagesForTest(mockSummarizeInStages);
  mockAuditSummaryQuality.mockImplementation(actualCompactionQualityModule.auditSummaryQuality);
  mockAuditSummaryQuality.mockClear();
  mockCurateCompactionSummarizerInput.mockImplementation(
    actualCompactionInputCurationModule.curateCompactionSummarizerInput,
  );
  mockCurateCompactionSummarizerInput.mockClear();
  mockEvaluateDecision.mockReset();
  compactionLogger.warn.mockClear();
});

afterEach(() => {
  testing.setSummarizeInStagesForTest();
  resetPluginRuntimeStateForTest();
});

function installCompactionProviderForTest(provider: CompactionProvider): void {
  requireActivePluginRegistry().compactionProviders.push({ provider });
}

function stubSessionManager(): ExtensionContext["sessionManager"] {
  const stub: ExtensionContext["sessionManager"] = {
    getCwd: () => "/stub",
    getSessionId: () => "stub-id",
    getSessionTarget: () => undefined,
    getLeafId: () => null,
    getAppendParentId: () => null,
    getAppendMode: () => undefined,
    getLeafEntry: () => undefined,
    getEntry: () => undefined,
    getLabel: () => undefined,
    getBranch: () => [],
    getHeader: () => null,
    getEntries: () => [],
    getTree: () => [],
    getSessionName: () => undefined,
  };
  return stub;
}

function createAnthropicModelFixture(overrides: Partial<Model> = {}): Model {
  return {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    provider: "anthropic",
    api: "anthropic" as const,
    baseUrl: "https://api.anthropic.com",
    contextWindow: 200000,
    maxTokens: 4096,
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

function createQualityGuardSessionManager(): ExtensionContext["sessionManager"] {
  const sessionManager = stubSessionManager();
  setCompactionSafeguardRuntime(sessionManager, {
    model: createAnthropicModelFixture(),
    recentTurnsPreserve: 0,
    qualityGuardEnabled: true,
    qualityGuardMaxRetries: 1,
  });
  return sessionManager;
}

type CompactionHandler = (event: unknown, ctx: unknown) => Promise<unknown>;
const createCompactionHandler = () => {
  let compactionHandler: CompactionHandler | undefined;
  const mockApi = {
    on: vi.fn((event: string, handler: CompactionHandler) => {
      if (event === "session_before_compact") {
        compactionHandler = handler;
      }
    }),
  } as unknown as ExtensionAPI;
  compactionSafeguardExtension(mockApi);
  if (!compactionHandler) {
    throw new Error("Expected compaction safeguard to register a handler.");
  }
  return compactionHandler;
};

const createCompactionEvent = (params: { messageText: string; tokensBefore: number }) => ({
  preparation: {
    messagesToSummarize: [
      { role: "user", content: params.messageText, timestamp: Date.now() },
    ] as AgentMessage[],
    turnPrefixMessages: [] as AgentMessage[],
    firstKeptEntryId: "entry-1",
    tokensBefore: params.tokensBefore,
    fileOps: {
      read: [],
      edited: [],
      written: [],
    },
  },
  customInstructions: "",
  signal: new AbortController().signal,
});

const createSemanticCompactionEvent = (params: {
  sourceRequirement: string;
  latestAsk: string;
  tokensBefore: number;
  signal?: AbortSignal;
}) => ({
  preparation: {
    messagesToSummarize: [
      { role: "user", content: params.sourceRequirement, timestamp: 1 },
      castAgentMessage({
        role: "assistant",
        content: "Acknowledged standing requirement.",
        timestamp: 2,
      }),
      { role: "user", content: params.latestAsk, timestamp: 3 },
    ] as AgentMessage[],
    turnPrefixMessages: [] as AgentMessage[],
    firstKeptEntryId: "entry-1",
    tokensBefore: params.tokensBefore,
    fileOps: {
      read: [],
      edited: [],
      written: [],
    },
    settings: { reserveTokens: 4_000 },
    previousSummary: undefined,
    isSplitTurn: false,
  },
  customInstructions: "",
  signal: params.signal ?? new AbortController().signal,
});

const createCompactionContext = (params: {
  sessionManager: ExtensionContext["sessionManager"];
  getApiKeyAndHeadersMock?: ReturnType<typeof vi.fn>;
  getApiKeyMock?: ReturnType<typeof vi.fn>;
}) =>
  ({
    model: undefined,
    sessionManager: params.sessionManager,
    modelRegistry: {
      getApiKeyAndHeaders:
        params.getApiKeyAndHeadersMock ??
        vi.fn(async (model) => {
          const legacyGetApiKey = params.getApiKeyMock as
            | undefined
            | ((model: NonNullable<ExtensionContext["model"]>) => Promise<string | undefined>);
          const apiKey = await legacyGetApiKey?.(model);
          return apiKey !== undefined ? { ok: true, apiKey } : { ok: false, error: "missing auth" };
        }),
    },
  }) as unknown as Partial<ExtensionContext>;

function withLatestUnresolvedUserRequest(event: unknown): unknown {
  if (!event || typeof event !== "object") {
    return event;
  }
  const eventRecord = event as {
    preparation?: { messagesToSummarize?: unknown; turnPrefixMessages?: unknown };
  };
  const preparation = eventRecord.preparation;
  if (!preparation || "latestUnresolvedUserRequest" in preparation) {
    return event;
  }
  const messages = [
    ...(Array.isArray(preparation.messagesToSummarize) ? preparation.messagesToSummarize : []),
    ...(Array.isArray(preparation.turnPrefixMessages) ? preparation.turnPrefixMessages : []),
  ];
  const latestUser = messages
    .toReversed()
    .find((message) => (message as { role?: unknown }).role === "user") as
    | { content?: unknown }
    | undefined;
  const latestUnresolvedUserRequest =
    typeof latestUser?.content === "string" ? latestUser.content.trim() : "";
  return {
    ...eventRecord,
    preparation: {
      ...preparation,
      ...(latestUnresolvedUserRequest ? { latestUnresolvedUserRequest } : {}),
    },
  };
}

async function runCompactionScenario(params: {
  sessionManager: ExtensionContext["sessionManager"];
  event: unknown;
  apiKey: string | null;
  latestUnresolvedUserRequest?: boolean;
}) {
  const compactionHandler = createCompactionHandler();
  const getApiKeyAndHeadersMock = vi
    .fn()
    .mockResolvedValue(
      params.apiKey !== null
        ? { ok: true, apiKey: params.apiKey }
        : { ok: false, error: "missing auth" },
    );
  const mockContext = createCompactionContext({
    sessionManager: params.sessionManager,
    getApiKeyAndHeadersMock,
  });
  const event = params.latestUnresolvedUserRequest
    ? withLatestUnresolvedUserRequest(params.event)
    : params.event;
  const result = (await compactionHandler(event, mockContext)) as {
    cancel?: boolean;
    compaction?: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
    };
  };
  return { result, getApiKeyAndHeadersMock };
}

function expectCompactionResult(result: {
  cancel?: boolean;
  compaction?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
  };
}) {
  expect(result.cancel).not.toBe(true);
  if (!result.compaction) {
    throw new Error("Expected compaction result");
  }
  return result.compaction;
}

const CANONICAL_SUMMARY_HEADINGS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
] as const;

function expectCanonicalSummaryHeadingsOnce(summary: string): void {
  for (const heading of CANONICAL_SUMMARY_HEADINGS) {
    expect(summary.split("\n").filter((line) => line.trim() === heading)).toHaveLength(1);
  }
}

function mockCallArg(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  callIndex = 0,
  argIndex = 0,
): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex + 1}`);
  }
  return call[argIndex];
}

function latestMockCallArg(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  argIndex = 0,
): unknown {
  return mockCallArg(mock, mock.mock.calls.length - 1, argIndex);
}

const requireRecord = createRequireRecord("object", "expected-record");

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("expected array");
  }
  return value;
}

describe("compaction safeguard semantic curation", () => {
  it("does not run input curation when the quality guard is disabled", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValueOnce(summaryResult("summary without quality guard"));

    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
      qualityGuardEnabled: false,
      qualityGuardMaxRetries: 1,
      semanticJudgmentsEnabled: true,
      semanticJudgmentCurationEnabled: true,
    });

    const event = createCompactionEvent({
      messageText: "summarize this conversation",
      tokensBefore: 1_500,
    });
    (
      event.preparation as { settings?: { reserveTokens: number }; isSplitTurn?: boolean }
    ).settings = {
      reserveTokens: 4_000,
    };
    (event.preparation as { isSplitTurn?: boolean }).isSplitTurn = false;

    const { result } = await runCompactionScenario({
      sessionManager,
      event,
      apiKey: "test-key",
    });

    expect(result.cancel).not.toBe(true);
    expect(mockCurateCompactionSummarizerInput).not.toHaveBeenCalled();
  });

  it("retries from original input when omitted tool evidence is missing from the retained summary", async () => {
    mockSummarizeInStages.mockReset();
    const userAsk = "Fix the parser tests.";
    const materialFact = "MATERIAL_RESULT: parser failure is caused by TOKEN_X.";
    const toolOutput = `${"routine test output\n".repeat(220)}${materialFact}`;
    const firstSummary = [
      "## Decisions",
      "Continue debugging.",
      "## Open TODOs",
      "Fix the parser tests.",
      "## Constraints/Rules",
      "None.",
      "## Pending user asks",
      userAsk,
      "## Exact identifiers",
      "None.",
    ].join("\n");
    const recoveredSummary = [
      "## Decisions",
      materialFact,
      "## Open TODOs",
      "Fix the parser tests.",
      "## Constraints/Rules",
      "Preserve the parser failure cause.",
      "## Pending user asks",
      userAsk,
      "## Exact identifiers",
      "TOKEN_X",
    ].join("\n");
    mockSummarizeInStages
      .mockResolvedValueOnce(summaryResult(firstSummary))
      .mockResolvedValueOnce(summaryResult(recoveredSummary));
    mockEvaluateDecision
      .mockResolvedValueOnce({
        status: "ok",
        result: {
          model: "fixture",
          answers: {
            "tool-result-1": {
              type: "choice",
              choice: "redundant",
              probabilities: {
                essential: 0.01,
                relevant: 0.02,
                redundant: 0.93,
                transient: 0.01,
                uncertain: 0.03,
              },
            },
          },
        },
        provenance: {
          providerId: "fixture",
          rubricVersion: "1",
          runtimeGeneration: "curation",
        },
      } satisfies DecisionOutcome)
      .mockResolvedValueOnce({
        status: "ok",
        result: {
          model: "fixture",
          answers: {
            "curated-tool-result-1": {
              type: "choice",
              choice: "missing",
              probabilities: {
                preserved: 0.01,
                missing: 0.94,
                contradicted: 0.01,
                inactive_or_completed: 0.01,
                uncertain: 0.03,
              },
            },
          },
        },
        provenance: {
          providerId: "fixture",
          rubricVersion: "1",
          runtimeGeneration: "fidelity",
        },
      } satisfies DecisionOutcome);

    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
      semanticJudgmentsEnabled: true,
      semanticJudgmentCurationEnabled: true,
    });
    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: userAsk, timestamp: 1 },
          castAgentMessage({
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: {} }],
            timestamp: 2,
          }),
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "exec",
            content: [{ type: "text", text: toolOutput }],
            timestamp: 3,
          },
          castAgentMessage({ role: "assistant", content: "Tests completed.", timestamp: 4 }),
        ] as AgentMessage[],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1_500,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4_000 },
        previousSummary: undefined,
        isSplitTurn: false,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const { result } = await runCompactionScenario({
      sessionManager,
      event,
      apiKey: "test-key",
    });

    expect(result.cancel).not.toBe(true);
    expect(mockEvaluateDecision).toHaveBeenCalledTimes(2);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
    const curatedCall = requireRecord(mockCallArg(mockSummarizeInStages, 0));
    expect(JSON.stringify(curatedCall.messages)).toContain(
      "omitted from compaction summarizer input",
    );
    expect(JSON.stringify(curatedCall.messages)).not.toContain(materialFact);
    const uncuratedCall = requireRecord(mockCallArg(mockSummarizeInStages, 1));
    expect(JSON.stringify(uncuratedCall.messages)).toContain(materialFact);
    expect(expectCompactionResult(result).summary).toContain(materialFact);
  });

  it("reserves the final retry for original input after curated deterministic quality failure", async () => {
    mockSummarizeInStages.mockReset();
    const userAsk = "Fix the parser tests.";
    const materialFact = "MATERIAL_RESULT: parser failure is caused by TOKEN_X.";
    const toolOutput = `${"routine test output\n".repeat(220)}${materialFact}`;
    const recoveredSummary = [
      "## Decisions",
      materialFact,
      "## Open TODOs",
      userAsk,
      "## Constraints/Rules",
      "Preserve the parser failure cause.",
      "## Pending user asks",
      userAsk,
      "## Exact identifiers",
      "TOKEN_X",
    ].join("\n");
    mockSummarizeInStages
      .mockResolvedValueOnce(summaryResult("invalid curated summary"))
      .mockResolvedValueOnce(summaryResult(recoveredSummary));
    mockEvaluateDecision.mockResolvedValueOnce({
      status: "ok",
      result: {
        model: "fixture",
        answers: {
          "tool-result-1": {
            type: "choice",
            choice: "redundant",
            probabilities: {
              essential: 0.01,
              relevant: 0.02,
              redundant: 0.93,
              transient: 0.01,
              uncertain: 0.03,
            },
          },
        },
      },
      provenance: {
        providerId: "fixture",
        rubricVersion: "1",
        runtimeGeneration: "curation",
      },
    } satisfies DecisionOutcome);

    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
      semanticJudgmentsEnabled: true,
      semanticJudgmentCurationEnabled: true,
    });
    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: userAsk, timestamp: 1 },
          castAgentMessage({
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: {} }],
            timestamp: 2,
          }),
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "exec",
            content: [{ type: "text", text: toolOutput }],
            timestamp: 3,
          },
          castAgentMessage({ role: "assistant", content: "Tests completed.", timestamp: 4 }),
        ] as AgentMessage[],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1_500,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4_000 },
        previousSummary: undefined,
        isSplitTurn: false,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const { result } = await runCompactionScenario({
      sessionManager,
      event,
      apiKey: "test-key",
    });

    expect(result.cancel).not.toBe(true);
    expect(mockEvaluateDecision).toHaveBeenCalledTimes(1);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
    const firstCall = requireRecord(mockCallArg(mockSummarizeInStages, 0));
    expect(JSON.stringify(firstCall.messages)).toContain(
      "omitted from compaction summarizer input",
    );
    expect(JSON.stringify(firstCall.messages)).not.toContain(materialFact);
    const secondCall = requireRecord(mockCallArg(mockSummarizeInStages, 1));
    expect(JSON.stringify(secondCall.messages)).toContain(materialFact);
    expect(secondCall.customInstructions).toContain(
      "final available corrective attempt is reserved for full source evidence",
    );
    expect(expectCompactionResult(result).summary).toContain(materialFact);
  });

  it("restores original input when post-curation semantic fidelity is unavailable", async () => {
    mockSummarizeInStages.mockReset();
    const userAsk = "Fix the parser tests.";
    const materialFact = "MATERIAL_RESULT: parser failure is caused by TOKEN_X.";
    const toolOutput = `${"routine test output\n".repeat(220)}${materialFact}`;
    const curatedSummary = [
      "## Decisions",
      "Continue debugging.",
      "## Open TODOs",
      userAsk,
      "## Constraints/Rules",
      "None.",
      "## Pending user asks",
      userAsk,
      "## Exact identifiers",
      "None.",
    ].join("\n");
    const recoveredSummary = [
      "## Decisions",
      materialFact,
      "## Open TODOs",
      userAsk,
      "## Constraints/Rules",
      "Preserve the parser failure cause.",
      "## Pending user asks",
      userAsk,
      "## Exact identifiers",
      "TOKEN_X",
    ].join("\n");
    mockSummarizeInStages
      .mockResolvedValueOnce(summaryResult(curatedSummary))
      .mockResolvedValueOnce(summaryResult(recoveredSummary));
    mockEvaluateDecision
      .mockResolvedValueOnce({
        status: "ok",
        result: {
          model: "fixture",
          answers: {
            "tool-result-1": {
              type: "choice",
              choice: "redundant",
              probabilities: {
                essential: 0.01,
                relevant: 0.02,
                redundant: 0.93,
                transient: 0.01,
                uncertain: 0.03,
              },
            },
          },
        },
        provenance: {
          providerId: "fixture",
          rubricVersion: "1",
          runtimeGeneration: "curation",
        },
      } satisfies DecisionOutcome)
      .mockResolvedValueOnce({
        status: "unavailable",
        reason: "circuit-open",
      } satisfies DecisionOutcome);

    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
      semanticJudgmentsEnabled: true,
      semanticJudgmentCurationEnabled: true,
    });
    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: userAsk, timestamp: 1 },
          castAgentMessage({
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: {} }],
            timestamp: 2,
          }),
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "exec",
            content: [{ type: "text", text: toolOutput }],
            timestamp: 3,
          },
          castAgentMessage({ role: "assistant", content: "Tests completed.", timestamp: 4 }),
        ] as AgentMessage[],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1_500,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4_000 },
        previousSummary: undefined,
        isSplitTurn: false,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const { result } = await runCompactionScenario({
      sessionManager,
      event,
      apiKey: "test-key",
    });

    expect(result.cancel).not.toBe(true);
    expect(mockEvaluateDecision).toHaveBeenCalledTimes(2);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
    const firstCall = requireRecord(mockCallArg(mockSummarizeInStages, 0));
    expect(JSON.stringify(firstCall.messages)).not.toContain(materialFact);
    const secondCall = requireRecord(mockCallArg(mockSummarizeInStages, 1));
    expect(JSON.stringify(secondCall.messages)).toContain(materialFact);
    expect(secondCall.customInstructions).toContain(
      "post-curation semantic fidelity check was unavailable",
    );
    expect(expectCompactionResult(result).summary).toContain(materialFact);
  });
});
