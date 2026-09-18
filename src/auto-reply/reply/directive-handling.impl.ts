/** Applies directive-only command state changes without running the agent. */
import { renderExecTargetLabel } from "../../agents/bash-tools.exec-runtime.js";
import { resolveExecDefaults } from "../../agents/exec-defaults.js";
import { formatFastModeValue, resolveFastModeState } from "../../agents/fast-mode.js";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import { resolveEffectiveAgentRuntimeCore } from "../../agents/thinking-runtime.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { adoptPersistedSessionSnapshot } from "../../config/sessions/session-snapshot.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import {
  resolveExecutionSelectionExecutorKind,
  prepareSessionExecutionSelection,
  commitSessionModelSelectionWithAuth,
  formatExecutionSelectionAcknowledgment,
  withPreparedSessionExecutionSelection,
  executionSelectionTransactionChanged,
  resolveSessionExecutionControlFailure,
} from "../../model-picker/apply-session-model-selection.js";
import {
  getCommittedSessionExecutionSelection,
  isAcpExecutionSelection,
  isModelExecutionSelection,
  type ExecutionSelection,
} from "../../model-picker/execution-selection.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
} from "../../sessions/model-overrides.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { readSessionInputProfileId } from "../../sessions/session-participant-input.js";
import {
  formatThinkingLevels,
  isThinkingLevelSupported,
  resolveSupportedThinkingLevel,
} from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import {
  maybeHandleUnexpectedDirectiveArguments,
  resolveInvalidExecDirectiveMessage,
} from "./directive-handling.arguments.js";
import { resolveModelRuntimeDirective } from "./directive-handling.model-runtime.js";
import { resolveModelSelectionFromDirective } from "./directive-handling.model-selection.js";
import { maybeHandleModelDirectiveInfo } from "./directive-handling.model.js";
import type { HandleDirectiveOnlyParams } from "./directive-handling.params.js";
import { maybeHandleQueueDirective } from "./directive-handling.queue-validation.js";
import {
  buildDirectiveAcknowledgmentParts,
  resolveDirectiveStatusResponse,
} from "./directive-handling.responses.js";
import {
  acknowledgeIgnoredSessionDirective,
  applySessionDirectiveFields,
  canPersistSessionDirectiveDefaults,
  type IgnoredSessionDirectiveFlag,
  enqueueModeSwitchEvents,
  persistSessionDirectiveSnapshot,
  rejectSessionDirectiveTransaction,
  resolveDirectiveTouchedSessionFields,
  withOptions,
} from "./directive-handling.shared.js";
import { resolveDirectiveRuntimeContext } from "./directive-runtime-context.js";
import type { ReasoningLevel, ThinkLevel } from "./directives.js";
import { findSelectedCatalogEntry } from "./model-runtime-normalization.js";
import { refreshQueuedFollowupSession } from "./queue.js";

class DirectiveCommitError extends Error {}

/** Handles inline directives that can be acknowledged without a model turn. */
export async function handleDirectiveOnly(
  params: HandleDirectiveOnlyParams,
): Promise<ReplyPayload | undefined> {
  const {
    directives,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    elevatedEnabled,
    elevatedAllowed,
    defaultProvider,
    defaultModel,
    aliasIndex,
    policyAliasIndex,
    allowedModelKeys,
    allowedModelCatalog,
    provider,
    model,
    formatModelSwitchEvent,
    currentThinkLevel,
    currentFastMode,
    currentVerboseLevel,
    currentReasoningLevel,
    currentElevatedLevel,
  } = params;
  const allowPrivilegedPersistence = canPersistSessionDirectiveDefaults(params);
  const rejectModelTransaction = (errorText: string) => {
    params.onRejection?.();
    return rejectSessionDirectiveTransaction(params.persistenceState, errorText);
  };
  const acknowledgeIgnoredDirective = (
    reply: ReplyPayload,
    ignoredDirective: IgnoredSessionDirectiveFlag,
  ) =>
    acknowledgeIgnoredSessionDirective({
      reply,
      directives,
      ignoredDirective,
      persistenceState: params.persistenceState,
      applyRemainingDirectives: (remainingDirectives) =>
        handleDirectiveOnly({ ...params, directives: remainingDirectives }),
    });
  const delegatedTraceAllowed = (params.gatewayClientScopes ?? []).includes("operator.admin");
  if (directives.hasTraceDirective && !params.senderIsOwner && !delegatedTraceAllowed) {
    return acknowledgeIgnoredDirective(
      { text: "❌ /trace is restricted to owners and gateway clients with operator.admin scope." },
      "hasTraceDirective",
    );
  }
  const { activeAgentId, agentDir, runtimePolicySessionKey, runtimeIsSandboxed } =
    resolveDirectiveRuntimeContext(params);
  const shouldHintDirectRuntime = directives.hasElevatedDirective && !runtimeIsSandboxed;
  let thinkingCatalog = params.thinkingCatalog?.length
    ? params.thinkingCatalog
    : allowedModelCatalog.length > 0
      ? allowedModelCatalog
      : undefined;
  const modelInfo = await maybeHandleModelDirectiveInfo({
    directives,
    cfg: params.cfg,
    agentDir,
    activeAgentId,
    provider,
    model,
    defaultProvider,
    defaultModel,
    aliasIndex,
    policyAliasIndex,
    allowedModelKeys,
    allowedModelCatalog,
    currentThinkLevel: currentThinkLevel ?? "off",
    thinkingCatalog,
    runtimePolicySessionKey,
    sessionKey,
    storePath,
    workspaceDir: params.workspaceDir,
    surface: params.surface,
    sessionEntry,
  });
  if (modelInfo) {
    return acknowledgeIgnoredDirective(modelInfo, "hasModelDirective");
  }

  const modelResolution = resolveModelSelectionFromDirective({
    directives,
    cfg: params.cfg,
    agentDir,
    defaultProvider,
    defaultModel,
    aliasIndex,
    allowedModelKeys,
    allowedModelCatalog,
    provider,
    agentId: activeAgentId,
    modelPolicy: params.modelPolicy,
    requesterProfileId: params.ctx ? readSessionInputProfileId(params.ctx) : undefined,
    executionSelection: getCommittedSessionExecutionSelection(sessionEntry),
  });
  if (modelResolution.errorText) {
    return rejectModelTransaction(modelResolution.errorText);
  }
  const { modelSelection, profileOverride } = modelResolution;
  if (modelSelection && isModelSelectionLocked(sessionEntry)) {
    return rejectModelTransaction(MODEL_SELECTION_LOCKED_MESSAGE);
  }

  let resolvedProvider = modelSelection?.provider ?? provider;
  let resolvedModel = modelSelection?.model ?? model;
  const runtimeRequest = resolveModelRuntimeDirective(directives.rawModelRuntime);
  const kind =
    runtimeRequest.kind === "set"
      ? resolveExecutionSelectionExecutorKind(params.cfg, runtimeRequest.runtime)
      : undefined;
  if (runtimeRequest.kind === "set" && !kind) {
    return rejectModelTransaction(
      "Could not confirm support for the selected model. Your selection is unchanged.",
    );
  }
  const executor =
    runtimeRequest.kind === "set" && kind ? { kind, id: runtimeRequest.runtime } : undefined;
  const preparedModel = modelSelection
    ? await prepareSessionExecutionSelection({
        cfg: params.cfg,
        agentId: activeAgentId,
        sessionKey,
        sessionEntry: profileOverride
          ? {
              ...sessionEntry,
              authProfileOverride: profileOverride,
              authProfileOverrideSource: "user",
            }
          : sessionEntry,
        profileProvider: profileOverride ? resolvedProvider : undefined,
        modelCatalog: thinkingCatalog ?? [],
        request: modelSelection.resetToDefault
          ? { kind: "reset", executor }
          : {
              kind: runtimeRequest.kind === "clear" ? "reset" : "model",
              model: { provider: resolvedProvider, id: resolvedModel },
              executor,
            },
      })
    : undefined;
  if (preparedModel && preparedModel.status !== "ready") {
    return rejectModelTransaction(preparedModel.message);
  }
  if (preparedModel && isModelExecutionSelection(preparedModel.selection)) {
    resolvedProvider = preparedModel.selection.model.provider;
    resolvedModel = preparedModel.selection.model.id;
    if (modelSelection) {
      modelSelection.provider = resolvedProvider;
      modelSelection.model = resolvedModel;
    }
  }
  const validateRuntimeSelection = preparedModel?.validateCommit;
  let acceptedSelection = preparedModel?.selection;
  let modelAcknowledgment = preparedModel?.message;
  const acpModelSelection = preparedModel && isAcpExecutionSelection(preparedModel.selection);
  if (preparedModel?.catalogEntry) {
    const selected = preparedModel.catalogEntry;
    thinkingCatalog = [
      selected,
      ...(thinkingCatalog ?? []).filter(
        (entry) => entry.provider !== selected.provider || entry.id !== selected.id,
      ),
    ];
  }
  const selectedCatalogEntry = findSelectedCatalogEntry({
    catalog: thinkingCatalog,
    provider: resolvedProvider,
    model: resolvedModel,
  });
  const thinkingRuntime = preparedModel
    ? isAcpExecutionSelection(preparedModel.selection)
      ? preparedModel.selection.executor.backend
      : preparedModel.selection.executor.id
    : resolveEffectiveAgentRuntimeCore({
        cfg: params.cfg,
        provider: resolvedProvider,
        modelId: resolvedModel,
        modelApi: selectedCatalogEntry?.api,
        modelBaseUrl: selectedCatalogEntry?.baseUrl,
        agentId: activeAgentId,
        sessionKey: runtimePolicySessionKey,
        sessionEntry,
      });
  const thinkingPolicy = {
    provider: resolvedProvider,
    model: resolvedModel,
    catalog: thinkingCatalog,
    agentRuntime: thinkingRuntime,
  };
  const fastModeState = resolveFastModeState({
    cfg: params.cfg,
    provider: resolvedProvider,
    model: resolvedModel,
    agentId: activeAgentId,
    sessionEntry: directives.clearFastMode ? undefined : sessionEntry,
  });
  const effectiveFastMode =
    directives.fastMode ??
    (directives.clearFastMode ? fastModeState.mode : currentFastMode) ??
    fastModeState.mode;

  const statusResponse = resolveDirectiveStatusResponse({
    directives,
    currentThinkLevel,
    currentVerboseLevel,
    currentReasoningLevel,
    currentElevatedLevel,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures: params.elevatedFailures,
    sessionKey,
    thinkingPolicy,
    fastModeState,
    effectiveFastMode,
    currentTraceLevel: sessionEntry.traceLevel,
    runtimeIsSandboxed,
    shouldHintDirectRuntime,
  });
  if (statusResponse) {
    return acknowledgeIgnoredDirective(...statusResponse);
  }
  if (directives.hasExecDirective) {
    const invalidExecMessage = resolveInvalidExecDirectiveMessage(directives);
    if (invalidExecMessage) {
      return acknowledgeIgnoredDirective({ text: invalidExecMessage }, "hasExecDirective");
    }
    const unexpectedExecArguments = maybeHandleUnexpectedDirectiveArguments(directives);
    if (unexpectedExecArguments) {
      params.onRejection?.();
      return unexpectedExecArguments;
    }
    if (!directives.hasExecOptions) {
      const execDefaults = resolveExecDefaults({
        cfg: params.cfg,
        sessionEntry,
        agentId: activeAgentId,
        sandboxAvailable: runtimeIsSandboxed,
      });
      const nodeLabel = execDefaults.node ? `node=${execDefaults.node}` : "node=(unset)";
      return acknowledgeIgnoredDirective(
        {
          text: withOptions(
            `Current exec defaults: host=${renderExecTargetLabel(execDefaults.host)}, effective=${execDefaults.effectiveHost}, security=${execDefaults.security}, ask=${execDefaults.ask}, ${nodeLabel}.`,
            "host=auto|sandbox|gateway|node, security=deny|allowlist|full, ask=off|on-miss|always, node=<id>",
          ),
        },
        "hasExecDirective",
      );
    }
  }

  const queueAck = maybeHandleQueueDirective({
    directives,
    cfg: params.cfg,
    channel: provider,
    sessionEntry,
  });
  if (queueAck) {
    return acknowledgeIgnoredDirective(queueAck, "hasQueueDirective");
  }

  const unexpectedArguments = maybeHandleUnexpectedDirectiveArguments(directives);
  if (unexpectedArguments) {
    params.onRejection?.();
    return unexpectedArguments;
  }

  if (
    directives.hasThinkDirective &&
    directives.thinkLevel &&
    !isThinkingLevelSupported({
      ...thinkingPolicy,
      level: directives.thinkLevel,
    })
  ) {
    return rejectModelTransaction(
      `Thinking level "${directives.thinkLevel}" is not supported for ${resolvedProvider}/${resolvedModel}. Use one of: ${formatThinkingLevels(resolvedProvider, resolvedModel, ", ", thinkingCatalog, thinkingRuntime)}.`,
    );
  }

  // Model changes normalize stored choices; inherited defaults must remain unpinned.
  const nextThinkLevel = sessionEntry.thinkingLevel as ThinkLevel | undefined;
  const remappedUnsupportedThinkLevel =
    !acpModelSelection &&
    nextThinkLevel &&
    (params.persistenceState ? modelSelection : !directives.hasThinkDirective)
      ? resolveSupportedThinkingLevel({
          ...thinkingPolicy,
          level: nextThinkLevel,
        })
      : undefined;
  const shouldRemapUnsupportedThinkLevel =
    Boolean(remappedUnsupportedThinkLevel) && remappedUnsupportedThinkLevel !== nextThinkLevel;

  const prevReasoningLevel =
    currentReasoningLevel ?? (sessionEntry.reasoningLevel as ReasoningLevel | undefined) ?? "off";
  const elevatedChanged =
    directives.hasElevatedDirective &&
    directives.elevatedLevel !== undefined &&
    directives.elevatedLevel !== (currentElevatedLevel ?? sessionEntry.elevatedLevel ?? "off") &&
    elevatedEnabled &&
    elevatedAllowed;
  let modelSelectionUpdated = false;
  let configuredDefaultUpdate: ReturnType<typeof persistStickyModelSelectionBestEffort> | undefined;
  const touchedSessionFields = resolveDirectiveTouchedSessionFields({
    directives,
    allowPrivilegedPersistence,
    directiveOnly: !params.persistenceState,
  });
  if (shouldRemapUnsupportedThinkLevel && !touchedSessionFields.includes("thinkingLevel")) {
    touchedSessionFields.push("thinkingLevel");
  }
  const fastModeChanged =
    (directives.hasFastDirective &&
      directives.fastMode !== undefined &&
      directives.fastMode !== currentFastMode) ||
    (directives.clearFastMode && currentFastMode !== fastModeState.mode);
  const reasoningChanged =
    directives.hasReasoningDirective &&
    directives.reasoningLevel !== undefined &&
    directives.reasoningLevel !== prevReasoningLevel;
  // Validated, authorized directives have already named every field they can mutate.
  if (touchedSessionFields.length > 0) {
    const authProfileError =
      modelResolution.validateAuthProfileSelection?.() ?? validateRuntimeSelection?.();
    if (authProfileError) {
      return rejectModelTransaction(authProfileError);
    }
    const initialSessionEntry = { ...sessionEntry };
    const readCurrentEntry = () =>
      storePath
        ? loadSessionEntryReadOnly({ agentId: activeAgentId, sessionKey, storePath })
        : sessionStore[sessionKey];
    const assertActive = () => {
      const current = readCurrentEntry();
      if (
        !current ||
        current.sessionId !== initialSessionEntry.sessionId ||
        current.lifecycleRevision !== initialSessionEntry.lifecycleRevision
      ) {
        throw new DirectiveCommitError(
          "Model change was not applied because the session changed. Retry.",
        );
      }
      if (modelSelection && isModelSelectionLocked(current)) {
        throw new DirectiveCommitError(MODEL_SELECTION_LOCKED_MESSAGE);
      }
      return current;
    };
    const assertSelectionCurrent = () => {
      const current = assertActive();
      if (executionSelectionTransactionChanged(initialSessionEntry, current)) {
        throw new DirectiveCommitError(
          "Model change was not applied because the session changed. Retry.",
        );
      }
    };
    let directiveFieldsUpdated = false;
    let selectionCommitted = false;
    const commitDirectives = async (
      selection: ExecutionSelection | undefined,
      assertCurrentActor: () => void,
    ): Promise<void> => {
      assertCurrentActor();
      directiveFieldsUpdated =
        !params.persistenceState &&
        applySessionDirectiveFields({
          directives,
          sessionEntry,
          allowPrivilegedPersistence,
          allowElevatedPersistence: elevatedEnabled && elevatedAllowed,
        });
      if (shouldRemapUnsupportedThinkLevel && remappedUnsupportedThinkLevel) {
        sessionEntry.thinkingLevel = remappedUnsupportedThinkLevel;
      }
      if (modelSelection && selection) {
        acceptedSelection = selection;
        if (selection.model !== "native-managed") {
          modelSelection.model = selection.model.id;
          modelSelection.provider = isModelExecutionSelection(selection)
            ? selection.model.provider
            : undefined;
        }
        modelSelectionUpdated = commitSessionModelSelectionWithAuth({
          cfg: params.cfg,
          agentId: activeAgentId,
          entry: sessionEntry,
          currentProvider: provider,
          selection,
          profileOverride,
          markLiveSwitchPending: true,
          cause: { kind: modelSelection.isDefault ? "reset" : "user" },
        }).changed;
      }
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        const persistence = await persistSessionDirectiveSnapshot({
          agentId: activeAgentId,
          storePath,
          sessionKey,
          initialEntry: initialSessionEntry,
          sessionEntry,
          sessionStore,
          hasModelSelection: Boolean(modelSelection),
          reassertLiveModelSwitchPending:
            modelSelectionUpdated && sessionEntry.liveModelSwitchPending === true,
          touchedFields: touchedSessionFields,
          validateCommit: () => {
            assertCurrentActor();
            return modelResolution.validateAuthProfileSelection?.() ?? validateRuntimeSelection?.();
          },
        });
        if (persistence.status !== "applied") {
          const errorText =
            persistence.status === "commit-rejected"
              ? persistence.error
              : persistence.status === "model-selection-locked"
                ? MODEL_SELECTION_LOCKED_MESSAGE
                : modelSelection
                  ? "Model change was not applied because the session changed. Retry."
                  : "Session settings were not applied because the session changed. Retry.";
          throw new DirectiveCommitError(errorText);
        }
      }
      selectionCommitted = true;
    };
    let confirmationNotice: string | undefined;
    try {
      if (preparedModel) {
        await withPreparedSessionExecutionSelection({
          cfg: params.cfg,
          agentId: activeAgentId,
          sessionKey,
          prepared: preparedModel,
          assertActive,
          assertSelectionCurrent,
          commitAccepted: commitDirectives,
        });
      } else {
        await commitDirectives(undefined, assertActive);
      }
    } catch (error) {
      const failure = acpModelSelection
        ? await resolveSessionExecutionControlFailure(error, {
            cfg: params.cfg,
            agentId: activeAgentId,
            sessionKey,
            sessionId: initialSessionEntry.sessionId,
            lifecycleRevision: initialSessionEntry.lifecycleRevision,
            selectionCommitted,
          })
        : undefined;
      if (!selectionCommitted) {
        const current = readCurrentEntry();
        if (current) {
          sessionStore[sessionKey] = current;
          adoptPersistedSessionSnapshot(sessionEntry, current);
        }
      }
      if (selectionCommitted && failure && acceptedSelection && preparedModel) {
        confirmationNotice = failure.confirmationNotice;
      } else if (error instanceof DirectiveCommitError) {
        return rejectModelTransaction(error.message);
      } else if (failure) {
        return rejectModelTransaction(failure.message);
      } else {
        throw error;
      }
    }
    if (preparedModel && acceptedSelection) {
      modelAcknowledgment = formatExecutionSelectionAcknowledgment({
        selection: acceptedSelection,
        before: preparedModel.before,
        reason: preparedModel.reason,
        catalog: thinkingCatalog ?? [],
      });
      if (confirmationNotice) {
        modelAcknowledgment += ` ${confirmationNotice}`;
      }
    }
    if (
      modelSelection &&
      acceptedSelection &&
      isModelExecutionSelection(acceptedSelection) &&
      params.canPersistStickyModelSelection === true &&
      params.stickyModelSelectionTarget
    ) {
      configuredDefaultUpdate = persistStickyModelSelectionBestEffort({
        agentId: activeAgentId,
        model: `${acceptedSelection.model.provider}/${acceptedSelection.model.id}`,
        target: params.stickyModelSelectionTarget,
      });
    }
    // List projections must observe committed settings, not only model selections.
    const sessionSettingsUpdated = directiveFieldsUpdated || shouldRemapUnsupportedThinkLevel;
    if (sessionKey && (sessionSettingsUpdated || modelSelectionUpdated)) {
      emitSessionLifecycleEvent({
        sessionKey,
        agentId: activeAgentId,
        reason: "patch",
        ...(modelSelectionUpdated ? { catalogChanged: true } : {}),
      });
    }
    if (modelSelection && acceptedSelection && modelSelectionUpdated && sessionKey) {
      triggerSessionPatchHook({
        cfg: params.cfg,
        sessionEntry,
        sessionKey,
        patch: {
          key: sessionKey,
          model:
            directives.rawModelDirective ??
            (modelSelection.provider
              ? `${modelSelection.provider}/${modelSelection.model}`
              : modelSelection.model),
        },
      });
      // `/model` should retarget queued/future work without interrupting the
      // active run. Refresh queued followups so they pick up the persisted
      // selection once the current turn finishes.
      refreshQueuedFollowupSession({
        key: sessionKey,
        nextSelection: acceptedSelection,
        nextAuthProfileId: sessionEntry.authProfileOverride,
        nextAuthProfileIdSource: resolveCollapsedSessionAuthPinSource(sessionEntry),
        nextThinking: {
          level: sessionEntry.thinkingLevel,
          catalog: thinkingCatalog,
        },
      });
    }
  }
  if (modelSelection) {
    const nextLabel = modelSelection.provider
      ? `${modelSelection.provider}/${modelSelection.model}`
      : modelSelection.model;
    if (nextLabel !== params.initialModelLabel) {
      enqueueSystemEvent(formatModelSwitchEvent(nextLabel, modelSelection.alias), {
        sessionKey: resolveSystemEventQueueKey(sessionKey, activeAgentId),
        contextKey: `model:${nextLabel}`,
      });
    }
  }
  if (!params.persistenceState) {
    enqueueModeSwitchEvents({
      enqueueSystemEvent,
      sessionEntry,
      sessionKey: resolveSystemEventQueueKey(sessionKey, activeAgentId),
      elevatedChanged,
      reasoningChanged,
    });
  }
  if (params.persistenceState) {
    params.persistenceState.outcome = {
      kind: "applied",
      modelCatalog: thinkingCatalog,
      executionSelection: acceptedSelection,
      sessionExecutionSelection: acceptedSelection
        ? structuredClone(sessionEntry.executionSelection)
        : undefined,
    };
  }

  const parts = buildDirectiveAcknowledgmentParts({
    directives,
    allowPrivilegedPersistence,
    shouldHintDirectRuntime,
    modelSelection: Boolean(modelSelection),
    modelAcknowledgment,
    profileOverride,
    configuredDefaultUpdate,
    stickyModelSelectionTarget: params.stickyModelSelectionTarget,
    shouldRemapUnsupportedThinkLevel,
    remappedUnsupportedThinkLevel,
    nextThinkLevel,
    resolvedProvider,
    resolvedModel,
  });
  if (fastModeChanged && !params.persistenceState) {
    const nextFastMode = directives.clearFastMode ? fastModeState.mode : sessionEntry.fastMode;
    const nextFastModeText =
      nextFastMode === "auto"
        ? "Fast mode set to auto."
        : `Fast mode ${nextFastMode ? "enabled" : "disabled"}.`;
    enqueueSystemEvent(nextFastModeText, {
      sessionKey: resolveSystemEventQueueKey(sessionKey, activeAgentId),
      contextKey: `fast:${formatFastModeValue(nextFastMode)}`,
    });
  }
  const ack = parts.join(" ").trim();
  return !ack && directives.hasStatusDirective ? undefined : { text: ack || "OK." };
}
