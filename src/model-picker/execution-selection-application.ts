import { isDeepStrictEqual } from "node:util";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveContextConfigProviderForRuntime } from "../agents/openai-routing.js";
import { persistStickyModelSelectionBestEffort } from "../agents/sticky-model-selection.js";
import { findSelectedCatalogEntry } from "../auto-reply/reply/model-runtime-normalization.js";
import { resolveContextTokens } from "../auto-reply/reply/model-selection-context.js";
import { refreshQueuedFollowupSession } from "../auto-reply/reply/queue.js";
import { persistReplySessionEntry } from "../auto-reply/reply/session-entry-persistence.js";
import { resolveSupportedThinkingLevel } from "../auto-reply/thinking.js";
import { normalizeThinkLevel } from "../auto-reply/thinking.shared.js";
import { resolveCollapsedSessionAuthPinSource } from "../config/sessions/auth-profile-override-provenance.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import {
  adoptPersistedSessionSnapshot,
  mergeSessionSnapshotChanges,
  sessionModelOverrideChangesApplied,
} from "../config/sessions/session-snapshot-merge.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { triggerSessionPatchHook } from "../gateway/session-patch-hooks.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../sessions/model-overrides.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  prepareSessionExecutionSelection,
  commitSessionExecutionSelection,
  commitSessionModelSelectionWithAuth,
  executionSelectionTransactionChanged,
  SESSION_EXECUTION_CONFIRMATION_PAUSED_MESSAGE,
} from "./apply-session-model-selection.js";
import { formatExecutionSelectionAcknowledgment } from "./execution-selection-presentation.js";
import {
  getCommittedSessionExecutionSelection,
  isAcpExecutionSelection,
  isModelExecutionSelection,
  SESSION_EXECUTION_SELECTION_TRANSACTION_FIELDS,
  type ExecutionSelection,
  type ExecutionSelectionCommitCause,
  type ApplySessionExecutionSelectionResult,
  type ApplySessionExecutionSelectionParams,
  type PreparedSessionExecutionCommitParams,
} from "./execution-selection.js";

class SelectionCommitError extends Error {
  constructor(
    readonly result: Exclude<ApplySessionExecutionSelectionResult, { status: "applied" }>,
  ) {
    super(result.message);
  }
}

/** Keep backend control and the caller's agent-row commit under the same selection custody. */
export async function withPreparedSessionExecutionSelection<T>(
  params: PreparedSessionExecutionCommitParams<T>,
): Promise<T> {
  const assertSelectionCurrent = () => {
    params.assertActive();
    params.assertSelectionCurrent();
    const error = params.prepared.validateCommit();
    if (error)
      throw new SelectionCommitError({ status: "rejected", reason: "not-allowed", message: error });
  };
  assertSelectionCurrent();
  if (isAcpExecutionSelection(params.prepared.selection)) {
    const { getAcpSessionManager } = await import("../acp/control-plane/manager.js");
    return getAcpSessionManager().withExecutionSelection({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      selection: params.prepared.selection,
      assertActive: params.assertActive,
      assertSelectionCurrent,
      commitAccepted: params.commitAccepted,
    });
  }
  return params.commitAccepted(params.prepared.selection);
}

/** Expected backend refusals use the same public wording at every selection entry point. */
export async function resolveSessionExecutionControlFailure(
  error: unknown,
  target: Pick<ApplySessionExecutionSelectionParams, "cfg" | "agentId" | "sessionKey"> &
    Pick<SessionEntry, "sessionId" | "lifecycleRevision"> & { selectionCommitted?: boolean },
): Promise<
  | {
      status: "rejected";
      reason: "unsupported" | "unavailable" | "not-allowed";
      message: string;
      confirmationNotice?: string;
    }
  | undefined
> {
  const { isAcpRuntimeError } = await import("../acp/runtime/errors.js");
  const acpError = isAcpRuntimeError(error) ? error : undefined;
  if (!acpError && !target.selectionCommitted) return undefined;
  let reason: "unsupported" | "unavailable" | "not-allowed";
  let message: string;
  switch (acpError?.code) {
    case "ACP_BACKEND_UNSUPPORTED_CONTROL":
    case "ACP_INVALID_RUNTIME_OPTION":
      reason = "unsupported";
      message =
        "Could not change models. This app cannot change that model setting here. Change the model in the app.";
      break;
    case "ACP_DISPATCH_DISABLED":
      reason = "not-allowed";
      message = "Could not change models. App-based sessions are disabled.";
      break;
    case "ACP_BACKEND_MISSING":
      reason = "unavailable";
      message = "Could not change models. Install or enable the app, then try again.";
      break;
    case "ACP_TURN_FAILED":
      reason = "unavailable";
      message = "The model change could not be confirmed.";
      break;
    default:
      reason = "unavailable";
      message = "Could not change models. Reconnect the app, then try again.";
  }
  const { getAcpSessionManager } = await import("../acp/control-plane/manager.js");
  const { ACP_SELECTION_REPAIR_MESSAGE } = await import("../acp/control-plane/manager.utils.js");
  let current: ReturnType<ReturnType<typeof getAcpSessionManager>["resolveSession"]> | undefined;
  try {
    current = getAcpSessionManager().resolveSession(target);
  } catch {
    // A failed lifecycle read cannot replace the original error or prove the chat is unpaused.
  }
  let confirmationNotice: string | undefined;
  if (
    current?.kind !== "ready" ||
    current.entry.sessionId !== target.sessionId ||
    current.entry.lifecycleRevision !== target.lifecycleRevision
  ) {
    confirmationNotice =
      "The app could not confirm the saved selection. Check the session before continuing.";
  } else if (
    current.meta.state === "error" &&
    current.meta.lastError === ACP_SELECTION_REPAIR_MESSAGE
  ) {
    confirmationNotice = SESSION_EXECUTION_CONFIRMATION_PAUSED_MESSAGE;
  }
  return {
    status: "rejected",
    reason,
    message: confirmationNotice ? `${message} ${confirmationNotice}` : message,
    ...(confirmationNotice ? { confirmationNotice } : {}),
  };
}

/** Apply one request; backend acceptance and the session transaction share this owner. */
export async function applySessionExecutionSelection(
  params: ApplySessionExecutionSelectionParams,
): Promise<ApplySessionExecutionSelectionResult> {
  const { cfg, agentId, sessionKey } = params;
  const storePath =
    params.storePath ??
    (params.sessionStore
      ? undefined
      : resolveSessionStorePathCore(cfg.session?.store, { agentId }));
  const startingStoreEntry = params.sessionStore?.[sessionKey];
  const entry =
    params.sessionEntry ??
    startingStoreEntry ??
    loadSessionEntryReadOnly({ agentId, sessionKey, storePath });
  if (!entry)
    return { status: "conflict", message: "The session changed. Retry the model selection." };
  const initial = structuredClone(entry);
  const before = getCommittedSessionExecutionSelection(initial);
  const initializing = params.request.kind === "initialize";
  if (!initializing && entry.modelSelectionLocked)
    return { status: "rejected", reason: "locked", message: MODEL_SELECTION_LOCKED_MESSAGE };
  if (before && isAcpExecutionSelection(before) && params.profileOverride) {
    return {
      status: "rejected",
      reason: "not-allowed",
      message: "This app owns its account selection. Change accounts in the app.",
    };
  }
  const configured = resolveDefaultModelForAgent({ cfg, agentId });
  const catalog =
    params.thinkingCatalog ??
    params.modelCatalog ??
    (before && !isModelExecutionSelection(before)
      ? []
      : await (
          await import("../agents/prepared-model-catalog.js")
        ).loadPublishedPreparedModelCatalog({ config: cfg, agentId, readOnly: true }));
  const prepared = await prepareSessionExecutionSelection({
    cfg,
    agentId,
    sessionKey,
    storePath,
    modelCatalog: catalog,
    sessionEntry: params.profileOverride
      ? { ...entry, authProfileOverride: params.profileOverride, authProfileOverrideSource: "user" }
      : entry,
    profileProvider:
      params.profileOverride && params.request.kind === "model"
        ? params.request.model.provider
        : undefined,
    request: params.request,
  });
  if (prepared.status !== "ready") return prepared;
  if (
    isModelExecutionSelection(prepared.selection) &&
    params.modelPolicy &&
    !(params.request.kind === "reset" && !params.request.model) &&
    !params.modelPolicy.allows({
      provider: prepared.selection.model.provider,
      model: prepared.selection.model.id,
    })
  ) {
    return {
      status: "rejected",
      reason: "not-allowed",
      message:
        "Could not change models. This model is not available for this agent. Your selection is unchanged.",
    };
  }
  const currentEntry = () =>
    storePath
      ? loadSessionEntryReadOnly({ agentId, sessionKey, storePath })
      : (params.sessionStore?.[sessionKey] ?? entry);
  const conflict = () =>
    new SelectionCommitError({
      status: "conflict",
      message: "Model change was not applied because the session changed. Retry.",
    });
  const assertActive = () => {
    const error = params.validateCommit?.();
    if (error)
      throw new SelectionCommitError({ status: "rejected", reason: "not-allowed", message: error });
    const current = currentEntry();
    if (
      (!current && !params.allowCreate) ||
      (current &&
        (current.sessionId !== initial.sessionId ||
          current.lifecycleRevision !== initial.lifecycleRevision))
    )
      throw conflict();
    if (current?.modelSelectionLocked && (!initializing || !initial.modelSelectionLocked)) {
      throw new SelectionCommitError({
        status: "rejected",
        reason: "locked",
        message: MODEL_SELECTION_LOCKED_MESSAGE,
      });
    }
  };
  const assertCurrent = () => {
    assertActive();
    const error = prepared.validateCommit();
    if (error)
      throw new SelectionCommitError({ status: "rejected", reason: "not-allowed", message: error });
    const current = currentEntry();
    if (
      (current && executionSelectionTransactionChanged(initial, current)) ||
      (!storePath && params.sessionStore && params.sessionStore[sessionKey] !== startingStoreEntry)
    )
      throw conflict();
  };
  let committedResult:
    | Extract<ApplySessionExecutionSelectionResult, { status: "applied" }>
    | undefined;
  const commitAccepted = async (
    selection: ExecutionSelection,
  ): Promise<ApplySessionExecutionSelectionResult> => {
    assertCurrent();
    const next = { ...initial };
    const cause: ExecutionSelectionCommitCause = initializing
      ? { kind: "initialize", fallbackPermission: prepared.fallbackPermission }
      : { kind: params.request.kind === "reset" && !params.request.model ? "reset" : "user" };
    const changedSelection = isAcpExecutionSelection(selection)
      ? commitSessionExecutionSelection(next, selection, {
          cause,
          markLiveSwitchPending: params.markLiveSwitchPending,
        })
      : commitSessionModelSelectionWithAuth({
          cfg,
          agentId,
          entry: next,
          selection,
          cause,
          currentProvider:
            before && isModelExecutionSelection(before)
              ? before.model.provider
              : (params.currentProvider ?? configured.provider),
          profileOverride: params.profileOverride,
          markLiveSwitchPending: params.markLiveSwitchPending,
        });
    const concrete = isModelExecutionSelection(selection) ? selection : undefined;
    const selectedCatalogEntry = concrete
      ? (prepared.catalogEntry ??
        findSelectedCatalogEntry({
          catalog,
          provider: concrete.model.provider,
          model: concrete.model.id,
        }))
      : undefined;
    const thinkingCatalog = selectedCatalogEntry
      ? [
          selectedCatalogEntry,
          ...catalog.filter(
            (row) =>
              row.provider !== selectedCatalogEntry.provider || row.id !== selectedCatalogEntry.id,
          ),
        ]
      : catalog;
    let thinkingRemap: Extract<
      ApplySessionExecutionSelectionResult,
      { status: "applied" }
    >["thinkingRemap"];
    const thinking = normalizeThinkLevel(next.thinkingLevel);
    if (concrete && thinking) {
      const remapped = resolveSupportedThinkingLevel({
        provider: concrete.model.provider,
        model: concrete.model.id,
        level: thinking,
        catalog: [...thinkingCatalog],
        agentRuntime: concrete.executor.id,
      });
      if (remapped !== thinking) {
        next.thinkingLevel = remapped;
        thinkingRemap = {
          from: thinking,
          to: remapped,
          provider: concrete.model.provider,
          model: concrete.model.id,
        };
      }
    }
    next.updatedAt = Date.now();
    let persisted: SessionEntry;
    if (storePath) {
      const persistence = await persistReplySessionEntry({
        storePath,
        sessionKey,
        initialEntry: initial,
        entry: next,
        allowCreate: params.allowCreate,
        requireModelSelectionUnlocked: !initializing,
        reassertLiveModelSwitchPending:
          changedSelection.changed && next.liveModelSwitchPending === true,
        touchedFields: SESSION_EXECUTION_SELECTION_TRANSACTION_FIELDS,
        validateCommit: () => {
          assertCurrent();
          return undefined;
        },
      });
      if (persistence.entry) {
        adoptPersistedSessionSnapshot(entry, persistence.entry);
        if (params.sessionStore) params.sessionStore[sessionKey] = persistence.entry;
      }
      if (persistence.status === "model-selection-locked")
        throw new SelectionCommitError({
          status: "rejected",
          reason: "locked",
          message: MODEL_SELECTION_LOCKED_MESSAGE,
        });
      if (persistence.status === "commit-rejected")
        throw new SelectionCommitError({
          status: "rejected",
          reason: "not-allowed",
          message: persistence.error,
        });
      if (
        persistence.status !== "current" ||
        !sessionModelOverrideChangesApplied({
          initial,
          next,
          current: persistence.entry,
          reassertLiveModelSwitchPending:
            changedSelection.changed && next.liveModelSwitchPending === true,
        })
      ) {
        throw new SelectionCommitError({
          status: "conflict",
          message: "Model change was not applied because the session changed. Retry.",
        });
      }
      persisted = persistence.entry;
    } else {
      persisted = mergeSessionSnapshotChanges({ initial, next, current: currentEntry() ?? entry });
      adoptPersistedSessionSnapshot(entry, persisted);
      if (params.sessionStore) params.sessionStore[sessionKey] = entry;
    }
    const changed = changedSelection.changed || thinkingRemap !== undefined;
    const modelRef = concrete
      ? `${concrete.model.provider}/${concrete.model.id}`
      : selection.model === "native-managed"
        ? null
        : selection.model.id;
    const isConfiguredDefault =
      concrete &&
      concrete.model.provider === configured.provider &&
      concrete.model.id === configured.model;
    const configuredDefaultUpdate =
      concrete &&
      params.canPersistStickyModelSelection &&
      (!isConfiguredDefault || params.stickyModelSelectionTarget)
        ? persistStickyModelSelectionBestEffort({
            agentId,
            model: `${concrete.model.provider}/${concrete.model.id}`,
            target: params.stickyModelSelectionTarget ?? "effective",
          })
        : undefined;
    const message = isDeepStrictEqual(selection, prepared.selection)
      ? prepared.message
      : formatExecutionSelectionAcknowledgment({
          selection,
          before: prepared.before,
          reason: prepared.reason,
          catalog,
        });
    if (changed) {
      emitSessionLifecycleEvent({ sessionKey, agentId, reason: "patch" });
      triggerSessionPatchHook({
        cfg,
        sessionEntry: persisted,
        sessionKey,
        patch: { key: sessionKey, model: params.patchModel ?? modelRef },
      });
      refreshQueuedFollowupSession({
        key: sessionKey,
        nextSelection: selection,
        nextAuthProfileId: persisted.authProfileOverride,
        nextAuthProfileIdSource: resolveCollapsedSessionAuthPinSource(persisted),
        nextThinking: { level: persisted.thinkingLevel, catalog: [...thinkingCatalog] },
      });
      if (!initializing && !isDeepStrictEqual(before, selection))
        enqueueSystemEvent(message, {
          sessionKey,
          contextKey: `model:${modelRef ?? "native-managed"}`,
        });
    }
    committedResult = {
      status: "applied",
      selection,
      message,
      changed,
      before: prepared.before,
      reason: prepared.reason,
      ...(concrete
        ? {
            contextTokens: resolveContextTokens({
              cfg,
              provider: resolveContextConfigProviderForRuntime({
                provider: concrete.model.provider,
                runtimeId: concrete.executor.id,
                config: cfg,
              }),
              model: concrete.model.id,
              modelContextWindow: selectedCatalogEntry?.contextWindow,
              modelContextTokens: selectedCatalogEntry?.contextTokens,
            }),
          }
        : {}),
      ...(configuredDefaultUpdate ? { configuredDefaultUpdate } : {}),
      ...(thinkingRemap ? { thinkingRemap } : {}),
    };
    return committedResult;
  };
  try {
    return await withPreparedSessionExecutionSelection({
      cfg,
      agentId,
      sessionKey,
      prepared,
      assertActive,
      assertSelectionCurrent: assertCurrent,
      commitAccepted,
    });
  } catch (error) {
    if (
      error instanceof SelectionCommitError &&
      (!committedResult || !isAcpExecutionSelection(committedResult.selection))
    )
      return error.result;
    const failure = await resolveSessionExecutionControlFailure(error, {
      cfg,
      agentId,
      sessionKey,
      sessionId: initial.sessionId,
      lifecycleRevision: initial.lifecycleRevision,
      selectionCommitted:
        committedResult !== undefined && isAcpExecutionSelection(committedResult.selection),
    });
    if (failure) {
      const { confirmationNotice, ...refusal } = failure;
      return committedResult
        ? {
            ...committedResult,
            message: confirmationNotice
              ? `${committedResult.message} ${confirmationNotice}`
              : committedResult.message,
          }
        : refusal;
    }
    throw error;
  }
}
