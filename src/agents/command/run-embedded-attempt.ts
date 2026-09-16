import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { resolveSessionAuthProfileOverrideSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { clearAgentRunTerminalWriteContext } from "../../infra/agent-run-terminal-writes.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  commitSessionExecutionSelection,
  prepareSessionExecutionSelection,
  resolveSessionExecutionFallbacks,
} from "../../model-picker/apply-session-model-selection.js";
import {
  isAcpExecutionSelection,
  isModelExecutionSelection,
  type ExecutionSelection,
} from "../../model-picker/execution-selection.js";
import {
  MODEL_SELECTION_LOCKED_MESSAGE,
  ModelSelectionLockedError,
  isModelSelectionLocked,
} from "../../sessions/model-overrides.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
} from "../../tasks/task-status-access.js";
import { createTrajectoryRuntimeRecorder } from "../../trajectory/runtime.js";
import { resolveMessageChannel } from "../../utils/message-channel.js";
import { isHeartbeatLifecycleRunKind } from "../bootstrap-mode.js";
import {
  runEmbeddedAgentEntry,
  type EmbeddedAgentRunEntryTerminal,
  type RunEntryCandidateOptions,
} from "../embedded-agent-runner/run-entry.js";
import { createDeferredEmbeddedRunLifecycleManager } from "../embedded-agent-runner/run/deferred-lifecycle-owner.js";
import { resolveFastModeState } from "../fast-mode.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../harness/hook-helpers.js";
import { prepareInternalSessionEffectsSession } from "../internal-session-effects.js";
import { LiveSessionModelSwitchError } from "../live-model-switch.js";
import { findModelInCatalog, prepareModelRunCapabilities } from "../model-catalog-lookup.js";
import { resolveThinkingDefault } from "../model-selection.js";
import { resolveConfiguredThinkingDefault } from "../model-thinking-default.js";
import { createModelVisibilityPolicy } from "../model-visibility-policy.js";
import {
  isAgentRunRestartAbortReason,
  resolveAgentRunErrorLifecycleFields,
} from "../run-termination.js";
import { measureAgentStartup } from "../startup-timing.js";
import {
  normalizeThinkingCatalogProviders,
  resolveCandidateThinkingLevel,
  needsThinkHydration,
} from "../thinking-runtime.js";
import {
  createAgentAttemptLifecycleCallbacks,
  type AgentAttemptLifecycleState,
} from "./attempt-callbacks.js";
import { createCommandCompactionAccounting } from "./compaction-accounting.js";
import { createAgentCommandLifecycle } from "./lifecycle.js";
import type { RunEmbeddedAgentAttemptParams } from "./run-embedded-attempt.types.js";
import { loadAttemptExecutionRuntime, type AgentAttemptResult } from "./runtime-loaders.js";
import { resolveInternalSessionEffectsSource } from "./session-helpers.js";
const log = createSubsystemLogger("agents/agent-command");
const MAX_LIVE_SWITCH_RETRIES = 5;

export async function runEmbeddedAgentAttempt(params: RunEmbeddedAgentAttemptParams) {
  const {
    cfg,
    body,
    transcriptBody,
    sessionId,
    sessionKey,
    sessionStore,
    storePath,
    sessionAgentId,
    workspaceDir,
    cwd,
    agentDir,
    runId,
    pluginsEnabled,
    manifestMetadataSnapshot,
    modelManifestContext,
    normalizedSpawned,
    isNewSession,
    timeoutMs,
    runTimeoutOverrideMs,
  } = params.prepared;
  const { runContext, skillsSnapshot, resolvedVerboseLevel } = params.embeddedSessionState;
  const {
    defaultProvider,
    defaultModel,
    configuredDefaultAuthProfileId,
    immutableThinkLevel,
    sessionFile,
  } = params.modelSelection;
  let {
    executionSelection,
    provider,
    model,
    providerForAuthProfileValidation,
    sessionEntryForAttempt,
    effectiveTurnThinkLevel,
  } = params.modelSelection;
  const thinkingCatalog = params.modelSelection.thinkingCatalog;
  let sessionEntry = params.sessionEntry;
  let lifecycleGeneration = params.lifecycleGeneration;

  const sessionEffectsSource = resolveInternalSessionEffectsSource({
    agentId: sessionAgentId,
    sessionId,
    sessionKey,
    storePath,
  });
  const internalSessionTarget = params.suppressVisibleSessionEffects
    ? await prepareInternalSessionEffectsSession({
        agentId: sessionAgentId,
        cwd: cwd ?? workspaceDir,
        runId,
        source: sessionEffectsSource,
        storePath,
      })
    : undefined;
  params.trackInternalModelRunTarget(internalSessionTarget);
  let attemptSessionTarget =
    internalSessionTarget ??
    (sessionKey && storePath
      ? {
          agentId: sessionAgentId,
          sessionId,
          sessionKey,
          storePath,
        }
      : undefined);
  const attemptSessionFile = internalSessionTarget?.sessionFile ?? sessionFile;

  const startedAt = Date.now();
  const attemptLifecycleState: AgentAttemptLifecycleState = {
    currentTurnUserMessagePersisted: false,
    lifecycleFinishing: false,
    lifecycleEnded: false,
  };
  const attemptLifecycleCallbacks = createAgentAttemptLifecycleCallbacks(
    attemptLifecycleState,
    params.preparedRunAdmission.onRuntimeTurnStarted,
  );
  const transcriptMedia = params.opts.transcriptMedia ?? [];
  const hasTranscriptMedia = transcriptMedia.length > 0;
  const suppressUserTurnPersistence =
    params.opts.suppressPromptPersistence === true ||
    (params.opts.transcriptMessage === "" && !hasTranscriptMedia);
  const recorderTranscriptText = transcriptBody || undefined;
  const userTurnTranscriptRecorder =
    (internalSessionTarget ? undefined : params.opts.userTurnTranscriptRecorder) ??
    createUserTurnTranscriptRecorder({
      ...(!suppressUserTurnPersistence && (recorderTranscriptText || hasTranscriptMedia)
        ? {
            input: {
              text: recorderTranscriptText,
              ...(hasTranscriptMedia ? { media: transcriptMedia } : {}),
              senderIsOwner: params.opts.senderIsOwner,
              ...(params.opts.inputProvenance ? { provenance: params.opts.inputProvenance } : {}),
            },
          }
        : {}),
      target: {
        sessionId: internalSessionTarget?.sessionId ?? sessionId,
        agentId: internalSessionTarget?.agentId ?? sessionAgentId,
        sessionKey: internalSessionTarget?.sessionKey ?? sessionKey ?? sessionId,
        sessionEntry: internalSessionTarget?.sessionEntry ?? sessionEntry,
        sessionStore: params.suppressVisibleSessionEffects ? undefined : sessionStore,
        storePath: internalSessionTarget?.storePath ?? storePath,
        cwd: cwd ?? workspaceDir,
        config: cfg,
      },
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      errorContext: "agent command user turn transcript",
    });
  if (suppressUserTurnPersistence) {
    userTurnTranscriptRecorder.markBlocked();
  }
  const lifecycle = createAgentCommandLifecycle({
    runId,
    lifecycleGeneration: () => lifecycleGeneration,
    startedAt,
    abortSignal: params.opts.abortSignal,
    state: attemptLifecycleState,
  });
  const attemptExecutionRuntime = await measureAgentStartup(
    "attempt-runtime-import",
    () => loadAttemptExecutionRuntime(),
    { config: cfg },
  );
  const messageChannel = resolveMessageChannel(
    runContext.messageChannel,
    params.opts.replyChannel ?? params.opts.channel,
  );

  let result: AgentAttemptResult;
  const compactionAccounting = createCommandCompactionAccounting({
    sessionStore,
    persistCounts:
      !params.suppressVisibleSessionEffects && !params.preserveUserFacingSessionModelState,
    onDurableFact: (fact) => {
      attemptSessionTarget = fact.target;
      params.trackInternalModelRunTarget(fact.target);
      params.onCompactionAccounting?.(fact);
    },
    refreshSessionEntry: (key) => {
      sessionEntry = sessionStore?.[key] ?? sessionEntry;
      sessionEntryForAttempt = sessionEntry;
    },
  });
  let maintenanceExecutionSelection: ExecutionSelection | undefined;
  let maintenanceAuthProfile:
    | { authProfileId?: string; authProfileIdSource?: "auto" | "user" }
    | undefined;
  let fallbackProvider: string | undefined = provider;
  let fallbackModel: string | undefined = model;
  let fallbackExhausted = false;
  let terminal: EmbeddedAgentRunEntryTerminal;
  let liveSwitchRetries = 0;
  const fastModeStartedAtMs = Date.now();
  const fallbackTrajectoryRecorder = createTrajectoryRuntimeRecorder({
    cfg,
    runId,
    sessionId,
    sessionKey,
    sessionFile: attemptSessionFile,
    provider,
    modelId: model,
    workspaceDir,
  });
  const deferredLifecycle = createDeferredEmbeddedRunLifecycleManager({
    runId,
    agentId: sessionAgentId,
    sessionId,
    sessionKey,
    sessionFile: attemptSessionFile,
    abortSignal: params.opts.abortSignal,
  });
  const logicalTurnOpts = { ...params.opts, abortSignal: deferredLifecycle.signal };
  let liveSwitchMediaTaskIds: ReadonlySet<string> = new Set();
  for (;;) {
    try {
      liveSwitchMediaTaskIds = sessionKey
        ? getGeneratedMediaTaskIdsForSessionKey(sessionKey)
        : new Set<string>();
      const spawnedBy = normalizedSpawned.spawnedBy ?? sessionEntry?.spawnedBy;
      const fallbackAvailability = isModelExecutionSelection(executionSelection)
        ? resolveSessionExecutionFallbacks({
            cfg,
            agentId: sessionAgentId,
            sessionKey,
            sessionEntry,
            selection: executionSelection,
            modelFallbacksOverride: params.opts.modelFallbacksOverride,
            subagentSpawnLineage: (sessionEntry?.spawnDepth ?? 0) > 0,
          })
        : undefined;
      const effectiveFallbacksOverride =
        fallbackAvailability?.kind === "active" ? fallbackAvailability.models : [];

      const fallbackRuntimeState: { originRuntime?: "cli" | "embedded" } = {};
      attemptLifecycleState.currentTurnUserMessagePersisted = false;
      let attemptMediaTaskIds = liveSwitchMediaTaskIds;
      const currentAttemptCommittedCronMedia = () =>
        Boolean(
          sessionKey && hasNewGeneratedMediaTaskForSessionKey(sessionKey, attemptMediaTaskIds),
        );
      const runCandidate = async (
        candidateSelection: ExecutionSelection,
        runOptions: RunEntryCandidateOptions,
      ) => {
        if (isAcpExecutionSelection(candidateSelection))
          throw new Error("This attempt requires the native manager.");
        const selectedModel = isModelExecutionSelection(candidateSelection)
          ? candidateSelection.model
          : undefined;
        clearAgentRunTerminalWriteContext(params.preparedRunAdmission.operationalRunInstance);
        const candidateAccounting = compactionAccounting.beginCandidate(deferredLifecycle.signal);
        maintenanceAuthProfile = undefined;
        maintenanceExecutionSelection = undefined;
        attemptMediaTaskIds = sessionKey
          ? getGeneratedMediaTaskIdsForSessionKey(sessionKey)
          : new Set<string>();
        attemptLifecycleState.lifecycleError = undefined;
        attemptLifecycleState.lifecycleFinishing = false;
        attemptLifecycleState.lifecycleEnded = false;
        const attemptSessionEntry = sessionEntryForAttempt;
        let candidateThinkLevel = immutableThinkLevel;
        let fastMode = params.opts.fastMode;
        let fastModeAutoOnSeconds = params.opts.fastModeAutoOnSeconds;
        let configuredAuthProfileId: string | undefined;
        let candidateCapabilities: ReturnType<typeof prepareModelRunCapabilities> | undefined;
        if (selectedModel) {
          const providerOverride = selectedModel.provider;
          const modelOverride = selectedModel.id;
          await params.opts.onActiveModelSelected?.({
            provider: providerOverride,
            model: modelOverride,
          });
          const fastModeState = resolveFastModeState({
            cfg,
            provider: providerOverride,
            model: modelOverride,
            agentId: sessionAgentId,
            sessionEntry,
          });
          fastMode = params.opts.fastMode ?? fastModeState.mode;
          configuredAuthProfileId =
            providerOverride === defaultProvider && modelOverride === defaultModel
              ? configuredDefaultAuthProfileId
              : undefined;
          const candidateRuntime = candidateSelection.executor.id;
          const candidateConfiguredThinkLevel =
            immutableThinkLevel ??
            resolveConfiguredThinkingDefault({
              cfg,
              agentId: sessionAgentId,
              provider: providerOverride,
              model: modelOverride,
            });
          let candidateThinkingCatalog = thinkingCatalog;
          if (
            pluginsEnabled &&
            (candidateConfiguredThinkLevel !== "off" || candidateRuntime !== "openclaw") &&
            needsThinkHydration(thinkingCatalog, providerOverride, modelOverride, candidateRuntime)
          ) {
            const { loadProviderScopedThinkingCatalog } =
              await import("../model-catalog.runtime.js");
            const runtimeCatalog = normalizeThinkingCatalogProviders(
              await loadProviderScopedThinkingCatalog({
                config: cfg,
                provider: providerOverride,
                model: modelOverride,
                agentRuntime: candidateRuntime,
                agentId: sessionAgentId,
                workspaceDir,
              }),
            );
            if (findModelInCatalog(runtimeCatalog, providerOverride, modelOverride)) {
              candidateThinkingCatalog = createModelVisibilityPolicy({
                cfg,
                catalog: runtimeCatalog,
                defaultProvider,
                defaultModel,
                agentId: sessionAgentId,
                allowManifestNormalization: true,
                allowPluginNormalization: true,
                ...modelManifestContext,
              }).catalog;
            }
          }
          const candidateRequestedThinkLevel =
            candidateConfiguredThinkLevel ??
            resolveThinkingDefault({
              cfg,
              agentId: sessionAgentId,
              provider: providerOverride,
              model: modelOverride,
              catalog: candidateThinkingCatalog,
              agentRuntime: candidateRuntime,
            });
          candidateThinkLevel =
            resolveCandidateThinkingLevel({
              cfg,
              provider: providerOverride,
              modelId: modelOverride,
              level: candidateRequestedThinkLevel,
              catalog: candidateThinkingCatalog,
              agentId: sessionAgentId,
              sessionKey,
              sessionEntry: attemptSessionEntry,
              agentRuntime: candidateRuntime,
            }) ?? candidateRequestedThinkLevel;
          fastModeAutoOnSeconds =
            fastMode === "auto"
              ? (params.opts.fastModeAutoOnSeconds ?? fastModeState.fastAutoOnSeconds)
              : fastModeState.fastAutoOnSeconds;
          candidateCapabilities = prepareModelRunCapabilities(
            [candidateThinkingCatalog, params.prepared.configuredThinkingCatalog],
            [providerOverride, modelOverride, candidateRuntime],
          );
        }
        if (candidateThinkLevel) effectiveTurnThinkLevel = candidateThinkLevel;
        try {
          return await attemptExecutionRuntime.runAgentAttempt({
            preparedRunAdmission: params.preparedRunAdmission,
            executionSelection: candidateSelection,
            ...candidateCapabilities,
            configuredAuthProfileId,
            modelFallbacksOverride: effectiveFallbacksOverride,
            originalProvider: provider,
            cfg,
            sessionEntry: attemptSessionEntry,
            sessionId: attemptSessionTarget?.sessionId ?? sessionId,
            sessionKey,
            ...(attemptSessionTarget ? { sessionTarget: attemptSessionTarget } : {}),
            sessionAgentId,
            sessionFile: attemptSessionFile,
            workspaceDir,
            cwd,
            body,
            transcriptBody,
            isFallbackRetry: runOptions.isFallbackRetry,
            classifyResult: runOptions.classifyResult,
            preserveCliSessionBinding:
              isHeartbeatLifecycleRunKind(logicalTurnOpts.bootstrapContextRunKind) ||
              params.preserveUserFacingSessionModelState,
            modelRoutingProvenance: runOptions.modelRoutingProvenance,
            resolvedThinkLevel: candidateThinkLevel,
            fastMode,
            fastModeStartedAtMs,
            fastModeAutoOnSeconds,
            isFinalFallbackAttempt: runOptions?.isFinalFallbackAttempt,
            timeoutMs,
            runTimeoutOverrideMs,
            runId,
            lifecycleGeneration,
            opts: logicalTurnOpts,
            runContext,
            spawnedBy,
            messageChannel,
            skillsSnapshot,
            resolvedVerboseLevel,
            agentDir,
            authProfileProvider: providerForAuthProfileValidation,
            sessionStore: params.suppressVisibleSessionEffects ? undefined : sessionStore,
            storePath: params.suppressVisibleSessionEffects ? undefined : storePath,
            pluginsEnabled,
            ...(manifestMetadataSnapshot ? { metadataSnapshot: manifestMetadataSnapshot } : {}),
            pluginGeneration: params.prepared.commandRuntimeContext?.pluginGeneration,
            allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
            sessionHasHistory:
              !isNewSession ||
              (await attemptExecutionRuntime.sessionTranscriptHasContent(
                attemptSessionTarget,
                deferredLifecycle.signal,
              )),
            fallbackRuntimeState,
            suppressPromptPersistenceOnRetry:
              suppressUserTurnPersistence ||
              userTurnTranscriptRecorder.hasPersisted() ||
              userTurnTranscriptRecorder.isBlocked() ||
              (runOptions.isFallbackRetry && attemptLifecycleState.currentTurnUserMessagePersisted),
            userTurnTranscriptRecorder,
            assistantErrorTranscript: runOptions.assistantErrorTranscript,
            authProfileFailurePolicy: runOptions.authProfileFailurePolicy,
            contextEngineLogicalTurnLease: runOptions.contextEngineLogicalTurnLease,
            onContextEngineTurnCandidate: runOptions.onContextEngineTurnCandidate,
            onUserMessagePersisted: attemptLifecycleCallbacks.onUserMessagePersisted,
            onCompactionAccounting: candidateAccounting.observe,
            onCompactionRequestBudget: candidateAccounting.observeRequestBudget,
            onSuccessfulAuthProfile: (selection) => {
              // Absence is a valid ambient-auth result; only an uncalled observer is unknown.
              maintenanceAuthProfile = selection;
              maintenanceExecutionSelection = candidateSelection;
            },
            onLifecycleGenerationChanged: (nextLifecycleGeneration) => {
              lifecycleGeneration = nextLifecycleGeneration;
              params.onLifecycleGenerationChanged(nextLifecycleGeneration);
            },
            onAgentEvent: attemptLifecycleCallbacks.onAgentEvent,
            deferTerminalLifecycle: true,
            deferredLifecycle,
          });
        } finally {
          await candidateAccounting.finish(sessionEntry);
        }
      };
      let fallbackResult: Awaited<ReturnType<typeof runEmbeddedAgentEntry<AgentAttemptResult>>>;
      if (executionSelection.model === "native-managed") {
        const preparedNative = await prepareSessionExecutionSelection({
          cfg,
          agentId: sessionAgentId,
          sessionKey,
          storePath,
          sessionEntry: sessionEntryForAttempt,
          readSessionEntry:
            !storePath && sessionKey && sessionStore ? () => sessionStore[sessionKey] : undefined,
          request: { kind: "selection", selection: executionSelection },
        });
        if (preparedNative.status !== "ready") throw new Error(preparedNative.message);
        fallbackResult = await runEmbeddedAgentEntry<AgentAttemptResult>({
          kind: "native",
          selection: {
            cfg,
            agentDir,
            executionSelection,
            validateCommit: preparedNative.validateCommit,
          },
          identity: {
            runId,
            agentId: sessionAgentId,
            sessionId,
            sessionKey: sessionKey ?? sessionId,
          },
          harness: { workspaceDir, sessionKey },
          behavior: {
            kind: "command-rpc",
            hasCommittedSideEffect: currentAttemptCommittedCronMedia,
          },
          abortSignal: deferredLifecycle.signal,
          runCandidate,
        });
      } else {
        fallbackResult = await runEmbeddedAgentEntry<AgentAttemptResult>({
          selection: {
            cfg,
            provider,
            model,
            requestedRouteResolution: params.modelSelection.requestedRouteResolution,
            agentDir,
            fallbacksOverride: effectiveFallbacksOverride,
            userLockedAuthProfileId:
              resolveSessionAuthProfileOverrideSource(sessionEntryForAttempt) === "user"
                ? sessionEntryForAttempt?.authProfileOverride
                : undefined,
            ...modelManifestContext,
          },
          identity: {
            runId,
            agentId: sessionAgentId,
            sessionId,
            sessionKey: sessionKey ?? sessionId,
          },
          harness: {
            workspaceDir,
            sessionKey,
            preparation: { kind: "direct" },
            prepareExecutionSelection: async (candidateProvider, candidateModel) => {
              const prepared = await prepareSessionExecutionSelection({
                cfg,
                agentId: sessionAgentId,
                sessionKey,
                storePath,
                readSessionEntry:
                  !storePath && sessionKey && sessionStore
                    ? () => sessionStore[sessionKey]
                    : undefined,
                sessionEntry: sessionEntryForAttempt,
                request: {
                  kind: "fallback",
                  selection: {
                    model: { provider: candidateProvider, id: candidateModel },
                    executor: executionSelection.executor,
                  },
                  explicitModels: params.opts.modelFallbacksOverride,
                },
              });
              if (prepared.status !== "ready") {
                throw new Error(prepared.message);
              }
              if (!isModelExecutionSelection(prepared.selection)) {
                throw new Error("This turn requires a direct execution selection.");
              }
              return { selection: prepared.selection, validateCommit: prepared.validateCommit };
            },
          },
          behavior: {
            kind: "command-rpc",
            hasCommittedSideEffect: currentAttemptCommittedCronMedia,
          },
          abortSignal: deferredLifecycle.signal,
          onFallbackStep: (step) => {
            fallbackTrajectoryRecorder?.recordEvent("model.fallback_step", step);
          },
          runCandidate,
        });
      }
      result = fallbackResult.result;
      terminal = fallbackResult.terminal;
      if (isAgentRunRestartAbortReason(params.opts.abortSignal?.reason)) {
        throw params.opts.abortSignal?.reason;
      }
      fallbackProvider = fallbackResult.provider;
      fallbackModel = fallbackResult.model;
      fallbackExhausted = fallbackResult.outcome === "exhausted";
      if (fallbackResult.attempts.length > 0 && result.meta.agentMeta) {
        result = {
          ...result,
          meta: {
            ...result.meta,
            agentMeta: {
              ...result.meta.agentMeta,
              fallbackAttempts: fallbackResult.attempts,
            },
          },
        };
      }
      if (!fallbackExhausted) {
        lifecycle.emitFinishing(terminal);
      }
      break;
    } catch (err) {
      if (err instanceof LiveSessionModelSwitchError) {
        if (isModelSelectionLocked(sessionEntry)) {
          lifecycle.emitBasicError(MODEL_SELECTION_LOCKED_MESSAGE);
          await fallbackTrajectoryRecorder?.flush();
          await deferredLifecycle.complete();
          throw new ModelSelectionLockedError();
        }
        if (
          sessionKey &&
          hasNewGeneratedMediaTaskForSessionKey(sessionKey, liveSwitchMediaTaskIds)
        ) {
          await deferredLifecycle.complete();
          throw err;
        }
        liveSwitchRetries += 1;
        if (liveSwitchRetries > MAX_LIVE_SWITCH_RETRIES) {
          const retryLimitMessage = `Exceeded maximum live model switch retries (${MAX_LIVE_SWITCH_RETRIES})`;
          log.error(`Live session model switch in subagent run ${runId}: ${retryLimitMessage}`);
          lifecycle.emitBasicError("Agent run failed");
          await fallbackTrajectoryRecorder?.flush();
          await deferredLifecycle.complete();
          throw new Error(retryLimitMessage, { cause: err });
        }
        // The session writer already admitted this selection; retrying does not make a new choice.
        executionSelection = err.selection;
        provider = err.selection.model.provider;
        model = err.selection.model.id;
        providerForAuthProfileValidation = err.selection.model.provider;
        if (sessionEntry) {
          sessionEntry = { ...sessionEntry };
          commitSessionExecutionSelection(sessionEntry, err.selection);
          sessionEntry.authProfileOverride = err.authProfileId;
          sessionEntry.authProfileOverrideSource = err.authProfileId
            ? err.authProfileIdSource
            : undefined;
          sessionEntry.authProfileOverrideCompactionCount = undefined;
          sessionEntryForAttempt = sessionEntry;
        }
        attemptLifecycleState.lifecycleEnded = false;
        log.info(
          `Live session model switch in subagent run ${runId}: switching to ${sanitizeForLog(err.selection.model.provider)}/${sanitizeForLog(err.selection.model.id)}`,
        );
        continue;
      }
      const errorLifecycleFields = resolveAgentRunErrorLifecycleFields(
        err,
        params.opts.abortSignal,
      );
      lifecycle.emitBasicError(
        err instanceof Error ? err : new Error("Agent run failed"),
        errorLifecycleFields,
      );
      await fallbackTrajectoryRecorder?.flush();
      await deferredLifecycle.complete();
      throw err;
    }
  }

  return {
    startedAt,
    result,
    fallbackProvider,
    fallbackModel,
    fallbackExhausted,
    provider,
    model,
    sessionEntry,
    lifecycleGeneration,
    effectiveTurnThinkLevel,
    maintenanceAuthProfile,
    maintenanceExecutionSelection,
    compactionAccounting: compactionAccounting.fact,
    compactionRequestBudget: compactionAccounting.requestBudget,
    internalSessionTarget,
    attemptExecutionRuntime,
    messageChannel,
    suppressUserTurnPersistence,
    userTurnTranscriptRecorder,
    fallbackTrajectoryRecorder,
    deferredLifecycle,
    lifecycle,
    terminal,
  };
}
