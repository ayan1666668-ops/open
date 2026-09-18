import { resolveCliBackendConfig } from "../../agents/cli-backends.js";
import {
  runEmbeddedAgentEntry,
  type RunEntryCandidateOptions,
} from "../../agents/embedded-agent-runner/run-entry.js";
import type { FastModeAutoProgressState } from "../../agents/fast-mode.js";
import type { ModelFallbackStepFields } from "../../agents/model-fallback-observation.js";
import { buildGenericCliContextEngineHostSupport } from "../../context-engine/host-compat.js";
import { revokeMessageActionTurnCapability } from "../../gateway/message-action-turn-capability.js";
import { clearAgentRunTerminalWriteContext } from "../../infra/agent-run-terminal-writes.js";
import { RUN_STALE_TAKEOVER_MS } from "../../logging/diagnostic-run-activity.js";
import { prepareSessionExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
import {
  isAcpExecutionSelection,
  isModelExecutionSelection,
  type ExecutionSelection,
} from "../../model-picker/execution-selection.js";
import { CommandLane } from "../../process/lanes.js";
import type { AgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
import { resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
import { runCliFallbackCandidate } from "./agent-runner-cli-candidate.js";
import {
  invalidateTurnCompactionContext,
  recordTurnCompaction,
} from "./agent-runner-compaction-accounting.js";
import { runEmbeddedFallbackCandidate } from "./agent-runner-embedded-candidate.js";
import type { MessageToolDeliveryState } from "./agent-runner-event-handler.js";
import type { EmbeddedAgentRunResult } from "./agent-runner-execution.types.js";
import type {
  AgentFallbackCandidateCommonParams,
  AgentFallbackCycleParams,
} from "./agent-runner-fallback-cycle.types.js";
import { emitModelFallbackStepLifecycle } from "./agent-runner-model-fallback-lifecycle.js";
import {
  mintReplyMessageActionTurnCapability,
  resolveModelFallbackOptions,
  resolveRunFastModeForFallbackCandidate,
  resolveRunThinkingLevelForFallbackCandidate,
} from "./agent-runner-utils.js";
import { hasBlockReplyDeliveryCustody } from "./block-reply-delivery.js";
import { beginReplyOperationFinalizationWork } from "./reply-run-finalization-lease.js";
import {
  bindSourceReplyDeliveryRuntime,
  createSourceReplyDeliveryRuntime,
  readSourceReplyDeliveryRuntime,
  type SourceReplyDeliveryRuntimeOptions,
} from "./source-reply-delivery-runtime.js";

/** Runs the provider/model fallback candidates while preserving cross-candidate delivery state. */
export async function runAgentFallbackCandidates(params: AgentFallbackCycleParams) {
  const turn = params.turn;
  const sourceReplyDeliveryRuntimeOptions = turn.opts as
    | SourceReplyDeliveryRuntimeOptions
    | undefined;
  const sourceReplyDeliveryRuntime =
    readSourceReplyDeliveryRuntime(turn.followupRun.run) ??
    createSourceReplyDeliveryRuntime({
      origin: sourceReplyDeliveryRuntimeOptions?.sourceReplyDeliveryModeOrigin ?? "stable_policy",
      initialMode: turn.followupRun.run.sourceReplyDeliveryMode ?? "automatic",
      projections: [turn.followupRun.run, ...(turn.opts ? [turn.opts] : [])],
      promptComponentByMode: { automatic: "", message_tool_only: "" },
      promptComponentOffset: undefined,
      onModeResolved: sourceReplyDeliveryRuntimeOptions?.onSourceReplyDeliveryModeResolved,
    });
  sourceReplyDeliveryRuntime.track(turn.followupRun.run);
  if (turn.opts) {
    sourceReplyDeliveryRuntime.track(turn.opts);
  }
  bindSourceReplyDeliveryRuntime(turn.followupRun.run, sourceReplyDeliveryRuntime);
  const sourceReplyDeliveryModeOrigin = sourceReplyDeliveryRuntime.origin;
  const preserveProgressCallbackStartOrder = turn.opts?.preserveProgressCallbackStartOrder === true;
  const runLane = turn.isHeartbeat ? CommandLane.CronNested : CommandLane.Main;
  let queuedUserMessagePersistedAcrossFallback = false;
  const messageToolDeliveryState: MessageToolDeliveryState = {
    toolCallIds: new Set(),
    completed: false,
  };
  const userTurnTranscriptRecorder =
    turn.followupRun.userTurnTranscriptRecorder ?? turn.opts?.userTurnTranscriptRecorder;
  const fastModeStartedAtMs = Date.now();
  const fastModeAutoProgressState: FastModeAutoProgressState = {
    offAnnounced: false,
    resetAnnounced: false,
  };
  const bootstrapContextRunKind = turn.opts?.isHeartbeat
    ? ("heartbeat" as const)
    : ("default" as const);

  params.timing.logMilestoneIfSlow({
    runId: params.runId,
    sessionId: turn.followupRun.run.sessionId,
    sessionKey: turn.sessionKey,
    milestone: "before_model_fallback",
  });
  const resolveCandidateRuntime = (candidate: ExecutionSelection) => {
    if (isAcpExecutionSelection(candidate)) {
      throw new Error("This reply belongs to the native manager.");
    }
    return {
      candidateRun: {
        ...params.effectiveRun,
        executionSelection: candidate,
        ...(candidate.executor.kind === "cli"
          ? {}
          : isModelExecutionSelection(candidate)
            ? resolveRunAuthProfile(params.effectiveRun, candidate.model.provider, {
                config: params.runtimeConfig,
              })
            : { authProfileId: undefined, authProfileIdSource: undefined }),
      },
      cliExecutionProvider: candidate.executor.kind === "cli" ? candidate.executor.id : undefined,
    };
  };
  const runCandidate = async (
    candidate: ExecutionSelection,
    runOptions: RunEntryCandidateOptions,
  ) => {
    if (isAcpExecutionSelection(candidate)) {
      throw new Error("This reply belongs to the native manager.");
    }
    const selectedModel = isModelExecutionSelection(candidate) ? candidate.model : undefined;
    const provider = selectedModel?.provider;
    const model = selectedModel?.id;
    clearAgentRunTerminalWriteContext(params.preparedRunAdmission.operationalRunInstance);
    params.state.maintenanceAuthProfile = undefined;
    params.state.maintenanceExecutionSelection = undefined;
    params.state.compactionRequestBudget = undefined;
    invalidateTurnCompactionContext(params.state.compaction);
    params.state.attemptedRuntimeProvider = provider;
    params.state.attemptedRuntimeModel = model;
    const runtime = params.timing.measureSync("fallback_resolve_runtime", () =>
      resolveCandidateRuntime(candidate),
    );
    const candidateRun = runtime.candidateRun;
    bindSourceReplyDeliveryRuntime(candidateRun, sourceReplyDeliveryRuntime);
    // CLI prompts are fixed to their session binding, so dispatch must publish that
    // same stable mode or a valid assistant reply can be silently suppressed.
    const candidateSourceReplyDeliveryMode =
      sourceReplyDeliveryModeOrigin === "runtime_default" &&
      runtime.cliExecutionProvider !== undefined
        ? (candidateRun.cliSessionBindingFacts?.sourceReplyDeliveryMode ?? "automatic")
        : sourceReplyDeliveryRuntime.currentMode;
    const applySourceReplyDeliveryModeBeforeInvocation =
      sourceReplyDeliveryModeOrigin !== "runtime_default" ||
      runtime.cliExecutionProvider !== undefined;
    if (candidateSourceReplyDeliveryMode && applySourceReplyDeliveryModeBeforeInvocation) {
      sourceReplyDeliveryRuntime.applyMode(candidateRun, candidateSourceReplyDeliveryMode);
    }
    let candidateThinkLevel = candidateRun.thinkLevel;
    let candidateFastMode = {
      fastMode: candidateRun.fastMode,
      fastModeAutoOnSeconds: candidateRun.fastModeAutoOnSeconds,
    };
    if (selectedModel) {
      candidateThinkLevel = resolveRunThinkingLevelForFallbackCandidate({
        cfg: params.runtimeConfig,
        provider: selectedModel.provider,
        modelId: selectedModel.id,
        run: turn.followupRun.run,
        catalog: turn.followupRun.run.thinkingCatalog,
        agentId: turn.followupRun.run.agentId,
        sessionKey: turn.followupRun.run.runtimePolicySessionKey ?? turn.sessionKey,
        sessionEntry: params.liveModelSwitchRuntimeEntry ?? turn.getActiveSessionEntry(),
        agentRuntime: candidate.executor.id,
      });
      candidateFastMode = resolveRunFastModeForFallbackCandidate({
        run: candidateRun,
        config: params.runtimeConfig,
        provider: selectedModel.provider,
        model: selectedModel.id,
        sessionEntry: turn.getActiveSessionEntry(),
      });
      turn.opts?.onModelSelected?.({
        provider: selectedModel.provider,
        model: selectedModel.id,
        thinkLevel: candidateThinkLevel,
      });
    }
    const signalExecutionPhaseForCandidate: AgentFallbackCandidateCommonParams["signalExecutionPhaseForTyping"] =
      (info) => {
        if (
          params.state.compaction.count > 0 &&
          (info.phase === "model_call_started" || info.phase === "process_spawned")
        ) {
          params.state.postCompactionModelAttempted = true;
        }
        params.signalExecutionPhaseForTyping(info);
      };
    const messageActionTurnCapability = mintReplyMessageActionTurnCapability(turn, params.runId);
    try {
      const common = {
        preparedRunAdmission: params.preparedRunAdmission,
        messageActionTurnCapability,
        turn,
        candidateRun,
        runtimeConfig: params.runtimeConfig,
        candidateThinkLevel,
        candidateFastMode,
        runId: params.runId,
        runAbortSignal: params.runAbortSignal,
        runLane,
        isFallbackRetry: runOptions.isFallbackRetry,
        isFinalFallbackAttempt: runOptions?.isFinalFallbackAttempt,
        suppressQueuedUserPersistenceForCandidate:
          (turn.followupRun.run.suppressNextUserMessagePersistence ?? false) ||
          queuedUserMessagePersistedAcrossFallback,
        userTurnTranscriptRecorder,
        contextEngineLogicalTurnLease: runOptions.contextEngineLogicalTurnLease,
        onContextEngineTurnCandidate: runOptions.onContextEngineTurnCandidate,
        assistantErrorTranscript: runOptions.assistantErrorTranscript,
        authProfileFailurePolicy: runOptions.authProfileFailurePolicy,
        notifyUserMessagePersisted: () => {
          queuedUserMessagePersistedAcrossFallback = true;
        },
        fastModeStartedAtMs,
        fastModeAutoProgressState,
        bootstrapContextRunKind,
        bootstrapPromptWarningSignaturesSeen: params.state.bootstrapPromptWarningSignaturesSeen,
        currentTurnImages: params.currentTurnImages,
        signalExecutionPhaseForTyping: signalExecutionPhaseForCandidate,
        notifyAgentRunStart: params.notifyAgentRunStart,
        preserveProgressCallbackStartOrder,
        presentation: params.presentation,
        timing: params.timing,
        onLifecycleBackstop: (backstop: AgentLifecycleTerminalBackstop) => {
          params.state.pendingLifecycleTerminal = { provider, model, backstop };
        },
        deferredLifecycle: params.state.deferredLifecycle,
      } satisfies AgentFallbackCandidateCommonParams;
      if (runtime.cliExecutionProvider !== undefined) {
        const cliResult = await runCliFallbackCandidate({
          ...common,
          cliExecutionProvider: runtime.cliExecutionProvider,
          classifyResult: runOptions.classifyResult,
          lifecycleGeneration: params.state.lifecycleGeneration,
        });
        params.state.bootstrapPromptWarningSignaturesSeen =
          cliResult.bootstrapPromptWarningSignaturesSeen;
        return cliResult.result;
      }
      const embeddedResult = await runEmbeddedFallbackCandidate({
        ...common,
        effectiveRun: params.effectiveRun,
        getLifecycleGeneration: () => params.state.lifecycleGeneration,
        onLifecycleGeneration: (generation) => {
          params.state.lifecycleGeneration = generation;
        },
        allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
        notifyUserAboutCompaction: params.notifyUserAboutCompaction,
        messageToolDeliveryState,
        onCompactionFacts: ({ accounting, postCompactionModelAttempted }) => {
          if (accounting) {
            recordTurnCompaction(params.state.compaction, accounting);
          }
          params.state.postCompactionModelAttempted ||= postCompactionModelAttempted;
        },
      });
      params.state.bootstrapPromptWarningSignaturesSeen =
        embeddedResult.bootstrapPromptWarningSignaturesSeen;
      params.state.maintenanceAuthProfile = embeddedResult.maintenanceAuthProfile;
      params.state.maintenanceExecutionSelection = candidateRun.executionSelection;
      params.state.compactionRequestBudget = embeddedResult.compactionRequestBudget;
      return embeddedResult.result;
    } finally {
      revokeMessageActionTurnCapability(messageActionTurnCapability);
    }
  };
  const common = {
    preparedRunAdmission: params.preparedRunAdmission,
    identity: {
      runId: params.runId,
      agentId: turn.followupRun.run.agentId,
      sessionId: turn.followupRun.run.sessionId,
      sessionKey: params.effectiveRun.runtimePolicySessionKey ?? params.effectiveRun.sessionKey,
      lane: runLane,
    },
    behavior: {
      kind: "channel-delivery" as const,
      readDeliveryEvidence: () => ({
        hasRetryBlockedDelivery:
          turn.blockReplyPipeline?.hasRetryBlockedDelivery() === true ||
          params.directBlockDeliveries.some(hasBlockReplyDeliveryCustody),
        hasDirectlySentBlockReply: params.directBlockDeliveries.some(
          (delivery) => delivery.terminalDeliveryConfirmed === true,
        ),
        hasBlockReplyPipelineOutput: Boolean(
          turn.blockReplyPipeline?.hasBuffered() || turn.blockReplyPipeline?.didStream(),
        ),
      }),
    },
    onAcceptedTerminal: () => {
      params.commitTerminalOutcome();
      return turn.replyOperation
        ? beginReplyOperationFinalizationWork(turn.replyOperation, RUN_STALE_TAKEOVER_MS)
        : undefined;
    },
    abortSignal: params.runAbortSignal,
    onFallbackStep: (step: ModelFallbackStepFields) => {
      emitModelFallbackStepLifecycle({ runId: params.runId, sessionKey: turn.sessionKey, step });
    },
    runCandidate,
  };
  const accepted = params.effectiveRun.executionSelection;
  if (isAcpExecutionSelection(accepted)) {
    throw new Error("This reply requires a direct execution selection.");
  }
  if (accepted.model === "native-managed") {
    return params.timing.measure("native_execution", async () => {
      const prepared = await prepareSessionExecutionSelection({
        cfg: params.runtimeConfig,
        agentId: turn.followupRun.run.agentId,
        sessionKey: turn.sessionKey,
        storePath: turn.storePath,
        readSessionEntry: !turn.storePath ? turn.getActiveSessionEntry : undefined,
        sessionEntry: params.liveModelSwitchRuntimeEntry ?? turn.getActiveSessionEntry(),
        request: { kind: "selection", selection: accepted },
      });
      if (prepared.status !== "ready") {
        throw new Error(prepared.message);
      }
      return runEmbeddedAgentEntry<EmbeddedAgentRunResult>({
        ...common,
        kind: "native",
        selection: {
          cfg: params.runtimeConfig,
          agentDir: params.effectiveRun.agentDir,
          executionSelection: accepted,
          validateCommit: prepared.validateCommit,
        },
        harness: { workspaceDir: turn.followupRun.run.workspaceDir, sessionKey: turn.sessionKey },
      });
    });
  }
  const selection = resolveModelFallbackOptions(
    params.effectiveRun,
    params.runtimeConfig,
    params.liveModelSwitchRuntimeEntry ?? turn.getActiveSessionEntry(),
  );
  return params.timing.measure("model_fallback", () =>
    runEmbeddedAgentEntry<EmbeddedAgentRunResult>({
      ...common,
      selection: {
        cfg: selection.cfg,
        provider: selection.provider,
        model: selection.model,
        requestedRouteResolution: selection.requestedRouteResolution,
        agentDir: selection.agentDir,
        fallbacksOverride: selection.fallbacksOverride,
        userLockedAuthProfileId:
          turn.followupRun.run.authProfileIdSource === "user"
            ? turn.followupRun.run.authProfileId
            : undefined,
      },
      harness: {
        workspaceDir: turn.followupRun.run.workspaceDir,
        sessionKey: turn.followupRun.run.runtimePolicySessionKey ?? turn.sessionKey,
        preparation: {
          kind: "measured",
          run: (prepare) => params.timing.measure("fallback_prepare_harness", prepare),
        },
        prepareExecutionSelection: async (provider, model) => {
          const prepared = await prepareSessionExecutionSelection({
            cfg: params.runtimeConfig,
            agentId: turn.followupRun.run.agentId,
            sessionKey: turn.sessionKey,
            storePath: turn.storePath,
            readSessionEntry: !turn.storePath ? turn.getActiveSessionEntry : undefined,
            sessionEntry: params.liveModelSwitchRuntimeEntry ?? turn.getActiveSessionEntry(),
            request: {
              kind: "fallback",
              selection: {
                model: { provider, id: model },
                executor: accepted.executor,
              },
            },
          });
          if (prepared.status !== "ready") {
            throw new Error(prepared.message);
          }
          if (!isModelExecutionSelection(prepared.selection)) {
            throw new Error("This reply requires a direct execution selection.");
          }
          return { selection: prepared.selection, validateCommit: prepared.validateCommit };
        },
        resolveContextEngineHost: (candidate) => {
          const runtime = resolveCandidateRuntime(candidate);
          if (!runtime.cliExecutionProvider) {
            return undefined;
          }
          const backend = resolveCliBackendConfig(
            runtime.cliExecutionProvider,
            params.runtimeConfig,
            { agentId: turn.followupRun.run.agentId },
          );
          return buildGenericCliContextEngineHostSupport({
            backendId: backend?.id ?? runtime.cliExecutionProvider,
            ...(backend?.contextEngineHostCapabilities
              ? { capabilities: backend.contextEngineHostCapabilities }
              : {}),
          });
        },
      },
    }),
  );
}

export type AgentFallbackCandidatesResult = Awaited<ReturnType<typeof runAgentFallbackCandidates>>;
