/** Executes isolated cron prompts with model fallbacks and interim-ack retries. */

import { resolveGroupToolPolicyOutcome } from "../../agents/agent-tools.policy.js";
import { resolveCliBackendConfig } from "../../agents/cli-backends.js";
import {
  cliBackendAcceptsAuthProfileForwarding,
  resolveCliExecutionAuthProfileId,
} from "../../agents/cli-execution-auth.js";
import { resolveCliRuntimeToolsAllow } from "../../agents/cli-runner/tool-policy.js";
import { settleCliSessionResult } from "../../agents/cli-session-store.js";
import {
  applyCliSessionBindingResult,
  assertCliSessionBindingResultCommitAllowed,
} from "../../agents/cli-session.js";
import {
  runEmbeddedAgentEntry,
  type RunEntryCandidateOptions,
} from "../../agents/embedded-agent-runner/run-entry.js";
import { createDeferredEmbeddedRunLifecycleManager } from "../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js";
import type { FastModeAutoProgressState } from "../../agents/fast-mode.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { rootedAgentRunParams } from "../../agents/rooted-run-params.js";
import { resolveScheduledToolPolicyContext } from "../../agents/scheduled-tool-policy.js";
import { withLocalSessionPlacementTurnSettlement } from "../../agents/session-placement-admission.js";
import { resolveAgentLifecycleTerminalMetadata } from "../../auto-reply/reply/agent-lifecycle-terminal.js";
import type { VerboseLevel } from "../../auto-reply/thinking.js";
import type { CliSessionBinding } from "../../config/sessions.js";
import { buildGenericCliContextEngineHostSupport } from "../../context-engine/host-compat.js";
import { registerCronRunExecSource } from "../../infra/cron-run-exec-source.js";
import { prepareSessionExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
import {
  isAcpExecutionSelection,
  type ExecutionSelection,
  isModelExecutionSelection,
} from "../../model-picker/execution-selection.js";
import {
  createUserTurnTranscriptRecorder,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
} from "../../tasks/task-status-access.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { assertCronExecutionRootRuntime } from "../execution-root-runtime.js";
import { resolveCronScheduledToolPolicy } from "../scheduled-tool-policy.js";
import { resolveCronAuthenticatedChannelRequester } from "../tools-allow-provenance.js";
import type { CronAgentExecutionPhaseUpdate } from "../types.js";
import {
  resolveCronChannelOutputPolicy,
  resolveCurrentChannelTarget,
} from "./channel-output-policy.js";
import { resolveCronPayloadOutcome } from "./helpers.js";
import { createCronCandidateThinkingResolver } from "./model-selection.js";
import {
  assertCronRuntimeAuthorityCandidate,
  prepareCronPromptRunAdmission,
} from "./run-admission.js";
import {
  appendCronDeliveryInstruction,
  buildCronDeliveryTargetRuntimeContext,
} from "./run-delivery-trace.js";
import {
  getCliSessionBinding,
  LiveSessionModelSwitchError,
  logWarn,
  normalizeVerboseLevel,
  registerAgentRunContext,
  resolveBootstrapWarningSignaturesSeen,
  resolveCronAgentLane,
  resolveFastModeState,
  runCliAgent,
} from "./run-execution.runtime.js";
import { resolveCronFallbacksOverride } from "./run-fallback-policy.js";
import {
  resolveCronBootstrapContextMode,
  resolveIsolatedCronPromptCacheKey,
} from "./run-prompt.js";
import {
  setCronSessionAgentHarnessId,
  setCronSessionRuntimeModel,
  syncCronSessionLiveSelection,
} from "./run-session-state.js";
import type {
  CronCompletedPromptRun,
  CronExecutionResult,
  CronRunExecutionParams,
  CronRunnerStartedInfo,
} from "./run.types.js";
import { isLikelyInterimCronMessage } from "./subagent-followup-hints.js";

type CronEmbeddedRuntime = typeof import("./run-embedded.runtime.js");
type CronSubagentRegistryRuntime = typeof import("./run-subagent-registry.runtime.js");

const cronEmbeddedRuntimeLoader = createLazyImportLoader<CronEmbeddedRuntime>(
  () => import("./run-embedded.runtime.js"),
);
const cronSubagentRegistryRuntimeLoader = createLazyImportLoader<CronSubagentRegistryRuntime>(
  () => import("./run-subagent-registry.runtime.js"),
);

function hasCliSessionReuseMetadata(binding: CliSessionBinding): boolean {
  return Object.entries(binding).some(([key, value]) => key !== "sessionId" && value !== undefined);
}

/** Creates the model-fallback executor for one isolated cron prompt run. */
function createCronPromptExecutor(
  params: Omit<
    CronRunExecutionParams,
    "commandBody" | "isAborted" | "agentVerboseDefault" | "runStartedAt" | "onPromptCompleted"
  > & {
    resolvedVerboseLevel: VerboseLevel;
    onPromptCompleted: (run: CronCompletedPromptRun) => void;
  },
) {
  const sessionFile = params.runSessionKey;
  const fastModeStartedAtMs = Date.now();
  const fastModeAutoProgressState: FastModeAutoProgressState = {
    offAnnounced: false,
    resetAnnounced: false,
  };
  let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    params.cronSession.sessionEntry.systemPromptReport,
  );
  const bootstrapContextMode = resolveCronBootstrapContextMode(params.agentPayload);
  const validatedScheduledToolPolicy = resolveCronScheduledToolPolicy({
    toolsAllow: params.agentPayload?.toolsAllow,
    scheduledToolPolicy: params.job.scheduledToolPolicy,
    owner: params.job.owner,
  });
  const scheduledToolPolicy = resolveScheduledToolPolicyContext({
    toolsAllow: params.agentPayload?.toolsAllow,
    scheduledToolPolicy: validatedScheduledToolPolicy,
    callerOrigin: params.job.toolsAllowProvenance?.callerOrigin,
    execTarget: params.job.toolsAllowExecTarget,
  });
  const { sourceDelivery, runId } = params;
  const sourceReplyDeliveryMode = sourceDelivery.sourceReplyDeliveryMode;
  const messageChannel = sourceDelivery.target.channel ?? params.resolvedDelivery.channel;
  if (scheduledToolPolicy?.mode === "account") {
    const policyOutcome = resolveGroupToolPolicyOutcome({
      config: params.cfgWithAgentDefaults,
      sessionKey: scheduledToolPolicy.ownerSessionKey,
      messageProvider: messageChannel,
      accountId: scheduledToolPolicy.ownerAccountId,
      requireConfiguredAccount: true,
      senderPolicyMode: "never",
    });
    if (policyOutcome.kind === "account-unavailable") {
      throw new Error(policyOutcome.message);
    }
  }
  // Cron prompts may intentionally have nothing to report; both runners must agree on silence.
  const allowEmptyAssistantReplyAsSilent = true;
  const finalizePromptForResolvedTools = ({
    prompt,
    messageToolAvailable,
  }: {
    prompt: string;
    messageToolAvailable: boolean;
  }) => {
    const deliveryMessageToolAvailable = sourceDelivery.messageTool.enabled && messageToolAvailable;
    if (sourceReplyDeliveryMode === "message_tool_only" && !deliveryMessageToolAvailable) {
      throw new Error(
        "Cron source delivery requires the message tool, but the selected runtime does not expose it. Allow the message tool, choose a compatible runtime, or use automatic delivery.",
      );
    }
    const promptWithDeliveryGuidance = appendCronDeliveryInstruction({
      commandBody: prompt,
      deliveryRequested: params.deliveryRequested === true,
      messageToolEnabled: deliveryMessageToolAvailable,
      resolvedDeliveryOk: params.resolvedDeliveryOk,
      requireExplicitMessageTarget: sourceDelivery.messageTool.requireExplicitTarget,
    });
    const deliveryTargetRuntimeContext = buildCronDeliveryTargetRuntimeContext({
      resolvedDeliveryOk: params.resolvedDeliveryOk,
      messageToolAvailable: deliveryMessageToolAvailable,
      resolvedDelivery: params.resolvedDelivery,
      sourceDelivery,
    });
    return deliveryTargetRuntimeContext
      ? `${promptWithDeliveryGuidance}\n\n${deliveryTargetRuntimeContext}`.trim()
      : promptWithDeliveryGuidance;
  };
  let pendingUserTurn:
    | {
        promptText: string;
        recorder: UserTurnTranscriptRecorder;
      }
    | undefined;
  let attemptMediaTaskIds: ReadonlySet<string> = new Set();
  const candidateThinking = createCronCandidateThinkingResolver(params);
  const currentAttemptCommittedMedia = () =>
    hasNewGeneratedMediaTaskForSessionKey(params.runSessionKey, attemptMediaTaskIds);

  return async (promptText: string, runStartedAt: number): Promise<CronCompletedPromptRun> => {
    // A retry can fail during preparation, before any backend start callback.
    params.lifecycle.beginAttempt();
    const sessionTarget = {
      agentId: params.agentId,
      sessionId: params.cronSession.sessionEntry.sessionId,
      sessionKey: params.runSessionKey,
      storePath: params.cronSession.storePath,
    };
    const userTurnTranscriptRecorder =
      pendingUserTurn?.promptText === promptText
        ? pendingUserTurn.recorder
        : createUserTurnTranscriptRecorder({
            input: { text: promptText, provenance: params.inputProvenance },
            target: {
              ...sessionTarget,
              sessionEntry: params.cronSession.sessionEntry,
              cwd: params.workspaceDir,
              config: params.cfgWithAgentDefaults,
            },
            beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
            errorContext: "cron user turn transcript",
          });
    pendingUserTurn = { promptText, recorder: userTurnTranscriptRecorder };
    const {
      preparedRunAdmission,
      messageActionTurnCapability,
      close: closePromptAdmission,
    } = prepareCronPromptRunAdmission({
      cfg: params.cfgWithAgentDefaults,
      agentId: params.agentId,
      runId,
      sessionId: params.cronSession.sessionEntry.sessionId,
      sessionKey: params.runSessionKey,
      jobId: params.job.id,
      channelRequester: resolveCronAuthenticatedChannelRequester(params.job),
      toolsAllow: params.agentPayload?.toolsAllow,
      scheduledToolPolicy,
      executionIdentity: params.executionIdentity,
    });
    const onExecutionStarted = (info?: CronRunnerStartedInfo) => {
      params.onExecutionStarted?.(info);
      params.executionIdentity?.onExecutionStarted?.();
    };
    // Record the cron source fact at its producer for the run's lifetime so
    // exec-approval creation and standing-grant use never infer job identity
    // from session keys or run ids. Cleared when the run settles. A job whose
    // config cannot be canonicalized simply keeps standing grants inert; the
    // run itself must never fail for this diagnostic-side registration.
    let unregisterCronRunExecSource = () => {};
    try {
      unregisterCronRunExecSource = registerCronRunExecSource(runId, {
        agentId: params.agentId,
        jobId: params.job.id,
        jobConfigRevision: resolveCronJobConfigRevision(params.job),
        jobName: params.job.name,
      });
    } catch {
      // Non-canonicalizable job config: no grant registration for this run.
    }
    const execute = async () => {
      const accepted = params.liveSelection.selection;
      const cronFallbacksOverride = isModelExecutionSelection(accepted)
        ? (params.modelFallbacksOverride ??
          resolveCronFallbacksOverride({
            cfg: params.cfg,
            job: params.job,
            agentId: params.agentId,
            provider: accepted.model.provider,
            model: accepted.model.id,
            sessionEntry: params.cronSession.sessionEntry,
            useSubagentFallbacks: params.useSubagentFallbacks,
            inheritDefaultFallbacksForAgentStringModel:
              params.inheritDefaultFallbacksForAgentStringModel,
          }))
        : undefined;
      const runCandidate = async (
        candidateSelection: ExecutionSelection,
        runOptions: RunEntryCandidateOptions,
      ) => {
        if (isAcpExecutionSelection(candidateSelection)) {
          throw new Error("This automation belongs to the native manager.");
        }
        const selectedModel = isModelExecutionSelection(candidateSelection)
          ? candidateSelection.model
          : undefined;
        const candidateProvider = selectedModel?.provider;
        const candidateModel = selectedModel?.id;
        params.lifecycle.beginAttempt();
        const notifyExecutionStarted = (info?: { lifecycleGeneration?: string }) =>
          onExecutionStarted({
            ...info,
            ...(runOptions.isFallbackRetry ? { isFallback: true } : {}),
            provider: candidateProvider,
            model: candidateModel,
          });
        const notifyExecutionPhase = (
          info: Pick<CronAgentExecutionPhaseUpdate, "phase"> &
            Partial<Omit<CronAgentExecutionPhaseUpdate, "jobId" | "phase">>,
        ) =>
          params.onExecutionPhase?.({
            ...info,
            provider: candidateProvider,
            model: candidateModel,
          });
        attemptMediaTaskIds = getGeneratedMediaTaskIdsForSessionKey(params.runSessionKey);
        if (params.abortSignal?.aborted) {
          throw new Error(params.abortReason());
        }
        const candidateRuntime = candidateSelection.executor.id;
        const executionProvider =
          candidateSelection.executor.kind === "cli" ? candidateSelection.executor.id : undefined;
        const cliExecution = executionProvider !== undefined;
        const candidateThinkLevel = await candidateThinking.resolve(candidateSelection);
        const rootedExecution = params.executionRoot ? { root: params.executionRoot } : undefined;
        assertCronExecutionRootRuntime(
          params.executionRoot,
          candidateRuntime,
          cliExecution && Boolean(rootedExecution),
        );
        assertCronRuntimeAuthorityCandidate({
          authority: params.job.runtimeAuthority,
          candidateRuntime,
          cliExecution,
        });
        // The validated candidate that admits detached work owns its continuation
        // even if the provider throws before returning result metadata.
        setCronSessionRuntimeModel({
          entry: params.cronSession.sessionEntry,
          provider: candidateProvider,
          model: candidateModel,
        });
        setCronSessionAgentHarnessId({
          entry: params.cronSession.sessionEntry,
          agentHarnessId: candidateRuntime,
        });
        // Native bindings can exist before turn/start fails; deletion must retain
        // the selected owner even when no result metadata is ever returned.
        await params.persistSessionEntry();
        await params.persistRunContinuationSession?.();
        await params.setRunContinuationCliExecutionProvider?.(
          cliExecution ? executionProvider : undefined,
        );
        const bootstrapPromptWarningSignature = bootstrapPromptWarningSignaturesSeen.at(-1);
        // CLI providers can resume provider-native sessions; embedded providers
        // use OpenClaw's transcript/session file plus prompt-cache affinity.
        const fastModeState = selectedModel
          ? resolveFastModeState({
              cfg: params.cfgWithAgentDefaults,
              provider: selectedModel.provider,
              model: selectedModel.id,
              agentId: params.agentId,
              sessionEntry: params.cronSession.sessionEntry,
            })
          : { mode: params.cronSession.sessionEntry.fastMode, fastAutoOnSeconds: undefined };
        if (executionProvider && selectedModel) {
          const providerOverride = selectedModel.provider;
          const modelOverride = selectedModel.id;
          const allowCliAuthProfileForwarding = cliBackendAcceptsAuthProfileForwarding({
            provider: executionProvider,
            config: params.cfgWithAgentDefaults,
            agentId: params.agentId,
          });
          // Keep CLI work visible to recovery until execution and settlement finish.
          const deferredLifecycle = createDeferredEmbeddedRunLifecycleManager({
            runId,
            agentId: params.agentId,
            sessionId: params.cronSession.sessionEntry.sessionId,
            sessionKey: params.runSessionKey,
            sessionFile,
            abortSignal: params.abortSignal,
          });
          try {
            const cliAbortSignal = deferredLifecycle.signal;
            const result = await withLocalSessionPlacementTurnSettlement(
              {
                sessionId: params.cronSession.sessionEntry.sessionId,
                sessionKey: params.runSessionKey,
                agentId: params.agentId,
                runId,
              },
              async (assertSettlementCurrent) => {
                const diagnosticOwner = deferredLifecycle.handoffToCli();
                const cliSessionBinding = params.cronSession.isNewSession
                  ? undefined
                  : await getCliSessionBinding(params.cronSession.sessionEntry, executionProvider);
                const authProfileId = allowCliAuthProfileForwarding
                  ? resolveCliExecutionAuthProfileId({
                      cliExecutionProvider: executionProvider,
                      authProfileProvider: providerOverride,
                      config: params.cfgWithAgentDefaults,
                      agentDir: params.agentDir,
                      sessionBinding: cliSessionBinding,
                      selected: params.liveSelection.authProfileId
                        ? {
                            authProfileId: params.liveSelection.authProfileId,
                            authProfileIdSource:
                              params.liveSelection.authProfileIdSource === "user" ? "user" : "auto",
                          }
                        : undefined,
                    })
                  : undefined;
                const guardedCliSessionBinding =
                  cliSessionBinding && hasCliSessionReuseMetadata(cliSessionBinding)
                    ? cliSessionBinding
                    : undefined;
                const candidateResult = await runCliAgent({
                  preparedRunAdmission,
                  diagnosticOwner,
                  sessionId: params.cronSession.sessionEntry.sessionId,
                  sessionKey: params.runSessionKey,
                  sessionTarget,
                  sessionEntry: params.cronSession.sessionEntry,
                  contextWindow: params.cronSession.sessionEntry.contextWindow,
                  agentId: params.agentId,
                  trigger: "cron",
                  jobId: params.job.id,
                  messageActionTurnCapability,
                  cleanupCliLiveSessionOnRunEnd: params.usesDetachedRunSession === true,
                  sessionFile,
                  storePath: params.cronSession.storePath,
                  persistAssistantTranscript: true,
                  workspaceDir: params.executionRoot ?? params.workspaceDir,
                  bootstrapWorkspaceDir: params.workspaceDir,
                  rootedExecution,
                  config: params.cfgWithAgentDefaults,
                  prompt: promptText,
                  finalizePromptForResolvedTools,
                  modelProvider: providerOverride,
                  requesterModel: { provider: providerOverride, model: modelOverride },
                  modelHasVision: candidateThinking.hasVision(selectedModel),
                  provider: executionProvider,
                  model: modelOverride,
                  authProfileId,
                  thinkLevel: candidateThinkLevel,
                  timeoutMs: params.timeoutMs,
                  runId,
                  lane: resolveCronAgentLane(params.lane),
                  allowEmptyAssistantReplyAsSilent,
                  cliSessionId: cliSessionBinding?.sessionId,
                  cliSessionBinding: guardedCliSessionBinding,
                  skillsSnapshot: params.skillsSnapshot,
                  messageChannel,
                  agentAccountId: params.resolvedDelivery.accountId,
                  sourceReplyDeliveryMode,
                  requireExplicitMessageTarget: sourceDelivery.messageTool.requireExplicitTarget,
                  cliSessionBindingFacts: {
                    sourceReplyDeliveryMode,
                    requireExplicitMessageTarget: sourceDelivery.messageTool.requireExplicitTarget,
                  },
                  toolsAllow: resolveCliRuntimeToolsAllow(
                    params.agentPayload?.toolsAllow,
                    params.agentPayload?.toolsAllowIsDefault,
                  ),
                  scheduledToolPolicy,
                  abortSignal: cliAbortSignal,
                  onExecutionStarted: notifyExecutionStarted,
                  onExecutionPhase: notifyExecutionPhase,
                  bootstrapContextMode,
                  bootstrapContextRunKind: "cron",
                  bootstrapPromptWarningSignaturesSeen,
                  bootstrapPromptWarningSignature,
                  fastMode: fastModeState.mode,
                  fastModeAutoOnSeconds: fastModeState.fastAutoOnSeconds,
                  fastModeStartedAtMs,
                  fastModeAutoProgressState,
                  isFinalFallbackAttempt: runOptions.isFinalFallbackAttempt,
                  contextEngineLogicalTurnLease: runOptions.contextEngineLogicalTurnLease,
                  onContextEngineTurnCandidate: runOptions.onContextEngineTurnCandidate,
                  userTurnTranscriptRecorder,
                  suppressNextUserMessagePersistence:
                    userTurnTranscriptRecorder.hasPersisted() ||
                    userTurnTranscriptRecorder.isBlocked(),
                });
                const classification = runOptions.classifyResult(candidateResult);
                // Cleanup can seal this run after rejection. Publish the candidate
                // to the live entry only once the base persistence owner accepts it.
                const settledEntry = { ...params.cronSession.sessionEntry };
                if (
                  (candidateResult.meta.agentMeta?.clearCliSessionBinding === true ||
                    (!cliAbortSignal.aborted && !classification)) &&
                  applyCliSessionBindingResult(
                    settledEntry,
                    executionProvider,
                    candidateResult.meta.agentMeta,
                  )
                ) {
                  const assertCommitAllowed = () =>
                    assertCliSessionBindingResultCommitAllowed(
                      candidateResult.meta.agentMeta,
                      assertSettlementCurrent,
                      cliAbortSignal,
                    );
                  return await settleCliSessionResult(candidateResult, async () => {
                    await params.persistSessionEntry(assertCommitAllowed, settledEntry);
                    await params.persistRunContinuationSession?.(assertCommitAllowed);
                  });
                }
                return candidateResult;
              },
              {
                preparedRunAdmission,
                abortSignal: cliAbortSignal,
                trigger: "cron",
                isFinalFallbackAttempt: runOptions.isFinalFallbackAttempt,
              },
            );
            bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
              result.meta?.systemPromptReport,
            );
            return result;
          } catch (error) {
            // Process cancellation must retain the owner's terminal reason across fallback.
            deferredLifecycle.signal.throwIfAborted();
            throw error;
          } finally {
            await deferredLifecycle.complete();
          }
        }
        const { runEmbeddedAgent } = await cronEmbeddedRuntimeLoader.load();
        const promptCacheKey = selectedModel
          ? resolveIsolatedCronPromptCacheKey({
              job: params.job,
              agentId: params.agentId,
              agentSessionKey: params.agentSessionKey,
              provider: selectedModel.provider,
              model: selectedModel.id,
            })
          : undefined;
        const currentChannelId = await resolveCurrentChannelTarget({
          channel: messageChannel,
          to: params.resolvedDelivery.to,
          threadId: params.resolvedDelivery.threadId,
        });
        // Embedded runs receive both the explicit route and the current-channel
        // id so message-tool policy can target the same chat as fallback delivery.
        const result = await runEmbeddedAgent({
          preparedRunAdmission,
          sessionId: params.cronSession.sessionEntry.sessionId,
          sessionKey: params.runSessionKey,
          sessionTarget,
          promptCacheKey,
          agentId: params.agentId,
          trigger: "cron",
          jobId: params.job.id,
          cleanupBundleMcpOnRunEnd: params.usesDetachedRunSession === true,
          allowGatewaySubagentBinding: true,
          messageChannel,
          agentAccountId: params.resolvedDelivery.accountId,
          messageTo: params.resolvedDelivery.to,
          messageThreadId: params.resolvedDelivery.threadId,
          currentChannelId,
          agentDir: params.agentDir,
          ...rootedAgentRunParams(params.workspaceDir, params.executionRoot),
          config: params.cfgWithAgentDefaults,
          skillsSnapshot: params.skillsSnapshot,
          prompt: promptText,
          finalizePromptForResolvedTools,
          lane: resolveCronAgentLane(params.lane),
          provider: candidateProvider,
          model: candidateModel,
          agentHarnessRuntimeOverride: candidateRuntime,
          requestedRouteResolution: "resolved",
          modelFallbacksOverride: selectedModel ? cronFallbacksOverride : undefined,
          authProfileId: selectedModel ? params.liveSelection.authProfileId : undefined,
          authProfileIdSource:
            selectedModel && params.liveSelection.authProfileId
              ? params.liveSelection.authProfileIdSource
              : undefined,
          // Cron keeps overload failures local while sharing real credential failures.
          authProfileFailurePolicy: runOptions.authProfileFailurePolicy ?? "local_transient",
          // Fallback selection is turn-local. Revalidate the stored or
          // requested level without rewriting the durable preference.
          thinkLevel: candidateThinkLevel,
          fastMode: fastModeState.mode,
          fastModeAutoOnSeconds: fastModeState.fastAutoOnSeconds,
          fastModeStartedAtMs,
          fastModeAutoProgressState,
          isFinalFallbackAttempt: runOptions.isFinalFallbackAttempt,
          verboseLevel: params.resolvedVerboseLevel,
          timeoutMs: params.timeoutMs,
          runTimeoutOverrideMs: params.runTimeoutOverrideMs,
          bootstrapContextMode,
          bootstrapContextRunKind: "cron",
          toolsAllow: params.agentPayload?.toolsAllow,
          scheduledRuntimeAuthority: params.job.runtimeAuthority,
          scheduledRuntimeAuthorityRecoveryRequired:
            params.job.runtimeAuthorityRecoveryRequired === true,
          scheduledToolPolicy,
          execSession: params.cronSession.sessionEntry,
          messageActionTurnCapability,
          execOverrides: params.suppressExecNotifyOnExit
            ? {
                notifyOnExit: false,
                notifyOnExitEmptySuccess: false,
              }
            : undefined,
          sourceReplyDeliveryMode,
          runId,
          deferTerminalLifecycle: true,
          onAgentEvent: params.lifecycle.note,
          allowEmptyAssistantReplyAsSilent,
          // Cron owns the resolved delivery contract. A valid announce route
          // still needs a final payload; none, webhook, and invalid routes do not.
          terminalReplyExpectation:
            params.deliveryRequested === true && params.resolvedDeliveryOk
              ? "required"
              : "optional",
          requireExplicitMessageTarget: sourceDelivery.messageTool.requireExplicitTarget,
          disableMessageTool: !sourceDelivery.messageTool.enabled,
          forceMessageTool: sourceDelivery.messageTool.force,
          allowTransientCooldownProbe: runOptions.allowTransientCooldownProbe,
          contextEngineLogicalTurnLease: runOptions.contextEngineLogicalTurnLease,
          onContextEngineTurnCandidate: runOptions.onContextEngineTurnCandidate,
          assistantErrorTranscript: runOptions.assistantErrorTranscript,
          abortSignal: params.abortSignal,
          onExecutionStarted: notifyExecutionStarted,
          onExecutionPhase: notifyExecutionPhase,
          onLaneWait: params.onLaneWait,
          bootstrapPromptWarningSignaturesSeen,
          bootstrapPromptWarningSignature,
          userTurnTranscriptRecorder,
          suppressNextUserMessagePersistence:
            userTurnTranscriptRecorder.hasPersisted() || userTurnTranscriptRecorder.isBlocked(),
        });
        bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
          result.meta?.systemPromptReport,
        );
        return result;
      };
      const runEntry = {
        preparedRunAdmission,
        identity: {
          runId,
          sessionId: params.cronSession.sessionEntry.sessionId,
          lane: resolveCronAgentLane(params.lane),
          agentId: params.agentId,
          sessionKey: params.runSessionKey,
        },
        harness: {
          workspaceDir: params.executionRoot ?? params.workspaceDir,
          sessionKey: params.runSessionKey,
        },
        behavior: {
          kind: "command-rpc" as const,
          hasCommittedSideEffect: currentAttemptCommittedMedia,
        },
        abortSignal: params.abortSignal,
        runCandidate,
      };
      if (accepted.model === "native-managed") {
        const prepared = await prepareSessionExecutionSelection({
          cfg: params.cfgWithAgentDefaults,
          agentId: params.agentId,
          sessionKey: params.agentSessionKey,
          storePath: params.cronSession.storePath,
          sessionEntry: params.cronSession.sessionEntry,
          request: { kind: "selection", selection: accepted },
        });
        if (prepared.status !== "ready") {
          throw new Error(prepared.message);
        }
        return runEmbeddedAgentEntry({
          ...runEntry,
          kind: "native",
          selection: {
            cfg: params.cfgWithAgentDefaults,
            agentDir: params.agentDir,
            executionSelection: accepted,
            validateCommit: prepared.validateCommit,
          },
        });
      }
      return runEmbeddedAgentEntry({
        ...runEntry,
        selection: {
          cfg: params.cfgWithAgentDefaults,
          provider: accepted.model.provider,
          model: accepted.model.id,
          requestedRouteResolution: "resolved",
          agentDir: params.agentDir,
          userLockedAuthProfileId:
            params.liveSelection.authProfileIdSource === "user"
              ? params.liveSelection.authProfileId
              : undefined,
          fallbacksOverride: cronFallbacksOverride,
        },
        harness: {
          ...runEntry.harness,
          preparation: { kind: "direct" },
          prepareExecutionSelection: async (provider, model) => {
            const prepared = await prepareSessionExecutionSelection({
              cfg: params.cfgWithAgentDefaults,
              agentId: params.agentId,
              sessionKey: params.agentSessionKey,
              storePath: params.cronSession.storePath,
              sessionEntry: params.cronSession.sessionEntry,
              request: {
                kind: "fallback",
                selection: {
                  model: { provider, id: model },
                  executor: params.liveSelection.selection.executor,
                },
                explicitModels: [
                  `${accepted.model.provider}/${accepted.model.id}`,
                  ...(params.agentPayload?.fallbacks ?? []),
                ],
              },
            });
            if (prepared.status !== "ready") {
              throw new Error(prepared.message);
            }
            if (!isModelExecutionSelection(prepared.selection)) {
              throw new Error("This automation requires a direct execution selection.");
            }
            return { selection: prepared.selection, validateCommit: prepared.validateCommit };
          },
          resolveContextEngineHost: (selection) => {
            if (selection.executor.kind !== "cli") {
              return undefined;
            }
            const executionProvider = selection.executor.id;
            const backend = resolveCliBackendConfig(
              executionProvider,
              params.cfgWithAgentDefaults,
              {
                agentId: params.agentId,
              },
            );
            return buildGenericCliContextEngineHostSupport({
              backendId: backend?.id ?? executionProvider,
              ...(backend?.contextEngineHostCapabilities
                ? { capabilities: backend.contextEngineHostCapabilities }
                : {}),
            });
          },
        },
      });
    };
    const fallbackResult = await execute()
      .catch((error: unknown) => {
        params.lifecycle.capture("error", error);
        throw error;
      })
      .finally(() => {
        unregisterCronRunExecSource();
        closePromptAdmission();
      });
    const executionError =
      params.lifecycle.getDeferredError() ??
      (fallbackResult.result.meta.error || fallbackResult.outcome === "exhausted"
        ? "Agent run failed"
        : undefined);
    if (executionError) {
      params.lifecycle.capture(
        "error",
        executionError,
        resolveAgentLifecycleTerminalMetadata(fallbackResult.result.meta),
      );
    } else {
      params.lifecycle.capture("end", fallbackResult.result);
    }
    setCronSessionRuntimeModel({
      entry: params.cronSession.sessionEntry,
      provider: fallbackResult.provider,
      model: fallbackResult.model,
    });
    const completed = {
      runResult: fallbackResult.result,
      fallbackProvider: fallbackResult.provider,
      fallbackModel: fallbackResult.model,
      runStartedAt,
      runEndedAt: Date.now(),
    };
    params.onPromptCompleted(completed);
    await params.persistRunContinuationSession?.();
    pendingUserTurn = undefined;
    return completed;
  };
}

/** Executes an isolated cron prompt, including live model-switch and interim-ack retries. */
export async function executeCronRun(params: CronRunExecutionParams): Promise<CronExecutionResult> {
  const resolvedVerboseLevel: VerboseLevel =
    normalizeVerboseLevel(params.cronSession.sessionEntry.verboseLevel) ??
    normalizeVerboseLevel(params.agentVerboseDefault) ??
    "off";
  registerAgentRunContext(params.runId, {
    sessionKey: params.runSessionKey,
    sessionId: params.cronSession.sessionEntry.sessionId,
    verboseLevel: resolvedVerboseLevel,
  });
  const runStartedAt = params.runStartedAt ?? Date.now();
  const completedPromptRuns: CronCompletedPromptRun[] = [];
  const runPrompt = createCronPromptExecutor({
    ...params,
    resolvedVerboseLevel,
    onPromptCompleted: (run) => {
      completedPromptRuns.push(run);
      params.onPromptCompleted?.(completedPromptRuns);
    },
  });

  const MAX_MODEL_SWITCH_RETRIES = 2;
  let modelSwitchRetries = 0;
  let promptMediaTaskIds: ReadonlySet<string> = new Set();
  let execution: CronCompletedPromptRun;
  while (true) {
    try {
      promptMediaTaskIds = getGeneratedMediaTaskIdsForSessionKey(params.runSessionKey);
      execution = await runPrompt(params.commandBody, runStartedAt);
      break;
    } catch (err) {
      if (
        !(err instanceof LiveSessionModelSwitchError) ||
        hasNewGeneratedMediaTaskForSessionKey(params.runSessionKey, promptMediaTaskIds)
      ) {
        throw err;
      }
      modelSwitchRetries += 1;
      if (modelSwitchRetries > MAX_MODEL_SWITCH_RETRIES) {
        logWarn(
          `[cron:${params.job.id}] LiveSessionModelSwitchError retry limit reached (${MAX_MODEL_SWITCH_RETRIES}); aborting`,
        );
        throw err;
      }
      params.liveSelection.selection = err.selection;
      params.liveSelection.authProfileId = err.authProfileId;
      params.liveSelection.authProfileIdSource = err.authProfileId
        ? err.authProfileIdSource
        : undefined;
      syncCronSessionLiveSelection({
        entry: params.cronSession.sessionEntry,
        liveSelection: params.liveSelection,
      });
      try {
        // Persist the switched model before retrying so later delivery/session
        // metadata agrees with the model that actually handled the run.
        await params.persistSessionEntry();
        await params.persistRunContinuationSession?.();
      } catch (persistErr) {
        logWarn(
          `[cron:${params.job.id}] Failed to persist model switch session entry: ${String(persistErr)}`,
        );
      }
      continue;
    }
  }

  const { runResult } = execution;
  if (!params.isAborted()) {
    const interimPayloads = runResult.payloads ?? [];
    const {
      deliveryPayloadHasStructuredContent: interimPayloadHasStructuredContent,
      hasFatalErrorPayload: interimHasFatalErrorPayload,
      outputText: interimOutputText,
    } = resolveCronPayloadOutcome({
      payloads: interimPayloads,
      runLevelError: runResult.meta?.error,
      failureSignal: runResult.meta?.failureSignal,
      finalAssistantVisibleText: runResult.meta?.finalAssistantVisibleText,
      preferFinalAssistantVisibleText: (
        await resolveCronChannelOutputPolicy(params.resolvedDelivery.channel, {
          deliveryRequested: params.deliveryRequested,
        })
      ).preferFinalAssistantVisibleText,
    });
    const interimText = interimOutputText?.trim() ?? "";
    const shouldRetryInterimAck =
      !runResult.meta?.error &&
      !interimHasFatalErrorPayload &&
      !runResult.didSendViaMessagingTool &&
      !hasNewGeneratedMediaTaskForSessionKey(params.runSessionKey, promptMediaTaskIds) &&
      !interimPayloadHasStructuredContent &&
      !interimPayloads.some((payload) => payload?.isError === true) &&
      isLikelyInterimCronMessage(interimText);

    let hasFreshDescendants = false;
    let hasActiveDescendants = false;
    if (shouldRetryInterimAck) {
      const { countActiveDescendantRuns, listDescendantRunsForRequester } =
        await cronSubagentRegistryRuntimeLoader.load();
      hasFreshDescendants = listDescendantRunsForRequester(params.runSessionKey).some((entry) => {
        const descendantStartedAt =
          typeof entry.execution.startedAt === "number"
            ? entry.execution.startedAt
            : entry.createdAt;
        return typeof descendantStartedAt === "number" && descendantStartedAt >= runStartedAt;
      });
      hasActiveDescendants = countActiveDescendantRuns(params.runSessionKey) > 0;
    }

    if (shouldRetryInterimAck && !hasFreshDescendants && !hasActiveDescendants) {
      // Retry a bare acknowledgement only when no descendant subagent was
      // spawned; otherwise delivery waits for the subagent follow-up path.
      const continuationPrompt = [
        "Your previous response was only an acknowledgement and did not complete this cron task.",
        "Complete the original task now.",
        "Do not send a status update like 'on it'.",
        "Use tools when needed, including sessions_spawn for parallel subtasks, wait for spawned subagents to finish, then return only the final summary.",
      ].join(" ");
      execution = await runPrompt(continuationPrompt, Date.now());
    }
  }

  return {
    ...execution,
    runStartedAt,
    completedPromptRuns,
  };
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
