import { isDeepStrictEqual } from "node:util";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { prepareSessionAuthSelection } from "../agents/auth-profiles/session-override.js";
import { resolveModelCandidateChain } from "../agents/model-fallback-candidates.js";
import { evaluatePublishedModelRuntimeChoice } from "../agents/model-runtime-choice.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import { resolveEffectiveAgentRuntimeCore } from "../agents/thinking-runtime.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { resolveSessionWorkerPlacementContext } from "../gateway/session-worker-placement-context.js";
import { resolveWorkerPlacementCapabilities } from "../gateway/worker-environments/placement-capabilities.js";
import { resolveSessionPinnedHarnessId } from "../sessions/agent-harness-session-key.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../sessions/model-overrides.js";
import { resolveStoredModelOverrideCore } from "../sessions/stored-model-overrides.js";
import {
  admitSessionExecutionFallback,
  resolveExecutionSelectionExecutorKind,
  executionSelectionTransactionChanged,
} from "./apply-session-model-selection.js";
import {
  selectionDisplayNames,
  formatExecutionSelectionAcknowledgment,
} from "./execution-selection-presentation.js";
import {
  getCommittedSessionExecutionSelection,
  isAcpExecutionSelection,
  isModelExecutionSelection,
  type ExecutionSelection,
  type ModelExecutionSelection,
  type PreparedSessionExecutionSelection,
  type PrepareSessionExecutionSelectionParams,
} from "./execution-selection.js";

export type CompactionPreparation = {
  selection: ModelExecutionSelection;
  expected: Pick<InternalSessionEntry, "sessionId" | "lifecycleRevision" | "activeWriterRunId">;
};

export async function prepareSelection(
  params: PrepareSessionExecutionSelectionParams,
  compaction?: CompactionPreparation,
): Promise<PreparedSessionExecutionSelection> {
  const sessionSnapshot = params.sessionEntry ? structuredClone(params.sessionEntry) : undefined;
  const configured = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    manifestPlugins: params.manifestPlugins,
  });
  const stored = sessionSnapshot?.executionSelection;
  const deferred = stored?.state === "deferred" ? stored.request : undefined;
  const before = getCommittedSessionExecutionSelection(sessionSnapshot);
  const catalog = params.modelCatalog ?? [];
  const chooseConfigured = (
    model: ModelExecutionSelection["model"],
  ): ModelExecutionSelection | undefined => {
    const entry = catalog.find(
      (candidate) => candidate.provider === model.provider && candidate.id === model.id,
    );
    const id = resolveEffectiveAgentRuntimeCore({
      cfg: params.cfg,
      agentScope: { kind: "prepared", agentId: params.agentId },
      sessionKey: params.sessionKey,
      provider: model.provider,
      modelId: model.id,
      modelApi: entry?.api,
      modelBaseUrl: entry?.baseUrl,
    });
    const kind = resolveExecutionSelectionExecutorKind(params.cfg, id);
    return kind ? { model, executor: { kind, id } } : undefined;
  };
  let parentRead: { sessionKey: string; entry: InternalSessionEntry | undefined } | undefined;
  const loadParent = (sessionKey: string) =>
    loadSessionEntryReadOnly({
      agentId: params.sessionAgentId ?? params.agentId,
      sessionKey,
      storePath: params.storePath,
    });
  const inheritedModel =
    params.request.kind === "initialize" && deferred?.defaultSelection === "inherit"
      ? resolveStoredModelOverrideCore({
          sessionKey: params.sessionKey,
          parentSessionKey: params.parentSessionKey ?? sessionSnapshot?.parentSessionKey,
          defaultProvider: configured.provider,
          loadSessionEntry: (sessionKey) => {
            const entry = loadParent(sessionKey);
            parentRead = { sessionKey, entry: entry ? structuredClone(entry) : undefined };
            return entry;
          },
        })
      : null;
  const fallbackPermission = stored?.legacyRequest
    ? stored.fallbackPermission
    : inheritedModel
      ? parentRead?.entry?.executionSelection?.fallbackPermission
      : undefined;
  const validateParent = () => {
    if (!parentRead) {
      return undefined;
    }
    const current = loadParent(parentRead.sessionKey);
    return current?.sessionId !== parentRead.entry?.sessionId ||
      current?.lifecycleRevision !== parentRead.entry?.lifecycleRevision ||
      executionSelectionTransactionChanged(parentRead.entry ?? {}, current ?? {})
      ? "The parent session selection changed. Retry the turn."
      : undefined;
  };
  const seed =
    deferred?.model && deferred.model !== "native-managed"
      ? { provider: deferred.model.provider ?? configured.provider, id: deferred.model.id }
      : inheritedModel
        ? { provider: inheritedModel.provider ?? configured.provider, id: inheritedModel.model }
        : params.request.kind === "initialize" && params.request.model
          ? params.request.model
          : { provider: configured.provider, id: configured.model };
  const deferredKind = deferred?.runtime
    ? resolveExecutionSelectionExecutorKind(params.cfg, deferred.runtime)
    : undefined;
  const pinned =
    stored?.state === "deferred"
      ? (deferred?.executor ??
        (deferred?.runtime && deferredKind
          ? { kind: deferredKind, id: deferred.runtime }
          : undefined))
      : before?.executor;
  let initial: ExecutionSelection | undefined =
    stored?.state === "accepted"
      ? stored.selection
      : pinned?.kind === "acp"
        ? {
            executor: pinned,
            model:
              deferred?.model === "native-managed" || !deferred?.model
                ? "native-managed"
                : { id: deferred.model.id },
          }
        : pinned?.kind === "harness" && deferred?.model === "native-managed"
          ? { executor: { kind: "harness", id: pinned.id }, model: "native-managed" }
          : pinned
            ? { executor: pinned, model: seed }
            : deferred?.runtime
              ? undefined
              : chooseConfigured(seed);
  if (
    stored?.state === "deferred" &&
    !stored.previous &&
    pinned?.kind === "harness" &&
    params.sessionEntry?.sessionId
  ) {
    const { readSessionRuntimeOwnership } =
      await import("../agents/harness/session-runtime-ownership.js");
    const ownership = readSessionRuntimeOwnership({
      config: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      sessionEntry: params.sessionEntry,
      candidateHarnessId: pinned.id,
    });
    if (ownership?.auth === "native") {
      initial = {
        executor: { kind: "harness", id: pinned.id },
        model: "native-managed",
      };
    } else if (ownership?.modelRef) {
      initial = {
        executor: pinned,
        model: { provider: ownership.modelRef.provider, id: ownership.modelRef.model },
      };
    }
  }
  let selection: ExecutionSelection | undefined;
  let reason: Extract<PreparedSessionExecutionSelection, { status: "ready" }>["reason"];
  if (params.request.kind === "initialize") {
    selection = initial;
    reason = "initialized";
  } else if (params.request.kind === "selection" || params.request.kind === "fallback") {
    selection = params.request.selection;
    reason = params.request.kind === "fallback" ? "model" : "explicit";
  } else if (params.request.kind === "reset") {
    const resetModel = params.request.model
      ? params.request.model.provider
        ? { provider: params.request.model.provider, id: params.request.model.id }
        : undefined
      : { provider: configured.provider, id: configured.model };
    selection =
      initial && isAcpExecutionSelection(initial)
        ? {
            ...initial,
            model: params.request.model ? { id: params.request.model.id } : "native-managed",
          }
        : resetModel
          ? params.request.executor
            ? { model: resetModel, executor: params.request.executor }
            : chooseConfigured(resetModel)
          : undefined;
    reason = "reset";
  } else {
    const requestedModel = params.request.model.provider
      ? { provider: params.request.model.provider, id: params.request.model.id }
      : undefined;
    selection =
      initial && isAcpExecutionSelection(initial)
        ? { ...initial, model: { id: params.request.model.id } }
        : requestedModel
          ? params.request.executor
            ? { model: requestedModel, executor: params.request.executor }
            : before || pinned || deferred?.runtime
              ? initial
                ? { model: requestedModel, executor: initial.executor }
                : undefined
              : chooseConfigured(requestedModel)
          : undefined;
    reason = params.request.executor ? "explicit" : before ? "model" : "initialized";
  }
  const unknown = (message?: string): PreparedSessionExecutionSelection => ({
    status: "rejected",
    reason: "unknown",
    message:
      message ??
      `Could not confirm support for ${selection ? selectionDisplayNames(selection, catalog).model : "the selected model"}. Your selection is unchanged.`,
  });
  if (!selection) {
    return unknown();
  }
  const acpOwner =
    before && isAcpExecutionSelection(before)
      ? before
      : initial && isAcpExecutionSelection(initial)
        ? initial
        : undefined;
  if (
    acpOwner &&
    (((params.request.kind === "model" || params.request.kind === "reset") &&
      params.request.executor) ||
      !isDeepStrictEqual(acpOwner.executor, selection.executor))
  ) {
    return {
      status: "rejected",
      reason: "unsupported",
      message: "Changing apps requires a new conversation.",
    };
  }
  const lockedSelection =
    before ??
    (pinned || (deferred?.model && deferred.model !== "native-managed") ? initial : undefined);
  if (params.sessionEntry?.modelSelectionLocked && !isDeepStrictEqual(lockedSelection, selection)) {
    return { status: "rejected", reason: "locked", message: MODEL_SELECTION_LOCKED_MESSAGE };
  }
  const fallbackRequest = params.request.kind === "fallback" ? params.request : undefined;
  let explicitFallbackModels: ModelExecutionSelection["model"][] | undefined;
  if (fallbackRequest?.explicitModels !== undefined) {
    const primary =
      fallbackRequest.userSelection ??
      (before && isModelExecutionSelection(before) ? before : fallbackRequest.selection);
    explicitFallbackModels = resolveModelCandidateChain({
      cfg: params.cfg,
      agentId: params.agentId,
      provider: primary.model.provider,
      model: primary.model.id,
      requestedRouteResolution: "resolved",
      fallbacksOverride: fallbackRequest.explicitModels,
    }).map(({ provider, model }) => ({ provider, id: model }));
  }
  const readCurrentEntry = () =>
    params.readSessionEntry
      ? params.readSessionEntry()
      : params.sessionKey
        ? loadSessionEntryReadOnly({
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
          })
        : params.sessionEntry;
  const validateFallback = (current: Partial<InternalSessionEntry> | undefined) => {
    if (!fallbackRequest && !compaction) {
      return undefined;
    }
    const expected = compaction?.expected ?? sessionSnapshot;
    if (
      sessionSnapshot &&
      (!current ||
        current.sessionId !== expected?.sessionId ||
        current.lifecycleRevision !== expected?.lifecycleRevision ||
        executionSelectionTransactionChanged(sessionSnapshot, current) ||
        (compaction &&
          (current.activeWriterRunId !== expected?.activeWriterRunId ||
            current.modelSelectionLocked !== sessionSnapshot.modelSelectionLocked ||
            current.pluginOwnerId !== sessionSnapshot.pluginOwnerId ||
            resolveSessionPinnedHarnessId(current) !==
              resolveSessionPinnedHarnessId(sessionSnapshot))))
    ) {
      return "The session selection changed. Retry the turn.";
    }
    if (!fallbackRequest) {
      return undefined;
    }
    const admitted = admitSessionExecutionFallback({
      entry: current,
      candidate: fallbackRequest.selection,
      explicitModels: explicitFallbackModels,
      userSelection: fallbackRequest.userSelection,
    });
    return admitted.status === "rejected"
      ? "This session does not permit that model fallback."
      : undefined;
  };
  const fallbackError = validateFallback(
    fallbackRequest || compaction ? readCurrentEntry() : undefined,
  );
  if (fallbackError) {
    return { status: "rejected", reason: "not-allowed", message: fallbackError };
  }
  const validatePlacement = (candidate: ExecutionSelection) =>
    resolveActivePlacementModelSelectionError({
      sessionId: params.sessionEntry?.sessionId,
      selection: candidate,
    });
  const placementError = validatePlacement(selection);
  if (placementError) {
    return { status: "rejected", reason: "not-allowed", message: placementError };
  }
  if (isModelExecutionSelection(selection)) {
    const policy = createModelVisibilityPolicy({
      cfg: params.cfg,
      agentId: params.agentId,
      catalog: [...catalog],
      defaultProvider: configured.provider,
      defaultModel: configured,
      // Policy refs are authored input; the accepted model identity below is already resolved.
      allowManifestNormalization: true,
      allowPluginNormalization: params.cfg.plugins?.enabled !== false,
      manifestPlugins: params.manifestPlugins,
    });
    const modelRef = { provider: selection.model.provider, model: selection.model.id };
    const retainedInitialModel =
      params.request.kind === "initialize" &&
      isDeepStrictEqual(
        policy.resolveSelection({ ...modelRef, routeResolution: "resolved" }),
        modelRef,
      );
    if (
      !params.sessionEntry?.modelSelectionLocked &&
      !(params.request.kind === "reset" && !params.request.model) &&
      !(
        params.request.kind === "initialize" &&
        (fallbackPermission ?? stored?.fallbackPermission) !== "explicit"
      ) &&
      params.request.kind !== "fallback" &&
      !policy.allows(modelRef) &&
      !retainedInitialModel
    ) {
      return {
        status: "rejected",
        reason: "not-allowed",
        message:
          "Could not change models. This model is not available for this agent. Your selection is unchanged.",
      };
    }
    const evaluate = async (pair: ModelExecutionSelection) => {
      const auth = params.replyAuth
        ? await prepareSessionAuthSelection({
            ...params.replyAuth,
            cfg: params.cfg,
            agentId: params.agentId,
            agentDir: resolveAgentDir(params.cfg, params.agentId),
            provider: pair.model.provider,
            modelId: pair.model.id,
            harnessRuntime: pair.executor.id,
            sessionEntry: params.sessionEntry,
            sessionKey: params.sessionKey,
          })
        : undefined;
      const result = await evaluatePublishedModelRuntimeChoice({
        cfg: params.cfg,
        agentId: params.agentId,
        workspaceDir: params.workspaceDir ?? params.sessionEntry?.spawnedWorkspaceDir,
        provider: pair.model.provider,
        model: pair.model.id,
        runtimeId: pair.executor.id,
        sessionEntry: auth
          ? {
              ...sessionSnapshot,
              ...auth.state,
              ...(auth.selection
                ? {
                    authProfileOverride: auth.selection.profileId,
                    authProfileOverrideSource: auth.selection.source,
                  }
                : {}),
            }
          : sessionSnapshot,
        profileProvider: params.profileProvider,
        materialize: params.modelInput
          ? params.request.kind === "initialize"
            ? "automatic"
            : "override"
          : undefined,
      });
      const accountError = auth?.validate(compaction ? readCurrentEntry() : params.sessionEntry);
      if (accountError) {
        return { kind: "forbidden" as const, message: accountError, auth };
      }
      return { ...result, auth };
    };
    let evaluation = await evaluate(selection);
    let validateCompactionSource:
      | ((current: Partial<InternalSessionEntry> | undefined) => string | undefined)
      | undefined;
    if (
      compaction &&
      evaluation.kind === "unsupported" &&
      evaluation.fallback?.runtime === "openclaw" &&
      !resolveSessionPinnedHarnessId(sessionSnapshot)
    ) {
      const source = evaluation;
      const fallback = evaluation.fallback;
      const candidate: ModelExecutionSelection = {
        model: compaction.selection.model,
        executor: { kind: "harness", id: "openclaw" },
      };
      const alternative = await evaluate(candidate);
      if (alternative.kind === "ready") {
        if (source.auth?.selection?.profileId !== alternative.auth?.selection?.profileId) {
          return {
            status: "rejected",
            reason: "not-allowed",
            message: "Compaction cannot change this conversation's account.",
          };
        }
        validateCompactionSource = (current) =>
          fallback.validate() ?? source.auth?.validate(current);
        selection = candidate;
        evaluation = alternative;
        reason = "unsupported";
      }
    }
    if (
      evaluation.kind === "unsupported" &&
      ((params.request.kind === "model" && !params.request.executor) ||
        params.request.kind === "fallback" ||
        (params.request.kind === "initialize" &&
          stored?.state === "deferred" &&
          pinned !== undefined))
    ) {
      const alternative = chooseConfigured(selection.model);
      if (alternative && alternative.executor.id !== selection.executor.id) {
        const candidate = await evaluate(alternative);
        if (candidate.kind === "ready") {
          selection = alternative;
          evaluation = candidate;
          reason = "unsupported";
        }
      }
    }
    if (evaluation.kind === "ready" && evaluation.ref) {
      selection = {
        ...selection,
        model: { provider: evaluation.ref.provider, id: evaluation.ref.model },
      };
    }
    if (compaction && !isDeepStrictEqual(selection.model, compaction.selection.model)) {
      return {
        status: "rejected",
        reason: "not-allowed",
        message: "Compaction cannot change this conversation's model.",
      };
    }
    if (
      params.modelInput &&
      params.request.kind === "initialize" &&
      !before &&
      evaluation.kind !== "ready" &&
      evaluation.kind !== "forbidden"
    ) {
      let usable:
        | Extract<Awaited<ReturnType<typeof evaluate>>, { kind: "ready" | "pending" }>
        | undefined = evaluation.kind === "pending" ? evaluation : undefined;
      if (!usable) {
        const candidates = resolveModelCandidateChain({
          cfg: params.cfg,
          agentId: params.agentId,
          provider: selection.model.provider,
          model: selection.model.id,
          requestedRouteResolution: "resolved",
          allowPluginNormalization: true,
          manifestPlugins: params.manifestPlugins,
          fallbacksOverride: params.modelInput.fallbacks ?? [],
        }).slice(1);
        for (const candidate of candidates) {
          const pair = chooseConfigured({ provider: candidate.provider, id: candidate.model });
          if (!pair) {
            continue;
          }
          const supported = await evaluate(pair);
          if (supported.kind === "ready" || supported.kind === "pending") {
            usable = supported;
            break;
          }
        }
      }
      if (usable) {
        const support = usable;
        const validateCommit = () => support.validate() ?? validateParent();
        const error = validateCommit();
        if (error) {
          return { status: "rejected", reason: "unavailable", message: error };
        }
        return {
          status: "deferred",
          reason: evaluation.kind === "unavailable" ? "unavailable" : "unknown",
          message: "The configured model will be prepared when this session starts.",
          selection: {
            state: "deferred",
            request: { model: selection.model },
            fallbackPermission: "configured",
            ...(stored?.legacyRequest ? { legacyRequest: stored.legacyRequest } : {}),
          },
          validateCommit,
        };
      }
    }
    if (evaluation.kind === "pending") {
      return unknown();
    }
    if (params.modelInput && evaluation.kind !== "ready") {
      return {
        status: "rejected",
        reason: evaluation.kind === "forbidden" ? "not-allowed" : evaluation.kind,
        message: evaluation.message,
      };
    }
    if (evaluation.kind === "ready" && params.modelInput?.requiresTools && evaluation.model) {
      const { supportsModelTools } = await import("../agents/model-tool-support.js");
      if (!supportsModelTools(evaluation.model)) {
        return {
          status: "rejected",
          reason: "unsupported",
          message:
            'sessions_spawn outputSchema requires a tool-capable target model; "' +
            selection.model.provider +
            "/" +
            selection.model.id +
            '" declares compat.supportsTools=false.',
        };
      }
    }
    if (
      params.sessionEntry?.modelSelectionLocked &&
      !isDeepStrictEqual(lockedSelection, selection) &&
      !validateCompactionSource
    ) {
      return { status: "rejected", reason: "locked", message: MODEL_SELECTION_LOCKED_MESSAGE };
    }
    if (evaluation.kind === "unknown") {
      return unknown(evaluation.message);
    }
    if (evaluation.kind === "forbidden") {
      return { status: "rejected", reason: "not-allowed", message: evaluation.message };
    }
    if (evaluation.kind === "unsupported") {
      const labels = selectionDisplayNames(selection, catalog);
      return {
        status: "rejected",
        reason: "unsupported",
        message: `${labels.app} cannot run ${labels.model}. Choose another model or app.`,
      };
    }
    if (evaluation.kind === "unavailable" && params.request.kind !== "reset") {
      return {
        status: "rejected",
        reason: "unavailable",
        message: `Could not change models. Sign in to ${selectionDisplayNames(selection, catalog).app}, then try again.`,
      };
    }
    let message = formatExecutionSelectionAcknowledgment({
      selection,
      before: initial,
      reason,
      catalog: evaluation.kind === "ready" ? [evaluation.entry, ...catalog] : catalog,
    });
    if (evaluation.kind === "unavailable") {
      message += ` Sign in to ${selectionDisplayNames(selection, catalog).app}, then try again.`;
    }
    const accepted = selection;
    const validateCommit = () => {
      const current = fallbackRequest || compaction ? readCurrentEntry() : params.sessionEntry;
      return (
        validateCompactionSource?.(current) ??
        evaluation.auth?.validate(current) ??
        evaluation.validate() ??
        validateFallback(current) ??
        validateParent() ??
        validatePlacement(accepted)
      );
    };
    const commitError = validateCommit();
    if (commitError) {
      return { status: "rejected", reason: "not-allowed", message: commitError };
    }
    return {
      status: "ready",
      selection,
      before,
      reason,
      message,
      catalogEntry: evaluation.kind === "ready" ? evaluation.entry : undefined,
      auth: evaluation.auth,
      fallbackPermission,
      validateCommit,
    };
  }
  let validateNative: (() => string | undefined) | undefined;
  if (!isAcpExecutionSelection(selection)) {
    const { readSessionRuntimeOwnership } =
      await import("../agents/harness/session-runtime-ownership.js");
    const candidateHarnessId = selection.executor.id;
    validateNative = () =>
      readSessionRuntimeOwnership({
        config: params.cfg,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        sessionEntry: params.sessionEntry,
        candidateHarnessId,
      })?.auth === "native"
        ? undefined
        : "Could not confirm this app's session ownership. Your selection is unchanged.";
    const error = validateNative();
    if (error) {
      return { status: "rejected", reason: "unknown", message: error };
    }
  }
  const accepted = selection;
  return {
    status: "ready",
    selection,
    before,
    reason,
    fallbackPermission,
    validateCommit: () => validateNative?.() ?? validateParent() ?? validatePlacement(accepted),
    message: formatExecutionSelectionAcknowledgment({
      selection,
      before: initial,
      reason,
      catalog,
    }),
  };
}

/**
 * Rejects a model selection when the candidate runtime is incompatible with an
 * active cloud-worker placement. Mirrors the sessions.patch guard so directive
 * model changes are validated before they persist.
 */
function resolveActivePlacementModelSelectionError(params: {
  sessionId?: string;
  selection: ExecutionSelection;
}): string | undefined {
  const sessionId = params.sessionId;
  if (!sessionId) {
    return undefined;
  }
  const placementService = resolveSessionWorkerPlacementContext().workerSessionPlacementService;
  const placement = placementService?.getMany([sessionId]).get(sessionId);
  if (!placement || placement.state === "local") {
    return undefined;
  }
  const executor = params.selection.executor;
  const { executionMode } = resolveWorkerPlacementCapabilities(
    executor.kind === "acp" ? executor.backend : executor.id,
  );
  if (executionMode === placement.executionMode) {
    return undefined;
  }
  return executionMode
    ? `Session cannot change cloud placement execution mode while placement is ${placement.state}.`
    : `Session cannot select a runtime without cloud placement support while cloud worker placement is ${placement.state}.`;
}
