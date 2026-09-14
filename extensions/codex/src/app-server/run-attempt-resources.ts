import { randomUUID } from "node:crypto";
import {
  embeddedAgentLog,
  runAgentCleanupStep,
  type AgentHarnessRuntimeArtifactBinding,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveCodexStartupTimeoutMs } from "./attempt-timeouts.js";
import { protectCodexAppServerLiveThread } from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import { shouldAutoApproveCodexAppServerApprovals } from "./config.js";
import { resolveCodexToolAbortTerminalReason } from "./dynamic-tool-execution.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import { buildCodexHookRequester } from "./hook-requester.js";
import {
  buildCodexNativeHookRelayCommandPlan,
  buildCodexNativeHookRelayDisabledConfig,
  buildCodexNativeHookRelayConfig,
  CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS,
  createCodexNativeHookRelay,
  emitCodexNativePreToolUseFailureDiagnostic,
  type CodexNativePreToolUseFailure,
  type CodexNativeHookRelay,
} from "./native-hook-relay.js";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import type { CodexSandboxPolicy, CodexTurnEnvironmentParams } from "./protocol.js";
import type { CodexAttemptPrompt } from "./run-attempt-prompt.js";
import {
  releaseCodexSandboxExecServerEnvironment,
  type CodexSandboxExecEnvironment,
} from "./sandbox-exec-server.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import {
  clearSharedCodexAppServerClientIfCurrentAndUnclaimed,
  createIsolatedCodexAppServerClient,
  retainSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import type { CodexThreadFinalConfigPatchResult } from "./thread-lifecycle-types.js";
import type { CodexAppServerThreadLifecycleBinding } from "./thread-lifecycle.js";
import { createCodexTrajectoryRecorder } from "./trajectory.js";
import type { CodexAppServerTurnRouter, CodexThreadRouteReservation } from "./turn-router.js";

export function prepareCodexAttemptResources(prompt: CodexAttemptPrompt) {
  const { context, turnState, buildRenderedCodexDeveloperInstructions } = prompt;
  const { runtime, attemptTools } = context;
  const { connection, hookChannelId } = runtime;
  const {
    appServer,
    params,
    effectiveCwd,
    sessionAgentId,
    contextSessionKey,
    runAbortController,
    sandbox,
    options,
    nativeHookRelay: guardedNativeHookRelay,
    nativeHookRelayEvents,
  } = connection;
  const { toolBridge } = attemptTools;
  const trajectoryRecorder = createCodexTrajectoryRecorder({
    attempt: params,
    cwd: effectiveCwd,
    developerInstructions: buildRenderedCodexDeveloperInstructions(),
    prompt: turnState.codexTurnPromptText,
    trajectory: params.hostCapabilities.trajectory,
    tools: toolBridge.availableSpecs,
  });
  const initialResourceState: {
    sandboxExecEnvironment: CodexSandboxExecEnvironment | undefined;
    executionDisconnectError: Error | undefined;
    releaseInferenceContext: (() => void) | undefined;
  } = {
    sandboxExecEnvironment: undefined,
    executionDisconnectError: undefined,
    releaseInferenceContext: undefined,
  };
  const state = {
    client: undefined as unknown as CodexAppServerClient,
    thread: undefined as unknown as CodexAppServerThreadLifecycleBinding,
    runtimeArtifact: undefined as AgentHarnessRuntimeArtifactBinding | undefined,
    turnRouter: undefined as unknown as CodexAppServerTurnRouter,
    turnRoute: undefined as CodexThreadRouteReservation | undefined,
    routeActivated: false,
    detachRouteAbort: (() => undefined) as () => void,
    trajectoryEndRecorded: false,
    nativeHookRelay: undefined as CodexNativeHookRelay | undefined,
    nativeSubagentMonitor: undefined as
      | ReturnType<typeof codexNativeSubagentMonitorRuntime.register>
      | undefined,
    runtimeContinuationStarted: false,
    nativePreToolUseFailureFallbackActive: false,
    nativePreToolUseFailureFallbackTerminalReason: undefined as
      | CodexNativePreToolUseFailure["disposition"]
      | undefined,
    releaseSharedClientLease: undefined as (() => void) | undefined,
    startupClientUnsafe: false,
    sharedCodexClientRetiredForOneShotCleanup: false,
    ...initialResourceState,
    codexEnvironmentSelection: undefined as CodexTurnEnvironmentParams[] | undefined,
    codexExecutionCwd: effectiveCwd,
    codexSandboxPolicy: undefined as CodexSandboxPolicy | undefined,
    restartContextEngineCodexThread: undefined as
      | (() => Promise<CodexAppServerThreadLifecycleBinding>)
      | undefined,
  };
  const pendingNativePreToolUseFailures: CodexNativePreToolUseFailure[] = [];
  const projectorRef: { current?: CodexAppServerEventProjector } = {};
  const emitNativePreToolUseFailure = (failure: CodexNativePreToolUseFailure) => {
    emitCodexNativePreToolUseFailureDiagnostic({
      agentId: sessionAgentId,
      sessionId: params.sessionId,
      sessionKey: contextSessionKey,
      runId: params.runId,
      signal: runAbortController.signal,
      failure,
      ...(state.nativePreToolUseFailureFallbackActive
        ? {
            terminalReason:
              state.nativePreToolUseFailureFallbackTerminalReason ?? failure.disposition,
          }
        : {}),
    });
  };
  const flushPendingNativePreToolUseFailures = () => {
    for (const failure of pendingNativePreToolUseFailures.splice(0)) {
      emitNativePreToolUseFailure(failure);
    }
  };
  const activateNativePreToolUseFailureFallback = () => {
    if (!state.nativePreToolUseFailureFallbackActive) {
      state.nativePreToolUseFailureFallbackTerminalReason = runAbortController.signal.aborted
        ? resolveCodexToolAbortTerminalReason(runAbortController.signal)
        : undefined;
      state.nativePreToolUseFailureFallbackActive = true;
    }
    flushPendingNativePreToolUseFailures();
  };
  const releaseSharedClientLeaseOnce = () => {
    const release = state.releaseSharedClientLease;
    if (!release) {
      return;
    }
    state.releaseSharedClientLease = undefined;
    release();
  };
  const retireSharedCodexClientForOneShotCleanup = async () => {
    if (
      params.cleanupBundleMcpOnRunEnd !== true ||
      state.sharedCodexClientRetiredForOneShotCleanup
    ) {
      return;
    }
    state.sharedCodexClientRetiredForOneShotCleanup = true;
    const retired = clearSharedCodexAppServerClientIfCurrentAndUnclaimed(state.client);
    // Runs on every one-shot attempt teardown; routine retirement checks are
    // diagnostic detail, not operator-facing info.
    embeddedAgentLog.debug("codex app-server one-shot cleanup checked shared client retirement", {
      runId: params.runId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      activeLeases: retired.activeLeases,
      pendingAcquires: retired.pendingAcquires,
      closed: retired.closed,
      matchedSharedClient: retired.found,
    });
    // Retained peers prevent retirement; preserve their client without treating
    // missing close evidence as a completed one-shot cleanup.
    const result = retired.closed
      ? await state.client.closeAndWait({ exitTimeoutMs: 2_000, forceKillDelayMs: 250 })
      : undefined;
    if (params.oneShotCliRun && result?.cleanup !== "closed") {
      throw new Error("Codex one-shot client cleanup could not be confirmed");
    }
  };
  const releaseSandboxExecEnvironment = async () => {
    if (state.sandboxExecEnvironment) {
      const environment = state.sandboxExecEnvironment;
      state.sandboxExecEnvironment = undefined;
      await releaseCodexSandboxExecServerEnvironment(sandbox, environment);
    }
  };
  const releaseSharedClientLeaseAndRetireOneShotClient = async () => {
    if (connection.attemptClientFactory === createIsolatedCodexAppServerClient) {
      // Close the authorized node lease first; losing its socket first is a real disconnect.
      await releaseSandboxExecEnvironment();
      const ownedClient = state.releaseSharedClientLease ? state.client : undefined;
      releaseSharedClientLeaseOnce();
      if (ownedClient) {
        const result = await ownedClient.closeAndWait({
          exitTimeoutMs: 2_000,
          forceKillDelayMs: 250,
        });
        if (params.oneShotCliRun && result.cleanup !== "closed") {
          throw new Error("Codex isolated client cleanup could not be confirmed");
        }
      }
      return;
    }
    releaseSharedClientLeaseOnce();
    await retireSharedCodexClientForOneShotCleanup();
  };
  const runCleanupStep = (step: string, operation: () => Promise<void> | void | undefined) =>
    runAgentCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step,
      log: embeddedAgentLog,
      cleanup: async () => {
        await operation();
      },
    });
  const unregisterNativeSubagentMonitor = () => {
    state.nativeSubagentMonitor?.unregister();
    state.nativeSubagentMonitor = undefined;
  };
  const registerNativeSubagentMonitor = (parentThreadId: string) => {
    unregisterNativeSubagentMonitor();
    const sessionKey = params.sessionKey;
    const storePath = params.sessionTarget?.storePath;
    const parentSession =
      sessionKey && storePath
        ? getSessionEntry({
            agentId: sessionAgentId,
            sessionKey,
            storePath,
            readConsistency: "latest",
            hydrateSkillPromptRefs: false,
          })
        : undefined;
    state.nativeSubagentMonitor = codexNativeSubagentMonitorRuntime.register({
      client: state.client,
      parentThreadId,
      requesterSessionKey: params.sessionKey,
      taskRuntimeScope: params.agentHarnessTaskRuntimeScope,
      historyOwner: createCodexNativeSubagentHistoryOwner({
        parentThreadId,
        sessionId: params.sessionId,
        ...(parentSession?.sessionId === params.sessionId
          ? { lifecycleRevision: parentSession.lifecycleRevision }
          : {}),
        binding: state.thread,
      }),
      agentId: sessionAgentId,
      retainClient: () => retainSharedCodexAppServerClientIfCurrent(state.client),
      retainParentThread: (protectedThreadId) =>
        protectCodexAppServerLiveThread(state.client, protectedThreadId),
      claimDirectChild: (childThreadId) => state.nativeHookRelay?.claimDirectChild(childThreadId),
      rejectPendingDirectChild: (childThreadId, reason) =>
        state.nativeHookRelay?.rejectPendingDirectChild(childThreadId, reason),
      ...(params.sessionKey && params.agentHarnessTaskRuntimeScope
        ? {
            onDirectChildAccepted: () => {
              state.runtimeContinuationStarted = true;
            },
          }
        : {}),
    });
  };
  const releaseCurrentRoute = () => {
    state.releaseInferenceContext?.();
    state.releaseInferenceContext = undefined;
    state.detachRouteAbort();
    state.detachRouteAbort = () => undefined;
    state.turnRoute?.release();
    state.turnRoute = undefined;
    state.routeActivated = false;
    unregisterNativeSubagentMonitor();
  };
  const startupTimeoutMs = resolveCodexStartupTimeoutMs({
    timeoutMs: params.timeoutMs,
    timeoutFloorMs: options.startupTimeoutFloorMs,
  });
  const requesterChannel = params.messageChannel ?? params.messageProvider;
  const requester = buildCodexHookRequester(params);
  const buildNativeHookRelayFinalConfigPatch = async (
    decision: { action: "resume"; binding: CodexAppServerThreadBinding } | { action: "start" },
  ): Promise<CodexThreadFinalConfigPatchResult> => {
    connection.assertCurrent();
    const generation =
      (decision.action === "resume" ? decision.binding.nativeHookRelayGeneration : undefined) ??
      randomUUID();
    const relayParams: Parameters<typeof createCodexNativeHookRelay>[0] = {
      options: guardedNativeHookRelay,
      generation,
      generationMismatchGraceMs:
        decision.action === "resume" && !decision.binding.nativeHookRelayGeneration
          ? CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS
          : undefined,
      events: nativeHookRelayEvents,
      agentId: sessionAgentId,
      sessionId: params.sessionId,
      sessionKey: contextSessionKey,
      config: params.config,
      autoApproveMcpTools: shouldAutoApproveCodexAppServerApprovals(appServer),
      projectedMcpServers: runtime.bundleMcpThreadConfig.configPatch?.mcp_servers,
      runId: params.runId,
      channelId: hookChannelId,
      ...(requester ? { requester } : {}),
      approvalContext: {
        trigger: params.trigger,
        approvalReviewerDeviceId: params.approvalReviewerDeviceId,
        turnSourceChannel: requesterChannel,
        turnSourceTo: params.currentMessagingTarget ?? params.currentChannelId,
        turnSourceAccountId: params.agentAccountId,
        turnSourceThreadId: params.currentThreadTs,
      },
      attemptTimeoutMs: params.timeoutMs,
      startupTimeoutMs,
      turnStartTimeoutMs: params.timeoutMs,
      loopDetectionPreToolUseRelay: appServer.loopDetectionPreToolUseRelay,
      signal: runAbortController.signal,
      hostCapabilities: params.hostCapabilities,
      assertCurrent: connection.assertCurrent,
      onPreToolUseFailure: (failure) => {
        const projector = projectorRef.current;
        if (projector) {
          projector.recordNativeToolPreToolUseFailure(failure);
        } else if (state.nativePreToolUseFailureFallbackActive) {
          emitNativePreToolUseFailure(failure);
        } else {
          pendingNativePreToolUseFailures.push(failure);
        }
      },
    };
    const restricted = params.pluginHarnessToolPolicyRestricted === true;
    const enabled = !restricted && guardedNativeHookRelay?.enabled !== false;
    // Native start/cold resume rebuild CLI + request config, so opt-out omits our
    // overlay without clearing operator hooks. Live incognito must reject changes
    // before the previous relay or its retained children are touched.
    const configPatch = restricted
      ? buildCodexNativeHookRelayDisabledConfig()
      : enabled
        ? buildCodexNativeHookRelayConfig({
            relay: buildCodexNativeHookRelayCommandPlan({ ...relayParams, generation }),
            events: nativeHookRelayEvents,
            hookTimeoutSec: guardedNativeHookRelay?.hookTimeoutSec,
          })
        : {};
    return {
      configPatch,
      nativeHookRelayGeneration: enabled ? generation : undefined,
      activate: async () => {
        connection.assertCurrent();
        const previousRelay = state.nativeHookRelay;
        previousRelay?.unregister();
        await previousRelay?.drain();
        connection.assertCurrent();
        state.nativeHookRelay = restricted ? undefined : createCodexNativeHookRelay(relayParams);
        await state.nativeHookRelay?.prepareInvocation();
        connection.assertCurrent();
      },
    };
  };
  return {
    prompt,
    trajectoryRecorder,
    state,
    projectorRef,
    pendingNativePreToolUseFailures,
    markTrajectoryEndRecorded: () => {
      state.trajectoryEndRecorded = true;
    },
    activateNativePreToolUseFailureFallback,
    releaseSharedClientLeaseOnce,
    releaseSharedClientLeaseAndRetireOneShotClient,
    releaseSandboxExecEnvironment,
    runCleanupStep,
    registerNativeSubagentMonitor,
    releaseCurrentRoute,
    startupTimeoutMs,
    buildNativeHookRelayFinalConfigPatch,
  };
}

export type CodexAttemptResources = ReturnType<typeof prepareCodexAttemptResources>;
