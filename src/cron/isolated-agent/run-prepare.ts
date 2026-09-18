/** Session identity and context preparation for isolated cron runs. */
import { isDeepStrictEqual } from "node:util";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope.js";
import { findModelInCatalog } from "../../agents/model-catalog-lookup.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  type PreparedModelRuntimeLease,
} from "../../agents/prepared-model-runtime.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import { resolveSessionWorkStartError } from "../../config/sessions/lifecycle.js";
import { resolveCreatorSandbox } from "../../gateway/operator-role-policy.js";
import {
  commitSessionExecutionSelection,
  prepareSessionExecutionSelection,
} from "../../model-picker/apply-session-model-selection.js";
import {
  getSessionExecutionSelection,
  isAcpExecutionSelection,
  isModelExecutionSelection,
} from "../../model-picker/execution-selection.js";
import { isCronSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
} from "../../sessions/agent-harness-session-key.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { resolveCronSkillsSnapshot } from "../../skills/runtime/cron-snapshot.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import { resolveCronScheduledToolPolicy } from "../scheduled-tool-policy.js";
import { isDetachedCronSessionTarget } from "../session-target.js";
import {
  resolveCronModelSelection,
  resolveCronModelSelectionOwner,
  resolveCronThinkingSelection,
} from "./model-selection.js";
import { resolveCronCommandPromptPreflight } from "./run-command-preflight.js";
import { resolveCronActiveRuntimeConfig, resolveCronAgentConfig } from "./run-config.js";
import {
  createCronToolsAllowPreflightDiagnostics,
  resolveCronDeliveryContext,
} from "./run-delivery-trace.js";
import { resolveCronPreflight } from "./run-fallback-policy.js";
import {
  resolveCronAuthSelection,
  loadSessionAccessorRuntime,
  retireRolledCronSessionMcpRuntime,
  type RunCronAgentTurnParams,
  type WithRunSession,
} from "./run-prepare-runtime.js";
import { buildCronCommandBody } from "./run-prompt.js";
import {
  CronSessionLifecycleClaimError,
  createCronRunContinuationSession,
  createPersistCronSessionEntry,
  markCronSessionPreRun,
  persistCronSkillsSnapshotIfChanged,
  projectCronOwnershipFields,
  resolveCronLifecycleRevisionIdentity,
  type CronLiveSelection,
  type CronSessionRowWriter,
} from "./run-session-state.js";
import { resolveCronRunTimeoutOverrideMs } from "./run-timeout.js";
import {
  ensureAgentWorkspace,
  logWarn,
  normalizeAgentId,
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentTimeoutMs,
  resolveAgentWorkspaceDir,
  resolveHookExternalContentSource,
  resolveAcceptedSessionRuntimeId,
  resolveThinkingSelection,
} from "./run.runtime.js";
import type { PreparedCronRunContext, RunCronAgentTurnResult } from "./run.types.js";
import { resolveCronAgentSessionKey } from "./session-key.js";
import { loadCronSessionEntryLatest, resolveCronSession } from "./session.js";

type CronPreparationResult =
  | { ok: true; context: PreparedCronRunContext }
  | { ok: false; result: RunCronAgentTurnResult };

export async function prepareCronRunContext(params: {
  input: RunCronAgentTurnParams;
  isFastTestEnv: boolean;
  onLifecycleInterrupt: () => void;
}): Promise<CronPreparationResult> {
  const { input } = params;
  const commandPromptPreflight = resolveCronCommandPromptPreflight(input.job);
  if (commandPromptPreflight) {
    return { ok: false, result: commandPromptPreflight };
  }
  const requestedRuntimeCfg = resolveCronActiveRuntimeConfig(input.cfg);
  const requestedAgentId = input.agentId?.trim() || input.job.agentId?.trim();
  const normalizedRequested = requestedAgentId ? normalizeAgentId(requestedAgentId) : undefined;
  const requiredAgentId =
    normalizedRequested ?? parseAgentSessionKey(input.job.sessionKey ?? input.sessionKey)?.agentId;
  const initialAgentId = resolveCronJobEffectiveAgentId(
    { agentId: requiredAgentId },
    tryResolveAmbientOwnerAgentId(requestedRuntimeCfg),
  );
  const publishedRuntime = await loadPublishedGatewayReplyDispatchRuntime({
    agentId: initialAgentId,
    abortSignal: input.abortSignal ?? input.signal,
  });
  const modelOwner = await resolveCronModelSelectionOwner({
    cfg: requestedRuntimeCfg,
    publishedRuntime,
    ...(requiredAgentId
      ? {
          agentId: initialAgentId,
          requiredAgentId,
          agentDir: resolveAgentDir(requestedRuntimeCfg, initialAgentId),
          workspaceDir: resolveAgentWorkspaceDir(requestedRuntimeCfg, initialAgentId),
        }
      : {}),
  });
  const { agentId, agentDir } = modelOwner;
  const agentConfigOverride = requiredAgentId
    ? resolveAgentConfig(modelOwner.config, agentId)
    : undefined;
  const { runtimeConfig: runtimeCfg, agentDefaults: agentCfg } = resolveCronAgentConfig({
    config: modelOwner.config,
    agentConfigOverride,
  });
  const baseSessionKey = (input.sessionKey?.trim() || `cron:${input.job.id}`).trim();
  const currentBoundSourceKey =
    input.job.sessionTarget === "current" ? input.job.sessionKey?.trim() : undefined;
  const usesDetachedRunSession =
    isDetachedCronSessionTarget(input.job.sessionTarget) || Boolean(currentBoundSourceKey);
  const baseSessionKeyIsCron =
    baseSessionKey.startsWith("cron:") || isCronSessionKey(baseSessionKey);
  const cronExecutionSessionKey =
    usesDetachedRunSession && !baseSessionKeyIsCron ? `cron:${input.job.id}` : baseSessionKey;
  const agentSessionKey = resolveCronAgentSessionKey({
    sessionKey: cronExecutionSessionKey,
    agentId,
    mainKey: runtimeCfg.session?.mainKey,
    cfg: runtimeCfg,
  });
  const resolvedBaseSessionKey = resolveCronAgentSessionKey({
    sessionKey: currentBoundSourceKey ?? baseSessionKey,
    agentId,
    mainKey: runtimeCfg.session?.mainKey,
    cfg: runtimeCfg,
  });
  const sourceSessionKey =
    currentBoundSourceKey && resolvedBaseSessionKey !== agentSessionKey
      ? resolvedBaseSessionKey
      : undefined;
  const payloadHookExternalContentSource =
    input.job.payload.kind === "agentTurn" ? input.job.payload.externalContentSource : undefined;
  const hookExternalContentSource =
    payloadHookExternalContentSource ?? resolveHookExternalContentSource(baseSessionKey);

  const workspace = await ensureAgentWorkspace({
    dir: modelOwner.workspaceDir,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap && !params.isFastTestEnv,
    skipOptionalBootstrapFiles: agentCfg?.skipOptionalBootstrapFiles,
    provisioning: await (
      await import("../../agents/acp-workspace-provisioning.js")
    ).resolveAcpAgentWorkspaceProvisioningForTurn({ cfg: runtimeCfg, agentId }),
  });
  const workspaceDir = workspace.dir;
  const executionWorkspaceDir = input.executionRoot ?? workspaceDir;

  const isGmailHook = hookExternalContentSource === "gmail";
  const now = Date.now();
  const sandbox = resolveCreatorSandbox(runtimeCfg, { actor: input.job.createdActor });
  const cronSession = resolveCronSession({
    cfg: runtimeCfg,
    sessionKey: agentSessionKey,
    sourceSessionKey,
    skillLibrarySelections: input.job.skillLibrarySelections,
    agentId,
    nowMs: now,
    forceNew: usesDetachedRunSession,
    hookExternalContentSource,
  });
  const sourceEntry = sourceSessionKey ? cronSession.store[sourceSessionKey] : undefined;
  const sourceSessionGeneration = sourceEntry
    ? { sessionId: sourceEntry.sessionId, lifecycleRevision: sourceEntry.lifecycleRevision }
    : undefined;
  const reservedKey = isAgentHarnessSessionKey(agentSessionKey);
  if (cronSession.initialSessionEntry?.modelSelectionLocked === true) {
    throw new Error(
      reservedKey
        ? AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE
        : AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
    );
  }
  if (reservedKey && !cronSession.initialSessionEntry) {
    throw new Error(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);
  }
  const runSessionId = cronSession.sessionEntry.sessionId;
  const currentRunSessionId = () => cronSession.sessionEntry.sessionId ?? runSessionId;
  const usesExactRunSession = usesDetachedRunSession || baseSessionKey.startsWith("cron:");
  const runSessionKey = usesExactRunSession
    ? `${agentSessionKey}:run:${runSessionId}`
    : agentSessionKey;
  const initialSessionEntry = cronSession.initialSessionEntry;
  // Claim before async model prep so maintenance cannot delete this session generation.
  const sessionWorkAdmission = await beginSessionWorkAdmission({
    scope: cronSession.storePath,
    identities: [
      agentSessionKey,
      initialSessionEntry?.sessionId,
      cronSession.sessionEntry.sessionId,
      resolveCronLifecycleRevisionIdentity(cronSession.lifecycleRevision),
      runSessionKey,
    ],
    signal: input.abortSignal ?? input.signal,
    onInterrupt: params.onLifecycleInterrupt,
    assertAllowed: () => {
      const currentEntry = loadCronSessionEntryLatest(cronSession.storePath, agentSessionKey);
      const changed = initialSessionEntry
        ? !currentEntry ||
          !isDeepStrictEqual(
            projectCronOwnershipFields(currentEntry),
            projectCronOwnershipFields(initialSessionEntry),
          )
        : Boolean(currentEntry);
      if (changed) {
        throw new CronSessionLifecycleClaimError(agentSessionKey);
      }
      const archivedSessionError = resolveSessionWorkStartError(agentSessionKey, currentEntry);
      if (archivedSessionError) {
        throw new CronSessionLifecycleClaimError(agentSessionKey, archivedSessionError);
      }
    },
  });

  let preparedModelRuntimeLease: PreparedModelRuntimeLease | undefined;
  let validateInitialSelection: (() => string | undefined) | undefined;
  const validateSelectionCommit = () => {
    const error = validateInitialSelection?.();
    if (error) {
      throw new CronSessionLifecycleClaimError(agentSessionKey, error);
    }
  };
  try {
    const persistCronSessionRow: CronSessionRowWriter = async ({
      storePath,
      sessionKey,
      fallbackEntry,
      resetBoundary,
      update,
      assertCommitAllowed,
    }) => {
      const { applySessionEntryLifecycleMutation, patchSessionEntryCore } =
        await loadSessionAccessorRuntime();
      if (resetBoundary) {
        await applySessionEntryLifecycleMutation({
          activeSessionKey: sessionKey,
          agentId,
          storePath,
          upserts: [
            {
              sessionKey,
              resetBoundary,
              buildEntry: ({ currentEntry }) => {
                validateSelectionCommit();
                return update(currentEntry);
              },
            },
          ],
          skipMaintenance: true,
        });
        validateInitialSelection = undefined;
        return;
      }
      // Guarded replace reads the freshest row so lifecycle claims reject stale owners.
      await patchSessionEntryCore(
        { storePath, sessionKey, agentId },
        (_entry, context) => {
          validateSelectionCommit();
          return update(context.existingEntry);
        },
        { fallbackEntry, replaceEntry: true, assertCommitAllowed },
      );
      validateInitialSelection = undefined;
    };
    const persistSessionEntry = createPersistCronSessionEntry({
      cronSession,
      agentSessionKey,
      createdActor: input.job.createdActor,
      sandbox,
      workspaceDir,
      persistSessionEntry: persistCronSessionRow,
    });
    const withRunSession: WithRunSession = (result) => ({
      ...result,
      sessionId: currentRunSessionId(),
      sessionKey: runSessionKey,
    });
    if (!cronSession.sessionEntry.label?.trim() && baseSessionKey.startsWith("cron:")) {
      const labelSuffix =
        typeof input.job.name === "string" && input.job.name.trim()
          ? input.job.name.trim()
          : input.job.id;
      cronSession.sessionEntry.label = `Automation: ${labelSuffix}`;
    }

    const modelSelectionParams = {
      cfg: runtimeCfg,
      owner: modelOwner,
      agentConfigOverride,
      sessionEntry: cronSession.sessionEntry,
      payload: input.job.payload,
      isGmailHook,
      agentId,
      agentDir,
      workspaceDir: executionWorkspaceDir,
    };
    let resolvedModelSelection = await resolveCronModelSelection(modelSelectionParams);
    const selectionSource = sourceEntry ?? cronSession.initialSessionEntry;
    if (
      resolvedModelSelection.ok &&
      resolvedModelSelection.modelSource !== "payload" &&
      resolvedModelSelection.modelSource !== "hook" &&
      selectionSource &&
      !getSessionExecutionSelection(cronSession.sessionEntry)
    ) {
      const initialSelection = await prepareSessionExecutionSelection({
        cfg: runtimeCfg,
        agentId,
        sessionKey: sourceEntry ? sourceSessionKey : agentSessionKey,
        storePath: cronSession.storePath,
        sessionEntry: selectionSource,
        modelCatalog: modelOwner.modelCatalog.entries,
        request: { kind: "initialize" },
      });
      if (initialSelection.status !== "ready") {
        throw new Error(initialSelection.message);
      }
      commitSessionExecutionSelection(cronSession.sessionEntry, initialSelection.selection, {
        cause: { kind: "initialize", fallbackPermission: initialSelection.fallbackPermission },
      });
      validateInitialSelection = initialSelection.validateCommit;
      resolvedModelSelection = await resolveCronModelSelection(modelSelectionParams);
    }
    if (!resolvedModelSelection.ok) {
      sessionWorkAdmission.release();
      return {
        ok: false,
        result: withRunSession({
          status: "error",
          error: resolvedModelSelection.error,
          diagnostics: createCronRunDiagnosticsFromError(
            "cron-preflight",
            resolvedModelSelection.error,
          ),
        }),
      };
    }
    const cfgWithAgentDefaults = resolvedModelSelection.cfgWithAgentDefaults;
    const ownerAgentConfig = resolveAgentConfig(modelOwner.config, modelOwner.agentId);
    const matchesDefaultFallbackAgentStringModel =
      typeof ownerAgentConfig?.model === "string" &&
      resolveAgentModelPrimaryValue(ownerAgentConfig.model) ===
        resolveAgentModelPrimaryValue(modelOwner.config.agents?.defaults?.model);
    const useSubagentFallbacks = resolvedModelSelection.modelSource === "subagent";
    const inheritDefaultFallbacksForAgentStringModel =
      matchesDefaultFallbackAgentStringModel &&
      (resolvedModelSelection.modelSource === "default" ||
        resolvedModelSelection.modelSource === "agent");

    const storedSelection = getSessionExecutionSelection(cronSession.sessionEntry);
    const nativeManaged =
      resolvedModelSelection.modelSource === "session" &&
      storedSelection?.model === "native-managed";
    const preflight = nativeManaged
      ? undefined
      : await resolveCronPreflight({
          cfg: cfgWithAgentDefaults,
          job: input.job,
          agentId: modelOwner.agentId,
          provider: resolvedModelSelection.provider,
          model: resolvedModelSelection.model,
          sessionEntry: cronSession.sessionEntry,
          useSubagentFallbacks,
          inheritDefaultFallbacksForAgentStringModel,
        });
    if (preflight && !preflight.ok) {
      logWarn(`[cron:${input.job.id}] ${preflight.reason}`);
      sessionWorkAdmission.release();
      return {
        ok: false,
        result: withRunSession({
          status: "skipped",
          error: preflight.reason,
          diagnostics: createCronRunDiagnosticsFromError("model-preflight", preflight.reason, {
            severity: "warn",
          }),
          provider: resolvedModelSelection.provider,
          model: resolvedModelSelection.model,
        }),
      };
    }
    const provider = preflight?.provider ?? resolvedModelSelection.provider;
    const model = preflight?.model ?? resolvedModelSelection.model;
    const modelFallbacksOverride = preflight?.modelFallbacksOverride;
    const runtimePluginCandidates = preflight?.runtimePluginCandidates ?? [];
    const preparedSelection = await prepareSessionExecutionSelection({
      cfg: cfgWithAgentDefaults,
      agentId: modelOwner.agentId,
      sessionKey: agentSessionKey,
      storePath: cronSession.storePath,
      sessionEntry: cronSession.sessionEntry,
      modelCatalog: modelOwner.modelCatalog.entries,
      request: nativeManaged
        ? { kind: "initialize" }
        : {
            kind:
              !cronSession.sessionEntry.executionSelection &&
              resolvedModelSelection.modelSource !== "payload"
                ? "initialize"
                : "model",
            model: { provider, id: model },
          },
    });
    if (preparedSelection.status !== "ready") {
      throw new Error(preparedSelection.message);
    }
    if (isAcpExecutionSelection(preparedSelection.selection)) {
      throw new Error("This automation requires a direct execution selection.");
    }
    const executionSelection = preparedSelection.selection;
    if (!cronSession.sessionEntry.executionSelection) {
      commitSessionExecutionSelection(cronSession.sessionEntry, executionSelection, {
        cause: { kind: "initialize", fallbackPermission: preparedSelection.fallbackPermission },
      });
      validateInitialSelection = preparedSelection.validateCommit;
    }
    const effectiveAgentRuntime = executionSelection.executor.id;
    const thinkingSelection = await resolveCronThinkingSelection({
      cfg: cfgWithAgentDefaults,
      owner: modelOwner,
      agentRuntime: effectiveAgentRuntime,
      provider: nativeManaged ? undefined : provider,
      model: nativeManaged ? undefined : model,
      jobThinking: input.job.payload.kind === "agentTurn" ? input.job.payload.thinking : undefined,
      hookThinking: isGmailHook ? runtimeCfg.hooks?.gmail?.thinking : undefined,
      sessionThinking: cronSession.sessionEntry.thinkingLevel,
    });
    let requestedThinkLevel = thinkingSelection.requestedThinkLevel;
    if (!nativeManaged) {
      const resolvedThinking = resolveThinkingSelection({
        cfg: cfgWithAgentDefaults,
        agentId: modelOwner.agentId,
        provider,
        model,
        level: requestedThinkLevel,
        catalog: thinkingSelection.catalog,
        agentRuntime: effectiveAgentRuntime,
      });
      requestedThinkLevel = resolvedThinking.requestedLevel;
      if (!resolvedThinking.supported && resolvedThinking.level !== requestedThinkLevel) {
        logWarn(
          `[cron:${input.job.id}] Thinking level "${requestedThinkLevel}" is not supported for ${provider}/${model}; using "${resolvedThinking.level}" for this candidate.`,
        );
      }
    }

    preparedModelRuntimeLease = await acquireAgentRunPreparedModelRuntime(
      {
        // Admit the selected runtime before auth/session preparation can publish a replacement.
        // Every later side effect and embedded execution retains this exact derived generation.
        config: cfgWithAgentDefaults,
        agentId,
        agentDir,
        workspaceDir,
        allowGatewaySubagentBinding: true,
        runtimePluginSelections: runtimePluginCandidates.map((candidate) => {
          const runtime = resolveAcceptedSessionRuntimeId(cronSession.sessionEntry);
          return runtime
            ? { provider: candidate.provider, modelId: candidate.model, runtime, agentId }
            : { provider: candidate.provider, modelId: candidate.model, agentId };
        }),
      },
      {
        catalogMode: "static",
        ...(publishedRuntime
          ? { pluginGeneration: publishedRuntime.pluginGeneration }
          : { pluginMetadataSnapshot: modelOwner.metadataSnapshot }),
        abortSignal: input.abortSignal ?? input.signal,
      },
    );

    const explicitTimeoutSeconds =
      input.job.payload.kind === "agentTurn" ? input.job.payload.timeoutSeconds : undefined;
    const timeoutMs = resolveAgentTimeoutMs({
      cfg: cfgWithAgentDefaults,
      overrideSeconds: explicitTimeoutSeconds,
    });
    // Preserve explicit timeout provenance so the idle watchdog does not reapply 120s when defaults match.
    const runTimeoutOverrideMs = resolveCronRunTimeoutOverrideMs(explicitTimeoutSeconds);
    const agentPayload = input.job.payload.kind === "agentTurn" ? input.job.payload : null;
    const configuredProvider = nativeManaged
      ? undefined
      : cfgWithAgentDefaults.models?.providers?.[provider];
    const modelApi = nativeManaged
      ? undefined
      : (findModelInCatalog(thinkingSelection.catalog, provider, model)?.api ??
        configuredProvider?.models?.find((candidate) => candidate.id === model)?.api ??
        configuredProvider?.api);
    const preflightDiagnostics = await createCronToolsAllowPreflightDiagnostics({
      cfg: cfgWithAgentDefaults,
      jobId: input.job.id,
      provider: nativeManaged ? undefined : provider,
      model: nativeManaged ? undefined : model,
      modelApi,
      agentId: modelOwner.agentId,
      agentDir: modelOwner.agentDir,
      workspaceDir: executionWorkspaceDir,
      sessionKey: agentSessionKey,
      agentPayload,
      agentRuntime: effectiveAgentRuntime,
      toolsAllowProvenance: input.job.toolsAllowProvenance,
    });
    const { deliveryPlan, deliveryRequested, resolvedDelivery, sourceDelivery } =
      await resolveCronDeliveryContext({
        cfg: cfgWithAgentDefaults,
        job: input.job,
        agentId,
      });

    const { commandBody, inputProvenance } = await buildCronCommandBody({
      input,
      runtimeCfg,
      agentId,
      baseSessionKey,
      sourceSessionKey,
      sourceEntry,
      storePath: cronSession.storePath,
      now,
      runId: runSessionId,
      runSessionKey,
      hookExternalContentSource,
    });

    const skillsSnapshot =
      input.skillsSnapshot ??
      (await resolveCronSkillsSnapshot({
        workspaceDir: executionWorkspaceDir,
        config: cfgWithAgentDefaults,
        agentId,
        existingSnapshot: cronSession.sessionEntry.skillsSnapshot,
        librarySelections: cronSession.sessionEntry.skillLibrarySelections,
        isFastTestEnv: params.isFastTestEnv,
      }));
    await persistCronSkillsSnapshotIfChanged({
      isFastTestEnv: params.isFastTestEnv,
      cronSession,
      skillsSnapshot,
      nowMs: Date.now(),
      persistSessionEntry,
    });

    markCronSessionPreRun({ entry: cronSession.sessionEntry, provider, model });
    try {
      await persistSessionEntry();
    } catch (err) {
      if (err instanceof CronSessionLifecycleClaimError) {
        throw err;
      }
      logWarn(`[cron:${input.job.id}] Failed to persist pre-run session entry: ${String(err)}`);
      if (sandbox === "required" || cronSession.sessionEntry.sandbox === "required") {
        throw err;
      }
    }
    await retireRolledCronSessionMcpRuntime({
      job: input.job,
      cronSession,
    });
    const authSelection = isModelExecutionSelection(executionSelection)
      ? await resolveCronAuthSelection({
          cfg: cfgWithAgentDefaults,
          provider,
          modelId: model,
          ...(provider === resolvedModelSelection.provider &&
          resolvedModelSelection.configuredProfileId
            ? { configuredProfileId: resolvedModelSelection.configuredProfileId }
            : {}),
          harnessRuntime: effectiveAgentRuntime,
          agentId,
          agentDir,
          cronSession,
          sessionKey: agentSessionKey,
          isNewSession: cronSession.isNewSession && input.job.sessionTarget !== "isolated",
        })
      : undefined;
    const authProfileId = authSelection?.profileId;
    const liveSelection: CronLiveSelection = {
      selection: executionSelection,
      authProfileId,
      authProfileIdSource: authSelection?.source,
    };
    const runContinuationSession = usesExactRunSession
      ? createCronRunContinuationSession({
          cronSession,
          runSessionKey,
          createdActor: input.job.createdActor,
          sandbox,
          thinkingLevel: requestedThinkLevel,
          toolsAllow: agentPayload?.toolsAllow,
          toolsAllowIsDefault: agentPayload?.toolsAllowIsDefault,
          scheduledToolPolicy: resolveCronScheduledToolPolicy({
            toolsAllow: agentPayload?.toolsAllow,
            scheduledToolPolicy: input.job.scheduledToolPolicy,
            owner: input.job.owner,
          }),
          scheduledToolCallerOrigin: input.job.toolsAllowProvenance?.callerOrigin,
          toolsAllowExecTarget: input.job.toolsAllowExecTarget,
          toolsAllowExecTargetRequirement: input.job.toolsAllowExecTargetRequirement,
          cliSessionBindingFacts: {
            sourceReplyDeliveryMode: sourceDelivery.sourceReplyDeliveryMode,
            requireExplicitMessageTarget: sourceDelivery.messageTool.requireExplicitTarget,
          },
          persistSessionEntry: persistCronSessionRow,
        })
      : undefined;
    await runContinuationSession?.initialize();

    return {
      ok: true,
      context: {
        input,
        cfgWithAgentDefaults,
        agentId,
        agentCfg,
        agentDir,
        agentSessionKey,
        sourceSessionKey,
        sourceSessionGeneration,
        runSessionId,
        currentRunSessionId,
        runSessionKey,
        usesDetachedRunSession,
        workspaceDir,
        executionRoot: input.executionRoot,
        commandBody,
        inputProvenance,
        cronSession,
        sessionWorkAdmission,
        persistSessionEntry,
        runContinuationSession,
        withRunSession,
        agentPayload,
        deliveryPlan,
        resolvedDelivery,
        deliveryRequested,
        sourceDelivery,
        suppressExecNotifyOnExit: deliveryPlan.mode === "none",
        skillsSnapshot,
        liveSelection,
        useSubagentFallbacks,
        inheritDefaultFallbacksForAgentStringModel,
        modelFallbacksOverride,
        thinkingSelection,
        timeoutMs,
        preflightDiagnostics,
        runTimeoutOverrideMs,
        preparedModelRuntimeLease,
      },
    };
  } catch (error) {
    try {
      await using _ = preparedModelRuntimeLease;
      throw error;
    } finally {
      sessionWorkAdmission.release();
    }
  }
}
