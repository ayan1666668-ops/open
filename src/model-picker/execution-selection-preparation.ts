import { isDeepStrictEqual } from "node:util";
import { resolveModelCandidateChain } from "../agents/model-fallback-candidates.js";
import { evaluatePublishedModelRuntimeChoice } from "../agents/model-runtime-choice.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { resolveSessionWorkerPlacementContext } from "../gateway/session-worker-placement-context.js";
import { resolveWorkerPlacementCapabilities } from "../gateway/worker-environments/placement-capabilities.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../sessions/model-overrides.js";
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

/** Prepare one accepted pair or one turn-local pair; persistence is an explicit later operation. */
export async function prepareSessionExecutionSelection(
  params: PrepareSessionExecutionSelectionParams,
): Promise<PreparedSessionExecutionSelection> {
  const sessionSnapshot = params.sessionEntry ? { ...params.sessionEntry } : undefined;
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
      (entry) => entry.provider === model.provider && entry.id === model.id,
    );
    const id = resolveEffectiveAgentRuntime({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      provider: model.provider,
      modelId: model.id,
      modelApi: entry?.api,
      modelBaseUrl: entry?.baseUrl,
    });
    const kind = resolveExecutionSelectionExecutorKind(params.cfg, id);
    return kind ? { model, executor: { kind, id } } : undefined;
  };
  const seed =
    deferred?.model && deferred.model !== "native-managed"
      ? { provider: deferred.model.provider ?? configured.provider, id: deferred.model.id }
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
    selection =
      initial && isAcpExecutionSelection(initial)
        ? {
            ...initial,
            model: params.request.model ? { id: params.request.model.id } : "native-managed",
          }
        : params.request.model
          ? params.request.model.provider
            ? chooseConfigured({
                provider: params.request.model.provider,
                id: params.request.model.id,
              })
            : undefined
          : chooseConfigured({ provider: configured.provider, id: configured.model });
    reason = "reset";
  } else {
    if (initial && isAcpExecutionSelection(initial) && params.request.executor) {
      return {
        status: "rejected",
        reason: "unsupported",
        message: "Changing apps requires a new conversation.",
      };
    }
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
  const unknown = (): PreparedSessionExecutionSelection => ({
    status: "rejected",
    reason: "unknown",
    message: `Could not confirm support for ${selection ? selectionDisplayNames(selection, catalog).model : "the selected model"}. Your selection is unchanged.`,
  });
  if (!selection) {
    return unknown();
  }
  const lockedSelection = before ?? (pinned ? initial : undefined);
  if (params.sessionEntry?.modelSelectionLocked && !isDeepStrictEqual(lockedSelection, selection)) {
    return { status: "rejected", reason: "locked", message: MODEL_SELECTION_LOCKED_MESSAGE };
  }
  const fallbackRequest = params.request.kind === "fallback" ? params.request : undefined;
  const explicitFallbackModels =
    fallbackRequest?.explicitModels === undefined
      ? undefined
      : resolveModelCandidateChain({
          cfg: params.cfg,
          agentId: params.agentId,
          provider:
            before && isModelExecutionSelection(before)
              ? before.model.provider
              : fallbackRequest.selection.model.provider,
          model:
            before && isModelExecutionSelection(before)
              ? before.model.id
              : fallbackRequest.selection.model.id,
          requestedRouteResolution: "resolved",
          fallbacksOverride: fallbackRequest.explicitModels,
        }).map(({ provider, model }) => ({ provider, id: model }));
  const validateFallback = () => {
    if (!fallbackRequest) return undefined;
    const current = params.readSessionEntry
      ? params.readSessionEntry()
      : params.sessionKey
        ? loadSessionEntryReadOnly({
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
          })
        : params.sessionEntry;
    if (
      sessionSnapshot &&
      (!current ||
        current.sessionId !== sessionSnapshot.sessionId ||
        current.lifecycleRevision !== sessionSnapshot.lifecycleRevision ||
        executionSelectionTransactionChanged(sessionSnapshot, current))
    ) {
      return "The session selection changed. Retry the turn.";
    }
    const admitted = admitSessionExecutionFallback({
      entry: current,
      candidate: fallbackRequest.selection,
      explicitModels: explicitFallbackModels,
    });
    return admitted.status === "rejected"
      ? "This session does not permit that model fallback."
      : undefined;
  };
  const fallbackError = validateFallback();
  if (fallbackError) return { status: "rejected", reason: "not-allowed", message: fallbackError };
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
      defaultModel: configured.model,
    });
    if (
      !(params.request.kind === "reset" && !params.request.model) &&
      params.request.kind !== "initialize" &&
      params.request.kind !== "fallback" &&
      !policy.allows({ provider: selection.model.provider, model: selection.model.id })
    ) {
      return {
        status: "rejected",
        reason: "not-allowed",
        message:
          "Could not change models. This model is not available for this agent. Your selection is unchanged.",
      };
    }
    const evaluate = (pair: ModelExecutionSelection) =>
      evaluatePublishedModelRuntimeChoice({
        cfg: params.cfg,
        agentId: params.agentId,
        workspaceDir: params.sessionEntry?.spawnedWorkspaceDir,
        provider: pair.model.provider,
        model: pair.model.id,
        runtimeId: pair.executor.id,
        sessionEntry: sessionSnapshot,
        profileProvider: params.profileProvider,
      });
    let evaluation = await evaluate(selection);
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
    if (
      params.sessionEntry?.modelSelectionLocked &&
      !isDeepStrictEqual(lockedSelection, selection)
    ) {
      return { status: "rejected", reason: "locked", message: MODEL_SELECTION_LOCKED_MESSAGE };
    }
    const labels = selectionDisplayNames(
      selection,
      evaluation.kind === "ready" ? [evaluation.entry, ...catalog] : catalog,
    );
    if (evaluation.kind === "unknown") {
      return unknown();
    }
    if (evaluation.kind === "forbidden") {
      return { status: "rejected", reason: "not-allowed", message: evaluation.message };
    }
    if (evaluation.kind === "unsupported") {
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
        message: `Could not change models. Sign in to ${labels.app}, then try again.`,
      };
    }
    let message = formatExecutionSelectionAcknowledgment({
      selection,
      before: initial,
      reason,
      catalog: evaluation.kind === "ready" ? [evaluation.entry, ...catalog] : catalog,
    });
    if (evaluation.kind === "unavailable") {
      message += ` Sign in to ${labels.app}, then try again.`;
    }
    const accepted = selection;
    const validateCommit = () =>
      (evaluation.kind === "ready" ? evaluation.validate() : undefined) ??
      validateFallback() ??
      validatePlacement(accepted);
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
    if (error) return { status: "rejected", reason: "unknown", message: error };
  }
  const accepted = selection;
  return {
    status: "ready",
    selection,
    before,
    reason,
    validateCommit: () => validateNative?.() ?? validatePlacement(accepted),
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
