import * as agentHarnessToolRuntime from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settleReplyDispatcher } from "../../auto-reply/dispatch-dispatcher.js";
import * as replyPayloadRuntime from "../../auto-reply/reply-payload.js";
import {
  createFollowupRun,
  configureTestCliModel,
  configureTestExecution,
  testModel,
  testAuthProfiles,
  createMockTypingSignaler,
  getExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
  type FallbackRunnerParams,
  useProductionEmbeddedRunExecutionParamsForTest,
} from "../../auto-reply/reply/agent-runner-execution.test-support.js";
import {
  emptyConfig,
  runtimePluginMocks,
  sessionStoreMocks,
} from "../../auto-reply/reply/dispatch-from-config.shared.test-harness.js";
import {
  describe2BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "../../auto-reply/reply/dispatch-from-config.test-harness.js";
import type { InternalGetReplyOptions } from "../../auto-reply/reply/get-reply.types.js";
import { buildDirectChatContext } from "../../auto-reply/reply/groups.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import {
  bindSourceReplyDeliveryRuntime,
  createSourceReplyDeliveryRuntime,
  type SourceReplyDeliveryRuntimeOptions,
} from "../../auto-reply/reply/source-reply-delivery-runtime.js";
import { buildTestCtx } from "../../auto-reply/reply/test-ctx.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { GetReplyOptions, ReplyPayload } from "../../auto-reply/types.js";
import type { ModelExecutionSelection } from "../../model-picker/execution-selection.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { FailoverReason } from "../failover/signal.js";
import type { AgentHarnessHostCapabilities } from "../harness/host-capability-types.js";
import { registerAgentHarness } from "../harness/registry.js";
import * as preparedModelCatalogRuntime from "../prepared-model-catalog.js";
import * as preparedModelRuntimeAuth from "../prepared-model-runtime-auth.js";
import { markCoreTtsAttemptResult } from "../tools/tts-tool-result-provenance.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedAcquireAgentRunPreparedModelRuntime,
  mockedBuildEmbeddedRunPayloads,
  mockedBuildAgentRuntimePlan,
  mockedEnsureAuthProfileStore,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { registerPreparedRuntimeGenerationTests } from "./run.prepared-runtime-generation.test-support.js";
import type { RunEmbeddedAgentInternalParams } from "./run/internal-params.js";
import { buildEmbeddedSystemPrompt } from "./system-prompt.js";

const runnerState = await setupAgentRunnerExecutionTestState();

type TestRouteStage = { stage: "initial" } | { stage: "fallback"; fallbackReason: FailoverReason };

function runAdmittedAttempt(
  params: FallbackRunnerParams,
  provider: string,
  model: string,
  route: TestRouteStage,
) {
  return params.run(provider, model, {
    modelRoutingProvenance: {
      requestedProvider: params.provider,
      requestedModel: params.model,
      ...route,
    },
  });
}

beforeAll(globalBeforeAll0);

describe("prepared harness source delivery", () => {
  let state: OpenClawTestState;
  let restoreSynthesis: (() => void) | undefined;
  async function loadSourceDeliveryHarness() {
    // The runner resets modules; keep dispatch metadata and published catalog/auth together.
    vi.doMock("../../auto-reply/reply-payload.js", () => replyPayloadRuntime);
    vi.doMock("../prepared-model-catalog.js", () => preparedModelCatalogRuntime);
    vi.doMock("../prepared-model-runtime-auth.js", () => preparedModelRuntimeAuth);
    const loaded = await loadRunOverflowCompactionHarness();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "prepared-source-delivery" });
    return loaded;
  }
  afterEach(async () => {
    restoreSynthesis?.();
    restoreSynthesis = undefined;
    await state?.cleanup();
  });
  beforeEach(describe2BeforeEach0);

  it.each([
    {
      name: "delivers one streamed answer when preparation changes tool ownership to automatic",
      candidatePath: "cli-failure-embedded" as const,
      preliminaryVisibleReplies: "message_tool" as const,
      preparedVisibleReplies: "automatic" as const,
      expectedTransitions: ["message_tool_only", "automatic"],
      expectedDeliveries: 1,
      expectedPartials: 1,
      expectedBlocks: 1,
      expectedFinals: 1,
    },
    {
      name: "suppresses live output when an automatic preview prepares the accepted tool owner",
      candidatePath: "embedded" as const,
      preliminaryVisibleReplies: "automatic" as const,
      preparedVisibleReplies: "message_tool" as const,
      expectedTransitions: ["message_tool_only"],
      expectedDeliveries: 0,
      expectedPartials: 0,
      expectedBlocks: 0,
      expectedFinals: 0,
    },
    {
      name: "replaces the built-in automatic preview with accepted tool delivery",
      candidatePath: "embedded" as const,
      preliminaryVisibleReplies: undefined,
      preparedVisibleReplies: "message_tool" as const,
      expectedTransitions: ["message_tool_only"],
      expectedDeliveries: 0,
      expectedPartials: 0,
      expectedBlocks: 0,
      expectedFinals: 0,
    },
    {
      name: "keeps prepared tool ownership after a failed CLI primary",
      candidatePath: "cli-failure-embedded" as const,
      preliminaryVisibleReplies: "automatic" as const,
      preparedVisibleReplies: "message_tool" as const,
      expectedTransitions: ["automatic", "message_tool_only"],
      expectedDeliveries: 0,
      expectedPartials: 0,
      expectedBlocks: 0,
      expectedFinals: 0,
    },
    {
      name: "delivers a successful direct CLI reply with its session-stable ownership",
      candidatePath: "cli" as const,
      preliminaryVisibleReplies: undefined,
      preparedVisibleReplies: "automatic" as const,
      expectedTransitions: ["automatic"],
      expectedDeliveries: 1,
      expectedPartials: 0,
      expectedBlocks: 0,
      expectedFinals: 1,
    },
    {
      name: "delivers a successful direct-harness-to-CLI fallback with its session-stable ownership",
      candidatePath: "embedded-failure-cli" as const,
      preliminaryVisibleReplies: undefined,
      preparedVisibleReplies: "automatic" as const,
      expectedTransitions: ["automatic", "automatic"],
      expectedDeliveries: 1,
      expectedPartials: 0,
      expectedBlocks: 0,
      expectedFinals: 1,
    },
    {
      name: "delivers genuine host TTS through prepared harness result projections",
      candidatePath: "embedded" as const,
      preliminaryVisibleReplies: "automatic" as const,
      preparedVisibleReplies: "message_tool" as const,
      expectedTransitions: ["message_tool_only"],
      expectedDeliveries: 1,
      expectedPartials: 0,
      expectedBlocks: 0,
      expectedFinals: 1,
      genuineTtsDelivery: true,
    },
    {
      name: "rejects a native harness attempt to mint TTS source delivery",
      candidatePath: "embedded" as const,
      preliminaryVisibleReplies: "automatic" as const,
      preparedVisibleReplies: "message_tool" as const,
      expectedTransitions: ["message_tool_only"],
      expectedDeliveries: 0,
      expectedPartials: 0,
      expectedBlocks: 0,
      expectedFinals: 0,
      forgedTtsDelivery: true,
    },
  ])("$name", async (testCase) => {
    const forgedTtsDelivery =
      "forgedTtsDelivery" in testCase && testCase.forgedTtsDelivery === true;
    const genuineTtsDelivery =
      "genuineTtsDelivery" in testCase && testCase.genuineTtsDelivery === true;
    await useProductionEmbeddedRunExecutionParamsForTest();
    const { createBlockReplyDeliveryHandler } = await vi.importActual<
      typeof import("../../auto-reply/reply/reply-delivery.js")
    >("../../auto-reply/reply/reply-delivery.js");
    runnerState.createBlockReplyDeliveryHandlerMock.mockImplementation((params) =>
      createBlockReplyDeliveryHandler(
        params as Parameters<typeof createBlockReplyDeliveryHandler>[0],
      ),
    );
    const audioPath = "/tmp/prepared-host-tts.opus";
    let retainedHost: AgentHarnessHostCapabilities | undefined;
    const synthesis = vi.fn().mockResolvedValue({
      success: true,
      audioPath,
      provider: "test-speech",
      audioAsVoice: true,
    });
    if (genuineTtsDelivery) {
      const ttsFixture = await import("../../tts/tts.js");
      vi.doMock("../../tts/tts.js", () => ({ ...ttsFixture, textToSpeech: synthesis }));
      restoreSynthesis = () => vi.doMock("../../tts/tts.js", () => ttsFixture);
    }
    const { runEmbeddedAgent, registerPreparedAgentHarness } = await loadSourceDeliveryHarness();
    const authOrder = await import("../auth-profiles/order.js");
    const actualAuthOrder = await vi.importActual<typeof import("../auth-profiles/order.js")>(
      "../auth-profiles/order.js",
    );
    vi.mocked(authOrder.resolveAuthProfileOrderWithMetadata).mockImplementation(
      actualAuthOrder.resolveAuthProfileOrderWithMetadata,
    );
    const { resolveCodexTtsProvenanceTransfer } =
      await import("../../plugin-sdk/codex-mcp-projection.js");
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_model_resolve",
    );
    const followupRun = createFollowupRun();
    const cliPrimary = configureTestCliModel(
      followupRun,
      "anthropic",
      "cli-primary",
      "claude-cli",
      "anthropic",
    );
    configureTestCliModel(followupRun, "anthropic", "cli-fallback", "claude-cli", "anthropic");
    const startsWithCli =
      testCase.candidatePath === "cli" || testCase.candidatePath === "cli-failure-embedded";
    const directHarnessFails = testCase.candidatePath === "embedded-failure-cli";
    const embeddedSelection: ModelExecutionSelection = {
      model:
        testCase.preparedVisibleReplies === "message_tool"
          ? { provider: "openai", id: "gpt-5.4" }
          : { provider: "custom", id: "plugin-fallback" },
      executor: {
        kind: "harness",
        id: testCase.preparedVisibleReplies === "message_tool" ? "codex" : "openclaw",
      },
    };
    const primarySelection: ModelExecutionSelection = startsWithCli
      ? cliPrimary
      : directHarnessFails
        ? {
            model: { provider: "custom", id: "api-primary" },
            executor: { kind: "harness", id: "source-test-primary" },
          }
        : embeddedSelection;
    const embeddedModel = directHarnessFails ? primarySelection.model : embeddedSelection.model;
    const profiles = {
      ...testAuthProfiles("custom", "openai"),
      "anthropic:fixture": {
        type: "token" as const,
        provider: "anthropic",
        token: "synthetic-cli-token",
      },
    };
    const catalog = [
      testModel("custom", "api-primary", { api: "anthropic-messages" }),
      testModel("custom", "plugin-fallback", { api: "anthropic-messages" }),
      testModel("openai", "gpt-5.4", { api: "openai-responses" }),
      testModel("anthropic", "cli-primary", { api: "anthropic-messages" }),
      testModel("anthropic", "cli-fallback", { api: "anthropic-messages" }),
    ];
    const cfg = followupRun.run.config;
    configureTestExecution(followupRun, {
      selection: primarySelection,
      config: {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            model: { primary: `${primarySelection.model.provider}/${primarySelection.model.id}` },
            models: {
              ...cfg.agents?.defaults?.models,
              [`${embeddedSelection.model.provider}/${embeddedSelection.model.id}`]: {
                agentRuntime: { id: embeddedSelection.executor.id },
              },
              ...(directHarnessFails
                ? { "custom/api-primary": { agentRuntime: { id: "source-test-primary" } } }
                : {}),
            },
          },
        },
      },
      catalog,
      profiles,
      runtimeAuthModes: { "claude-cli": "token" },
      fallbacks:
        testCase.candidatePath === "cli-failure-embedded"
          ? [`${embeddedSelection.model.provider}/${embeddedSelection.model.id}`]
          : directHarnessFails
            ? ["anthropic/cli-fallback"]
            : [],
    });
    mockedGlobalHookRunner.runBeforeModelResolve.mockResolvedValue({
      providerOverride: embeddedModel.provider,
      modelOverride: embeddedModel.id,
    });
    const modelAuth = await import("../model-auth.js");
    vi.mocked(modelAuth.resolveAuthProfileOrder).mockImplementation(
      actualAuthOrder.resolveAuthProfileOrder,
    );
    mockedEnsureAuthProfileStore.mockReturnValue({ version: 1, profiles });
    const runtimePlan = mockedBuildAgentRuntimePlan();
    mockedBuildAgentRuntimePlan.mockReturnValue({
      ...runtimePlan,
      auth: {
        ...runtimePlan.auth,
        authProfileProviderForAuth: embeddedModel.provider,
        providerForAuth: embeddedModel.provider,
      },
      observability: {
        ...runtimePlan.observability,
        harnessId: directHarnessFails ? "source-test-primary" : embeddedSelection.executor.id,
      },
    });
    if (directHarnessFails) {
      registerPreparedAgentHarness({
        id: "source-test-primary",
        label: "Primary test app",
        deliveryDefaults: { visibleReplies: "automatic" },
        supports: ({ provider, modelId }) =>
          provider === "custom" && modelId === "api-primary"
            ? { supported: true }
            : {
                supported: false,
                reason: "This test app does not implement this route.",
                ...(provider === "anthropic" && modelId === "cli-fallback"
                  ? { fallbackRuntime: "openclaw" as const }
                  : {}),
              },
        runAttempt: async () => {
          throw new Error("primary harness failed");
        },
      });
    }
    const emittedStreamingCallbacks: string[] = [];
    let forbiddenSdkAuthorityObserved = false;
    let modelVisiblePrompt = "";
    const recordModelVisiblePrompt = (attemptParams: {
      extraSystemPrompt?: string;
      forceMessageTool?: boolean;
      sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    }) => {
      modelVisiblePrompt = buildEmbeddedSystemPrompt({
        workspaceDir: followupRun.run.workspaceDir,
        reasoningTagHint: false,
        extraSystemPrompt: attemptParams.extraSystemPrompt,
        sourceReplyDeliveryMode: attemptParams.sourceReplyDeliveryMode,
        runtimeInfo: {
          host: "host",
          os: "linux",
          arch: "arm64",
          node: "24",
          model: "model",
          provider: "custom",
          channel: "discord",
          chatType: "direct",
        },
        tools: attemptParams.forceMessageTool ? [{ name: "message" } as never] : [],
        userTimezone: "UTC",
        userDate: "2026-08-11",
      });
    };
    mockedBuildEmbeddedRunPayloads.mockReturnValue(
      forgedTtsDelivery || genuineTtsDelivery ? [] : [{ text: "Short fallback final" }],
    );
    mockedRunEmbeddedAttempt.mockImplementation(async (attemptParams) => {
      recordModelVisiblePrompt(attemptParams);
      emittedStreamingCallbacks.push("partial");
      await attemptParams.onPartialReply?.({ text: "Short fallback final" });
      emittedStreamingCallbacks.push("block");
      await attemptParams.onBlockReply?.({ text: "Streaming progress" });
      return makeAttemptResult({ assistantTexts: ["Short fallback final"] });
    });
    runnerState.runEmbeddedAgentMock.mockImplementationOnce(runEmbeddedAgent);
    runnerState.isCliProviderMock.mockImplementation(
      (provider: unknown) => provider === "anthropic",
    );
    if (testCase.candidatePath === "cli-failure-embedded") {
      runnerState.runCliAgentMock.mockRejectedValueOnce(new Error("cli failed"));
    } else {
      runnerState.runCliAgentMock.mockResolvedValue({
        payloads: [{ text: "Short fallback final" }],
        meta: {},
      });
    }
    runnerState.runWithModelFallbackMock.mockImplementationOnce(
      async (params: FallbackRunnerParams) => {
        if (testCase.candidatePath === "cli-failure-embedded") {
          await runAdmittedAttempt(params, "anthropic", "cli-primary", {
            stage: "initial",
          }).catch(() => undefined);
        }
        if (testCase.candidatePath === "cli") {
          return {
            outcome: "completed",
            result: await runAdmittedAttempt(params, "anthropic", "cli-primary", {
              stage: "initial",
            }),
            provider: "anthropic",
            model: "cli-primary",
            attempts: [],
          };
        }
        if (testCase.candidatePath === "embedded-failure-cli") {
          await runAdmittedAttempt(params, "custom", "api-primary", {
            stage: "initial",
          }).catch(() => undefined);
          return {
            outcome: "completed",
            result: await runAdmittedAttempt(params, "anthropic", "cli-fallback", {
              stage: "fallback",
              fallbackReason: "unknown",
            }),
            provider: "anthropic",
            model: "cli-fallback",
            attempts: [],
          };
        }
        return {
          outcome: "completed",
          result: await runAdmittedAttempt(
            params,
            embeddedSelection.model.provider,
            embeddedSelection.model.id,
            testCase.candidatePath === "cli-failure-embedded"
              ? { stage: "fallback", fallbackReason: "unknown" }
              : { stage: "initial" },
          ),
          provider: embeddedSelection.model.provider,
          model: embeddedSelection.model.id,
          attempts: [],
        };
      },
    );

    // Dispatch previews registered delivery defaults before reply preparation.
    // The accepted harness prepares its declared route after that preview.
    if (testCase.preliminaryVisibleReplies !== undefined) {
      registerAgentHarness({
        id: "preliminary-owner",
        label: "Preliminary owner",
        deliveryDefaults: { visibleReplies: testCase.preliminaryVisibleReplies },
        supports: ({ modelProvider }) =>
          testCase.preparedVisibleReplies === "automatic" && modelProvider?.preparedAuth
            ? { supported: false, reason: "raw route only" }
            : { supported: true, priority: 100 },
        runAttempt: async () => {
          throw new Error("The delivery preview must not execute a candidate.");
        },
      });
    }
    if (testCase.preparedVisibleReplies === "message_tool") {
      registerPreparedAgentHarness(
        {
          id: "codex",
          label: "Prepared tool owner",
          deliveryDefaults: { visibleReplies: "message_tool" },
          supports: ({ provider, modelId }) =>
            provider === embeddedSelection.model.provider && modelId === embeddedSelection.model.id
              ? { supported: true, priority: 200 }
              : { supported: false, reason: "This test app only implements its declared route." },
          runAttempt: vi.fn(async (attemptParams) => {
            recordModelVisiblePrompt(attemptParams);
            emittedStreamingCallbacks.push("partial");
            await attemptParams.onPartialReply?.({ text: "Short fallback final" });
            emittedStreamingCallbacks.push("block");
            await attemptParams.onBlockReply?.({ text: "Streaming progress" });
            const result = makeAttemptResult(
              forgedTtsDelivery || genuineTtsDelivery
                ? {
                    assistantTexts: [],
                    toolMediaUrls: [genuineTtsDelivery ? audioPath : "/tmp/plugin.opus"],
                    toolAudioAsVoice: true,
                    toolTrustedLocalMedia: true,
                  }
                : { assistantTexts: ["Short fallback final"] },
            );
            if (genuineTtsDelivery) {
              retainedHost = attemptParams.hostCapabilities;
              if (!retainedHost) {
                throw new Error("expected the selected harness host capability");
              }
              const tts = retainedHost
                .createToolSurface?.({ config: attemptParams.config })
                .find((tool) => tool.name === "tts");
              const toolResult = await tts?.execute?.("call-prepared-tts", { text: "Hello" });
              expect(toolResult).toBeDefined();
              expect(synthesis).toHaveBeenCalledOnce();
              const transfer = resolveCodexTtsProvenanceTransfer(retainedHost);
              expect(transfer).toBeTypeOf("function");
              transfer?.(toolResult, result, [audioPath]);
            }
            if (forgedTtsDelivery) {
              const publicAttester = Reflect.get(
                agentHarnessToolRuntime,
                "markCoreTtsAttemptResult",
              );
              const publicTransfer = Reflect.get(
                agentHarnessToolRuntime,
                "transferCoreTtsToolResultProvenance",
              );
              forbiddenSdkAuthorityObserved =
                typeof publicAttester === "function" || typeof publicTransfer === "function";
              if (typeof publicAttester === "function") {
                Reflect.apply(publicAttester, undefined, [result, ["/tmp/plugin.opus"]]);
              } else {
                Reflect.set(result, "toolAutoDeliveryMediaUrls", ["/tmp/plugin.opus"]);
              }
              // A valid private marker from a different, closed attempt must not replay here.
              markCoreTtsAttemptResult(result, ["/tmp/plugin.opus"], {});
            }
            return result;
          }),
        },
        genuineTtsDelivery ? { ownerPluginId: "codex" } : undefined,
      );
    }
    sessionStoreMocks.currentEntry = {
      sessionId: "session",
      updatedAt: 0,
      sendPolicy: "allow",
    };
    setNoAbort();
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const { requireActivePluginRegistry } = await import("../../plugins/runtime.js");
    runtimePluginMocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(
      requireActivePluginRegistry(),
    );
    const modeTransitions: string[] = [];
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const runtimeOpts = opts as InternalGetReplyOptions & SourceReplyDeliveryRuntimeOptions;
      expect(runtimeOpts.sourceReplyDeliveryMode).toBe(
        testCase.preliminaryVisibleReplies === "message_tool" ? "message_tool_only" : "automatic",
      );
      expect(runtimeOpts.sourceReplyDeliveryModeOrigin).toBe("runtime_default");
      const outerModeCallback = runtimeOpts.onSourceReplyDeliveryModeResolved;
      runtimeOpts.onSourceReplyDeliveryModeResolved = (mode) => {
        modeTransitions.push(mode);
        outerModeCallback?.(mode);
      };
      followupRun.run.thinkingCatalog = catalog;
      followupRun.run.sessionKey = undefined;
      followupRun.run.sessionFile = followupRun.run.sessionId;
      followupRun.run.sourceReplyDeliveryMode = runtimeOpts.sourceReplyDeliveryMode;
      const extraSystemPromptBySourceReplyDeliveryMode = {
        automatic: buildDirectChatContext({
          sessionCtx: { Provider: "discord", ChatType: "direct" },
          sourceReplyDeliveryMode: "automatic",
        }),
        message_tool_only: buildDirectChatContext({
          sessionCtx: { Provider: "discord", ChatType: "direct" },
          sourceReplyDeliveryMode: "message_tool_only",
        }),
      };
      followupRun.run.extraSystemPrompt =
        extraSystemPromptBySourceReplyDeliveryMode[
          runtimeOpts.sourceReplyDeliveryMode ?? "automatic"
        ];
      const sessionStableDeliveryMode =
        runtimeOpts.sessionPromptSourceReplyDeliveryMode ??
        runtimeOpts.sourceReplyDeliveryMode ??
        "automatic";
      followupRun.run.cliSessionBindingFacts = {
        extraSystemPromptStatic:
          extraSystemPromptBySourceReplyDeliveryMode[sessionStableDeliveryMode],
        sourceReplyDeliveryMode: sessionStableDeliveryMode,
      };
      const sourceReplyDeliveryRuntime = createSourceReplyDeliveryRuntime({
        origin: runtimeOpts.sourceReplyDeliveryModeOrigin ?? "stable_policy",
        initialMode: runtimeOpts.sourceReplyDeliveryMode ?? "automatic",
        projections: [followupRun.run, runtimeOpts],
        promptComponentByMode: extraSystemPromptBySourceReplyDeliveryMode,
        promptComponentOffset: 0,
        onModeResolved: runtimeOpts.onSourceReplyDeliveryModeResolved,
      });
      bindSourceReplyDeliveryRuntime(followupRun.run, sourceReplyDeliveryRuntime);
      // Dispatch already captured its session snapshot; the embedded fixture uses
      // a SQLite compatibility key and has no durable row for writer admission.
      sessionStoreMocks.currentEntry = undefined;
      const execution = await executeAgentTurn({
        commandBody: "hello",
        followupRun,
        sessionCtx: buildTestCtx({ Provider: "discord", MessageSid: "msg" }),
        opts: runtimeOpts,
        typingSignals: createMockTypingSignaler(),
        blockReplyPipeline: null,
        blockStreamingEnabled: true,
        resolvedBlockStreamingBreak: "message_end",
        applyReplyToMode: (payload) => payload,
        shouldEmitToolResult: () => true,
        shouldEmitToolOutput: () => false,
        pendingToolTasks: new Set(),
        resetSessionAfterRoleOrderingConflict: async () => false,
        isHeartbeat: false,
        sessionKey: "main",
        getActiveSessionEntry: () => undefined,
        resolvedVerboseLevel: "off",
      });
      if (execution.kind !== "success") {
        throw new Error(`expected settled fallback execution: ${JSON.stringify(execution)}`);
      }
      const payload = execution.runResult.payloads?.[0];
      if (!payload) {
        throw new Error("expected settled fallback payload");
      }
      if (genuineTtsDelivery) {
        const { getReplyPayloadMetadata } = await import("../../auto-reply/reply-payload.js");
        expect(getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression).toBe(true);
      }
      return payload satisfies ReplyPayload;
    });
    const deliver = vi.fn(async () => {});
    const onPartialReply = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({ deliver });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ ChatType: "direct", SessionKey: "agent:main:main" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { onPartialReply },
    });
    await settleReplyDispatcher({ dispatcher });
    expect(replyResolver).toHaveBeenCalledOnce();
    const [resolverOutcome] = replyResolver.mock.results;
    if (resolverOutcome?.type === "return") {
      await resolverOutcome.value;
    }

    if (genuineTtsDelivery) {
      expect(retainedHost).toBeDefined();
      expect(() => retainedHost?.assertActive()).toThrow("no longer active");
    }
    if (testCase.candidatePath === "cli") {
      expect(mockedGlobalHookRunner.runBeforeModelResolve).not.toHaveBeenCalled();
    } else {
      expect(mockedGlobalHookRunner.runBeforeModelResolve).toHaveBeenCalledWith(
        { prompt: "hello" },
        expect.any(Object),
      );
    }
    const cliSucceeded =
      testCase.candidatePath === "cli" || testCase.candidatePath === "embedded-failure-cli";
    expect(emittedStreamingCallbacks).toEqual(cliSucceeded ? [] : ["partial", "block"]);
    expect(onPartialReply).toHaveBeenCalledTimes(testCase.expectedPartials);
    expect(result.queuedFinal).toBe(testCase.expectedDeliveries === 1);
    expect(deliver).toHaveBeenCalledTimes(testCase.expectedDeliveries + testCase.expectedBlocks);
    if (testCase.expectedBlocks === 1) {
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Streaming progress" }),
        expect.objectContaining({ kind: "block" }),
      );
    }
    if (testCase.expectedDeliveries === 1) {
      expect(result.sourceReplyDeliveryMode).toBe(
        genuineTtsDelivery ? "message_tool_only" : undefined,
      );
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining(
          genuineTtsDelivery
            ? { mediaUrl: audioPath, audioAsVoice: true }
            : { text: "Short fallback final" },
        ),
        expect.objectContaining({ kind: "final" }),
      );
    } else {
      expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(deliver).not.toHaveBeenCalled();
    }
    expect(dispatcher.getQueuedCounts()).toEqual({
      tool: 0,
      block: testCase.expectedBlocks,
      final: testCase.expectedFinals,
    });
    if (forgedTtsDelivery) {
      expect(forbiddenSdkAuthorityObserved).toBe(false);
    }
    expect(modeTransitions).toEqual(testCase.expectedTransitions);
    if (cliSucceeded) {
      const cliParams = runnerState.runCliAgentMock.mock.calls.at(-1)?.[0] as {
        cliSessionBindingFacts?: { sourceReplyDeliveryMode?: string };
        sourceReplyDeliveryMode?: string;
      };
      expect(cliParams.cliSessionBindingFacts?.sourceReplyDeliveryMode).toBe("automatic");
      expect(cliParams.sourceReplyDeliveryMode).toBe("automatic");
    } else if (testCase.preparedVisibleReplies === "automatic") {
      expect(modelVisiblePrompt).toContain("Current-session final text normally routes to source");
      expect(modelVisiblePrompt).toContain(
        "Your replies are automatically sent to this conversation",
      );
      expect(modelVisiblePrompt).not.toContain("Normal final replies are private");
    } else {
      expect(modelVisiblePrompt).toContain(
        "Current source visible reply MUST use `message(action=send)`",
      );
      expect(modelVisiblePrompt).toContain("Normal final replies are private");
      expect(modelVisiblePrompt).not.toContain(
        "Your replies are automatically sent to this conversation",
      );
    }
  });

  it.each([
    { name: "configured input", selection: {} },
    { name: "unmarked raw pair", selection: { provider: "openai", model: "legacy-model" } },
    {
      name: "marked raw pair",
      selection: { provider: "openai", model: "legacy-model", requestedRouteResolution: "raw" },
    },
    {
      name: "resolved pair",
      selection: { provider: "openai", model: "gpt-5.4", requestedRouteResolution: "resolved" },
    },
  ] as const)("prepares $name with one manifest normalization pass", async ({ selection }) => {
    const { runEmbeddedAgent } = await loadSourceDeliveryHarness();
    mockedGlobalHookRunner.hasHooks.mockReturnValue(false);
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "primary" }]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ assistantTexts: ["primary"] }),
    );
    useOpenAIPlatformAuthFixture();
    const metadataSnapshot = {
      ...createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "openai",
            providers: ["openai"],
            modelIdNormalization: {
              providers: {
                openai: {
                  aliases: { "legacy-model": "gpt-5.4", "gpt-5.4": "unexpected-second-pass" },
                },
              },
            },
          },
        ],
      }),
      workspaceDir: state.workspaceDir,
    };
    const config = { agents: { defaults: { model: { primary: "openai/legacy-model" } } } };
    const pluginRegistry = createEmptyPluginRegistry();
    const baseLease = await mockedAcquireAgentRunPreparedModelRuntime({
      config,
      agentId: "worker",
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
    });
    mockedAcquireAgentRunPreparedModelRuntime.mockClear();
    mockedAcquireAgentRunPreparedModelRuntime.mockResolvedValueOnce({
      ...baseLease,
      snapshot: {
        ...baseLease.snapshot,
        metadataSnapshot,
        pluginRegistry,
      },
    });

    await runEmbeddedAgent({
      agentId: "worker",
      sessionId: "manifest-model-preparation",
      workspaceDir: state.workspaceDir,
      prompt: "hello",
      runId: "manifest-model-preparation",
      timeoutMs: 30_000,
      modelFallbacksOverride: [],
      config,
      pluginGeneration: {
        pluginMetadataSnapshot: metadataSnapshot,
        pluginRegistry,
        configuredCatalogEntries: [],
        inlineProviderModels: [],
      },
      ...selection,
    });

    expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePluginSelections: [{ provider: "openai", modelId: "gpt-5.4", agentId: "worker" }],
      }),
      expect.any(Object),
    );
  });

  it("prepares a Codex primary without pinning a plugin-owned fallback", async () => {
    const { runEmbeddedAgent, registerPreparedAgentHarness } = await loadSourceDeliveryHarness();
    registerPreparedAgentHarness({
      id: "fallback-owner",
      label: "Fallback owner",
      supports: ({ provider }) =>
        provider === "custom" ? { supported: true } : { supported: false },
      runAttempt: vi.fn(async () => ({}) as never),
    });
    mockedGlobalHookRunner.hasHooks.mockReturnValue(false);
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "primary" }]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ assistantTexts: ["primary"] }),
    );
    useOpenAIPlatformAuthFixture();

    const runParams: RunEmbeddedAgentInternalParams = {
      agentId: "worker",
      sessionId: "runtime-preparation-hint",
      workspaceDir: state.workspaceDir,
      prompt: "hello",
      runId: "runtime-preparation-hint",
      timeoutMs: 30_000,
      provider: "openai",
      model: "gpt-5.4",
      agentHarnessRuntimePreparationHint: "codex",
      modelFallbacksOverride: ["fast"],
      config: {
        agents: {
          list: [
            { id: "main", default: true },
            {
              id: "worker",
              models: {
                "openai/gpt-5.4": { agentRuntime: { id: "codex" } },
                "custom/plugin-fallback": {
                  alias: "fast",
                  agentRuntime: { id: "fallback-owner" },
                },
              },
            },
          ],
          defaults: {
            models: {
              "custom/global-fallback": { alias: "fast" },
            },
          },
        },
      },
    };
    await runEmbeddedAgent(runParams);

    expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePluginSelections: [
          { provider: "openai", modelId: "gpt-5.4", runtime: "codex", agentId: "worker" },
          { provider: "custom", modelId: "plugin-fallback", agentId: "worker" },
        ],
      }),
      expect.any(Object),
    );
  });

  registerPreparedRuntimeGenerationTests(async () => ({
    ...(await loadSourceDeliveryHarness()),
    state,
  }));

  it.each([
    ["agentHarnessId", { agentHarnessId: "codex" }],
    ["agentHarnessRuntimeOverride", { agentHarnessRuntimeOverride: "codex" }],
  ] as const)("keeps %s authoritative across fallback preparation", async (_label, override) => {
    const { runEmbeddedAgent } = await loadSourceDeliveryHarness();
    mockedGlobalHookRunner.hasHooks.mockReturnValue(false);
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "primary" }]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ assistantTexts: ["primary"] }),
    );
    useOpenAIPlatformAuthFixture();

    await runEmbeddedAgent({
      agentId: "worker",
      sessionId: `authoritative-${_label}`,
      workspaceDir: state.workspaceDir,
      prompt: "hello",
      runId: `authoritative-${_label}`,
      timeoutMs: 30_000,
      provider: "openai",
      model: "gpt-5.4",
      modelFallbacksOverride: ["custom/plugin-fallback"],
      ...override,
    });

    expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePluginSelections: [
          { provider: "openai", modelId: "gpt-5.4", runtime: "codex", agentId: "worker" },
          {
            provider: "custom",
            modelId: "plugin-fallback",
            runtime: "codex",
            agentId: "worker",
          },
        ],
      }),
      expect.any(Object),
    );
  });
});
