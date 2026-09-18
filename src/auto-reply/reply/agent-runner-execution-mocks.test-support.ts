import { vi } from "vitest";
import type { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import type { ModelFallbackRunResult } from "../../agents/model-fallback-attempt.js";
import type { runWithModelFallback } from "../../agents/model-fallback-runner.js";
import {
  initialModelFallbackAttemptOptions,
  withModelFallbackPreparation,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { isModelExecutionSelection } from "../../model-picker/execution-selection.js";
import type {
  buildEmbeddedRunExecutionParams,
  mintReplyMessageActionTurnCapability,
} from "./agent-runner-utils.js";

type FallbackRunnerParams = Parameters<typeof runWithModelFallback<unknown>>[0];
type RunEntryParams = Parameters<typeof runEmbeddedAgentEntry<EmbeddedAgentRunResult>>[0];
type RunEntryResult = Awaited<ReturnType<typeof runEmbeddedAgentEntry<EmbeddedAgentRunResult>>>;
type RunEntryDelegate = (params: RunEntryParams) => Promise<RunEntryResult>;
const state = vi.hoisted(() => ({
  runEmbeddedAgentMock: vi.fn(),
  runEmbeddedAgentEntryMock: vi.fn(),
  runCliAgentMock: vi.fn(),
  runWithModelFallbackMock:
    vi.fn<(params: FallbackRunnerParams) => Promise<ModelFallbackRunResult<unknown>>>(),
  isCliProviderMock: vi.fn((_provider: unknown) => false),
  isInternalMessageChannelMock: vi.fn((_channel: unknown) => false),
  createBlockReplyDeliveryHandlerMock: vi.fn(),
  isCompactionFailureErrorMock: vi.fn((_message: string | undefined) => false),
  isContextOverflowErrorMock: vi.fn((_message: string | undefined) => false),
  isLikelyContextOverflowErrorMock: vi.fn((_message: string | undefined) => false),
  updateSessionStoreMock: vi.fn(),
  resolveCurrentTurnImagesMock: vi.fn(),
  peekSessionMcpRuntimeMock: vi.fn(),
  recordMessageToolRunOutcomeMock: vi.fn(),
  mintReplyMessageActionTurnCapabilityMock: vi.fn<typeof mintReplyMessageActionTurnCapability>(),
  productionBuildEmbeddedRunExecutionParams: undefined as
    | typeof buildEmbeddedRunExecutionParams
    | undefined,
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: (params: unknown) => state.runEmbeddedAgentMock(params),
}));

vi.mock("../../agents/embedded-agent-runner/run-entry.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../agents/embedded-agent-runner/run-entry.js")
  >("../../agents/embedded-agent-runner/run-entry.js");
  return {
    ...actual,
    runEmbeddedAgentEntry: (params: RunEntryParams) =>
      state.runEmbeddedAgentEntryMock(params, actual.runEmbeddedAgentEntry as RunEntryDelegate),
  };
});

vi.mock("../../agents/agent-bundle-mcp-manager-api.js", () => ({
  peekSessionMcpRuntime: (params: unknown) => state.peekSessionMcpRuntimeMock(params),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (params: unknown) => state.runCliAgentMock(params),
}));

vi.mock("../../agents/harness/runtime-plugin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/harness/runtime-plugin.js")>()),
  ensureSelectedAgentHarnessPlugin: vi.fn(),
}));
vi.mock("../../agents/model-fallback-runner.js", () => ({
  runWithModelFallback: async (params: Parameters<typeof runWithModelFallback<unknown>>[0]) => {
    return withModelFallbackPreparation(params, state.runWithModelFallbackMock);
  },
}));

vi.mock("../../agents/model-fallback-attempt.js", () => ({
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("../../agents/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/model-selection.js")>(
    "../../agents/model-selection.js",
  );
  return {
    ...actual,
    isCliProvider: (provider: unknown) => state.isCliProviderMock(provider),
  };
});

vi.mock("../../agents/bootstrap-budget.js", async () => ({
  ...(await vi.importActual<typeof import("../../agents/bootstrap-budget.js")>(
    "../../agents/bootstrap-budget.js",
  )),
  resolveBootstrapWarningSignaturesSeen: () => [],
}));

vi.mock("../../agents/embedded-agent-helpers.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/embedded-agent-helpers.js")>(
    "../../agents/embedded-agent-helpers.js",
  );
  return {
    ...actual,
    formatBillingErrorMessage: actual.formatBillingErrorMessage,
    isCompactionFailureError: (message?: string) => state.isCompactionFailureErrorMock(message),
    isContextOverflowError: (message?: string) => state.isContextOverflowErrorMock(message),
    isLikelyContextOverflowError: (message?: string) =>
      state.isLikelyContextOverflowErrorMock(message),
    sanitizeUserFacingText: (text?: string) => text ?? "",
  };
});

vi.mock("../../config/sessions.js", () => ({
  resolveGroupSessionKey: vi.fn(() => null),
  resolveSessionTranscriptPath: vi.fn(),
  updateSessionStore: state.updateSessionStoreMock,
}));

vi.mock("../../globals.js", async () => ({
  ...(await vi.importActual<typeof import("../../globals.js")>("../../globals.js")),
  logVerbose: vi.fn(),
}));

vi.mock("../../infra/agent-events.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/agent-events.js")>(
    "../../infra/agent-events.js",
  );
  const emitAgentEvent = vi.fn((...args: Parameters<typeof actual.emitAgentEvent>) =>
    actual.emitAgentEvent(...args),
  );
  return {
    ...actual,
    clearAgentRunContext: vi.fn(),
    emitAgentEvent,
    registerAgentRunContext: vi.fn(),
  };
});
vi.mock("../../infra/agent-run-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/agent-run-registry.js")>(
    "../../infra/agent-run-registry.js",
  );
  return {
    ...actual,
    clearAgentRunContext: vi.fn(),
    registerAgentRunContext: vi.fn(),
  };
});

vi.mock("../../infra/message-tool-run-outcome-store.js", () => ({
  recordMessageToolRunOutcome: (params: unknown) => state.recordMessageToolRunOutcomeMock(params),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
  },
}));

vi.mock("../../utils/message-channel.js", async () => ({
  ...(await vi.importActual<typeof import("../../utils/message-channel.js")>(
    "../../utils/message-channel.js",
  )),
  isMarkdownCapableMessageChannel: () => true,
  resolveMessageChannel: () => "whatsapp",
  isInternalMessageChannel: (value: unknown) => state.isInternalMessageChannelMock(value),
}));

vi.mock("../heartbeat.js", async () => {
  const actual = await vi.importActual<typeof import("../heartbeat.js")>("../heartbeat.js");
  return {
    ...actual,
    stripHeartbeatToken: (text: string) => ({
      text,
      didStrip: false,
      shouldSkip: false,
    }),
  };
});

vi.mock("./current-turn-images.js", () => ({
  resolveCurrentTurnImages: (params: unknown) => state.resolveCurrentTurnImagesMock(params),
}));

vi.mock("./agent-runner-utils.js", async () => ({
  ...(await vi.importActual<typeof import("./agent-runner-utils.js")>("./agent-runner-utils.js")),
  mintReplyMessageActionTurnCapability: state.mintReplyMessageActionTurnCapabilityMock,
  buildEmbeddedRunExecutionParams: (
    params: Parameters<typeof buildEmbeddedRunExecutionParams>[0],
  ) =>
    // Most execution tests isolate fallback policy from config/channel discovery. Ownership
    // regressions opt into the production builder so queue metadata must cross the real boundary.
    state.productionBuildEmbeddedRunExecutionParams
      ? state.productionBuildEmbeddedRunExecutionParams(params)
      : {
          embeddedContext: {
            ...params.run,
            messageProvider: params.replyRoute?.originatingChannel,
            messageTo: params.replyRoute?.originatingTo,
            agentAccountId:
              params.replyRoute?.originatingAccountId ??
              params.sessionCtx.AccountId ??
              params.run.agentAccountId,
            chatType:
              params.replyRoute?.originatingChatType ??
              params.sessionCtx.ChatType ??
              params.run.chatType,
          },
          senderContext: {},
          runBaseParams: {
            runId: params.runId,
            provider: isModelExecutionSelection(params.run.executionSelection)
              ? params.run.executionSelection.model.provider
              : undefined,
            model: isModelExecutionSelection(params.run.executionSelection)
              ? params.run.executionSelection.model.id
              : undefined,
            thinkLevel: params.run.thinkLevel,
            authProfileId: isModelExecutionSelection(params.run.executionSelection)
              ? params.run.authProfileId
              : undefined,
            authProfileIdSource: isModelExecutionSelection(params.run.executionSelection)
              ? params.run.authProfileIdSource
              : undefined,
          },
        },
  resolveQueuedReplyRuntimeConfig: <T>(config: T) => config,
  resolveRunFastModeForFallbackCandidate: (params: {
    run: { fastMode?: unknown; fastModeAutoOnSeconds?: unknown };
  }) => ({
    fastMode: params.run.fastMode,
    fastModeAutoOnSeconds: params.run.fastModeAutoOnSeconds,
  }),
}));

vi.mock("./reply-delivery.js", () => ({
  createBlockReplyDeliveryHandler: (params: unknown) =>
    state.createBlockReplyDeliveryHandlerMock(params),
}));

vi.mock("./reply-media-paths.runtime.js", () => ({
  createReplyMediaContext: () => ({
    normalizePayload: (payload: unknown) => payload,
  }),
  createReplyMediaPathNormalizer: () => (payload: unknown) => payload,
}));

export function resetExecutionMocks(): void {
  state.runEmbeddedAgentMock.mockReset();
  state.runEmbeddedAgentEntryMock
    .mockReset()
    .mockImplementation((params: RunEntryParams, delegate: RunEntryDelegate) => delegate(params));
  state.runCliAgentMock.mockReset();
  state.runWithModelFallbackMock.mockReset();
  state.isCliProviderMock.mockReset().mockReturnValue(false);
  state.isInternalMessageChannelMock.mockReset().mockReturnValue(false);
  state.createBlockReplyDeliveryHandlerMock.mockReset().mockReturnValue(undefined);
  state.isCompactionFailureErrorMock.mockReset().mockReturnValue(false);
  state.isContextOverflowErrorMock.mockReset().mockReturnValue(false);
  state.isLikelyContextOverflowErrorMock.mockReset().mockReturnValue(false);
  state.updateSessionStoreMock.mockReset();
  state.resolveCurrentTurnImagesMock.mockReset();
  state.peekSessionMcpRuntimeMock.mockReset().mockReturnValue(undefined);
  state.recordMessageToolRunOutcomeMock.mockReset();
  state.mintReplyMessageActionTurnCapabilityMock.mockReset();
  state.productionBuildEmbeddedRunExecutionParams = undefined;
  state.resolveCurrentTurnImagesMock.mockImplementation(
    async (params: { images?: unknown[]; imageOrder?: unknown[] }) => ({
      images: params.images,
      imageOrder: params.imageOrder,
    }),
  );
  state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => ({
    outcome: "completed",
    result: await params.run(
      params.provider,
      params.model,
      initialModelFallbackAttemptOptions(params),
    ),
    provider: params.provider,
    model: params.model,
    attempts: [],
  }));
}

export { state };
