/** Command handlers for changing ACP runtime mode and config options on live sessions. */
import { isDeepStrictEqual } from "node:util";
import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { patchSessionEntryWithKey } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  commitSessionExecutionSelection,
  prepareSessionExecutionSelection,
} from "../../model-picker/apply-session-model-selection.js";
import {
  getSessionExecutionSelection,
  isAcpExecutionSelection,
  type AcpExecutionSelection,
} from "../../model-picker/execution-selection.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
} from "../../sessions/model-overrides.js";
import { AcpRuntimeError, withAcpRuntimeErrorBoundary } from "../runtime/errors.js";
import { resolveSessionStorePathForAcp } from "../runtime/session-meta-store.js";
import { resolveManagerRuntimeCapabilities } from "./manager.runtime-controls.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import type {
  AcpSessionRuntimeOptions,
  EnsureManagerRuntimeHandle,
  ResolveManagerSession,
  WriteManagerSessionMeta,
  SessionAcpLifecycle,
} from "./manager.types.js";
import {
  ACP_SELECTION_REPAIR_MESSAGE,
  createUnsupportedControlError,
  requireAcpExecutionSelection,
  requireReadySession,
} from "./manager.utils.js";
import {
  inferRuntimeOptionPatchFromConfigOption,
  mergeRuntimeOptions,
  normalizeRuntimeOptions,
  reconcileAcceptedRuntimeOptions,
  resolveRuntimeConfigOptionKey,
  resolveRuntimeOptionsFromMeta,
  resolveRuntimeOptionsForSelection,
} from "./runtime-options.js";

/** Manager services required by runtime-option command handlers. */
export type RuntimeOptionCommandServices = {
  runtimeHandles: ManagerRuntimeHandleCache;
  resolveSession: ResolveManagerSession;
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  writeSessionMeta: WriteManagerSessionMeta;
};

type RuntimeOptionCommandContext = RuntimeOptionCommandServices & {
  cfg: OpenClawConfig;
  assertActive?: () => void;
  assertSelectionCurrent?: () => void;
  sessionKey: string;
  agentId: string;
};

/** Applies a backend runtime mode control and persists the selected mode. */
export async function runSetManagerSessionRuntimeMode(
  params: RuntimeOptionCommandContext & { runtimeMode: string },
): Promise<AcpSessionRuntimeOptions> {
  const resolution = params.resolveSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  const { meta: resolvedMeta, selection } = requireReadySession(resolution);
  const { runtime, handle, meta } = await params.ensureRuntimeHandle({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    meta: resolvedMeta,
  });
  const capabilities = await resolveManagerRuntimeCapabilities({ runtime, handle });
  if (!capabilities.controls.includes("session/set_mode") || !runtime.setMode) {
    throw createUnsupportedControlError({
      backend: handle.backend,
      control: "session/set_mode",
    });
  }

  await withAcpRuntimeErrorBoundary({
    run: async () =>
      await runtime.setMode!({
        handle,
        mode: params.runtimeMode,
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not update ACP runtime mode.",
  });

  const nextOptions = mergeRuntimeOptions({
    current: resolveRuntimeOptionsForSelection(meta, selection),
    patch: { runtimeMode: params.runtimeMode },
  });
  await persistManagerRuntimeOptions({
    ...params,
    options: nextOptions,
  });
  return nextOptions;
}

/** Applies an accepted model while the caller retains the session actor through commit. */
export async function runWithManagerExecutionSelection<T>(
  params: RuntimeOptionCommandContext & {
    selection: AcpExecutionSelection;
    commitAccepted: (selection: AcpExecutionSelection) => Promise<T>;
  },
): Promise<T> {
  params.assertActive?.();
  params.assertSelectionCurrent?.();
  const before = requireReadySession(params.resolveSession(params));
  if (!isDeepStrictEqual(before.selection.executor, params.selection.executor)) {
    throw new AcpRuntimeError(
      "ACP_BACKEND_UNSUPPORTED_CONTROL",
      "Changing apps requires a new conversation.",
    );
  }
  if (isDeepStrictEqual(before.selection.model, params.selection.model)) {
    params.assertActive?.();
    return await params.commitAccepted(before.selection);
  }
  if (isModelSelectionLocked(before.entry)) {
    throw new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", MODEL_SELECTION_LOCKED_MESSAGE);
  }
  if (params.selection.model === "native-managed") {
    throw new AcpRuntimeError(
      "ACP_BACKEND_UNSUPPORTED_CONTROL",
      "This app cannot restore its default model in the current conversation. Select a model explicitly.",
    );
  }
  let committed: { value: T } | undefined;
  await runSetManagerSessionConfigOption({
    ...params,
    key: "model",
    value: params.selection.model.id,
    commitAccepted: async (selection) => {
      committed = { value: await params.commitAccepted(selection) };
    },
  });
  return expectDefined(committed, "accepted selection commit result").value;
}

/** Applies a control; model acceptance and accompanying edits commit before actor release. */
export async function runSetManagerSessionConfigOption(
  params: RuntimeOptionCommandContext & {
    key: string;
    value: string;
    commitAccepted?: (selection: AcpExecutionSelection) => Promise<void>;
  },
): Promise<AcpSessionRuntimeOptions> {
  params.assertActive?.();
  const before = requireReadySession(params.resolveSession(params));
  const inferredPatch = inferRuntimeOptionPatchFromConfigOption(params.key, params.value);
  const selectingModel = inferredPatch.model !== undefined;
  if (selectingModel && isModelSelectionLocked(before.entry)) {
    throw new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", MODEL_SELECTION_LOCKED_MESSAGE);
  }
  const { runtime, handle, meta } = await params.ensureRuntimeHandle({
    ...params,
    meta: before.meta,
    preserveActivity: selectingModel,
  });
  const capabilities = await resolveManagerRuntimeCapabilities({
    runtime,
    handle,
    includeStatusConfigOptionKeys: true,
  });
  if (!capabilities.controls.includes("session/set_config_option") || !runtime.setConfigOption) {
    throw createUnsupportedControlError({
      backend: handle.backend,
      control: "session/set_config_option",
    });
  }
  const advertisedKeys = new Set(
    (capabilities.configOptionKeys ?? []).map(normalizeLowercaseStringOrEmpty).filter(Boolean),
  );
  const wireKey = resolveRuntimeConfigOptionKey(params.key, capabilities.configOptionKeys);
  if (advertisedKeys.size && !advertisedKeys.has(normalizeLowercaseStringOrEmpty(wireKey))) {
    throw new AcpRuntimeError(
      "ACP_BACKEND_UNSUPPORTED_CONTROL",
      `ACP backend "${handle.backend}" does not accept config key "${wireKey}".`,
    );
  }
  const expected = { ...before, meta };
  const assertBeforeControl = () => {
    params.assertActive?.();
    params.assertSelectionCurrent?.();
    if (selectingModel) {
      const current = params.resolveSession(params);
      if (
        current.kind !== "ready" ||
        current.entry.sessionId !== before.entry.sessionId ||
        current.entry.lifecycleRevision !== before.entry.lifecycleRevision ||
        current.meta.runtimeSessionName !== meta.runtimeSessionName ||
        !isDeepStrictEqual(current.entry.executionSelection, before.entry.executionSelection)
      ) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          "The session changed before its model control could be submitted.",
        );
      }
    }
  };
  assertBeforeControl();
  const cached = params.runtimeHandles.get(params);
  if (cached) {
    cached.appliedControlSignature = undefined;
  }
  let reservation: SessionAcpLifecycle | undefined;
  let controlStarted = false;
  let controlCompleted = false;
  try {
    if (selectingModel) {
      await persistManagerRuntimeOptions({
        ...params,
        options: resolveRuntimeOptionsFromMeta(meta),
        expected,
        selectionState: "unconfirmed",
        preserveActivity: true,
        onPrepared: (next) => {
          reservation = structuredClone(next);
        },
      });
    }
    assertBeforeControl();
    const result = await withAcpRuntimeErrorBoundary({
      run: async () => {
        controlStarted = true;
        return await runtime.setConfigOption!({ handle, key: wireKey, value: params.value });
      },
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "Could not update ACP runtime config option.",
    });
    controlCompleted = true;
    const nextOptions = reconcileAcceptedRuntimeOptions(
      mergeRuntimeOptions({
        current: resolveRuntimeOptionsForSelection(meta, before.selection),
        patch: inferredPatch,
      }),
      result,
    );
    const accepted: AcpExecutionSelection = {
      ...before.selection,
      model: nextOptions.model ? { id: nextOptions.model } : "native-managed",
    };
    if (selectingModel) {
      params.assertActive?.();
      if (params.commitAccepted) {
        await params.commitAccepted(accepted);
      } else {
        await commitManagerExecutionSelection({ ...params, expected: before, selection: accepted });
      }
    }
    await persistManagerRuntimeOptions({
      ...params,
      options: nextOptions,
      expected: { ...expected, selection: selectingModel ? accepted : before.selection },
      selectionState: selectingModel ? "confirmed" : undefined,
      preserveActivity: selectingModel,
    });
    return nextOptions;
  } catch (error) {
    if (reservation && !controlStarted) {
      try {
        await releaseUnsubmittedModelReservation({
          ...params,
          expected,
          runtime,
          handle,
          reservation,
        });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "The refused model request could not release its reservation.",
          { cause: cleanupError },
        );
      }
    }
    // Rejection does not prove that an external control has stopped. Fulfillment does.
    if (selectingModel && controlCompleted) {
      try {
        const requireRecoveryCustody = () => {
          params.assertActive?.();
          const recoveryHandle = params.runtimeHandles.get(params);
          const current = params.resolveSession(params);
          if (
            recoveryHandle?.runtime !== runtime ||
            recoveryHandle.handle !== handle ||
            current.kind !== "ready" ||
            current.entry.sessionId !== before.entry.sessionId ||
            current.entry.lifecycleRevision !== before.entry.lifecycleRevision ||
            current.meta.runtimeSessionName !== meta.runtimeSessionName ||
            !isDeepStrictEqual(current.selection.executor, before.selection.executor)
          ) {
            throw new AcpRuntimeError(
              "ACP_SESSION_INIT_FAILED",
              "The model control no longer owns this session.",
            );
          }
          return current;
        };
        const current = requireRecoveryCustody();
        if (current.selection.model !== "native-managed") {
          const restored = await runtime.setConfigOption!({
            handle,
            key: wireKey,
            value: current.selection.model.id,
          });
          const options = reconcileAcceptedRuntimeOptions(
            { ...resolveRuntimeOptionsFromMeta(current.meta), model: current.selection.model.id },
            restored,
          );
          if (options.model === current.selection.model.id) {
            await persistManagerRuntimeOptions({
              ...params,
              options,
              expected: current,
              assertActive: () => {
                requireRecoveryCustody();
              },
              selectionState: "confirmed",
              preserveActivity: true,
            });
          }
        }
      } catch {
        // Keep the durable pause and original failure until custody, settlement and restoration are confirmed.
      }
    }
    throw error;
  }
}

/** Persists non-model controls; model changes use the same acceptance operation. */
export async function runUpdateManagerSessionRuntimeOptions(
  params: RuntimeOptionCommandContext & { patch: Partial<AcpSessionRuntimeOptions> },
): Promise<AcpSessionRuntimeOptions> {
  if (params.patch.model !== undefined) {
    await runSetManagerSessionConfigOption({ ...params, key: "model", value: params.patch.model });
  }
  const { model: _model, ...patch } = params.patch;
  const { meta, selection } = requireReadySession(params.resolveSession(params));
  const options = mergeRuntimeOptions({
    current: resolveRuntimeOptionsForSelection(meta, selection),
    patch,
  });
  await persistManagerRuntimeOptions({ ...params, options });
  return options;
}

export async function runResetManagerSessionRuntimeOptions(
  params: RuntimeOptionCommandContext,
): Promise<AcpSessionRuntimeOptions> {
  const current = requireReadySession(params.resolveSession(params));
  if (current.selection.model !== "native-managed") {
    throw new AcpRuntimeError(
      "ACP_BACKEND_UNSUPPORTED_CONTROL",
      "This app cannot restore its default model in the current conversation. Select a model explicitly.",
    );
  }
  const cached = params.runtimeHandles.get(params);
  if (cached) {
    await withAcpRuntimeErrorBoundary({
      run: async () =>
        await cached.runtime.close({ handle: cached.handle, reason: "reset-runtime-options" }),
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "Could not reset ACP runtime options.",
    });
    params.runtimeHandles.clear(params);
  }
  await persistManagerRuntimeOptions({ ...params, options: {} });
  return {};
}

type ReadySession = Extract<ReturnType<ResolveManagerSession>, { kind: "ready" }>;

async function persistManagerRuntimeOptions(
  params: RuntimeOptionCommandContext & {
    options: AcpSessionRuntimeOptions;
    expected?: ReadySession;
    selectionState?: "confirmed" | "unconfirmed";
    preserveActivity?: boolean;
    onPrepared?: (meta: SessionAcpLifecycle) => void;
  },
): Promise<SessionAcpLifecycle> {
  const { model: _model, ...options } = normalizeRuntimeOptions(params.options);
  const persisted = await params.writeSessionMeta({
    ...params,
    mutate: (current, entry) => {
      if (!current || !entry) {
        return null;
      }
      if (
        params.expected &&
        (entry.sessionId !== params.expected.entry.sessionId ||
          entry.lifecycleRevision !== params.expected.entry.lifecycleRevision ||
          current.runtimeSessionName !== params.expected.meta.runtimeSessionName ||
          !isDeepStrictEqual(requireAcpExecutionSelection(entry), params.expected.selection))
      ) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          "The session changed while its model selection was being applied.",
        );
      }
      const next: SessionAcpLifecycle = { ...current, lastActivityAt: Date.now() };
      if (Object.keys(options).length) {
        next.runtimeOptions = options;
      } else {
        delete next.runtimeOptions;
      }
      if (options.cwd) {
        next.cwd = options.cwd;
      } else {
        delete next.cwd;
      }
      if (params.selectionState === "unconfirmed") {
        next.state = "error";
        next.lastError = ACP_SELECTION_REPAIR_MESSAGE;
      }
      if (params.selectionState === "confirmed") {
        next.state = "idle";
        delete next.lastError;
      }
      params.onPrepared?.(next);
      return next;
    },
    failOnError: true,
    assertCommitAllowed: params.assertActive,
  });
  if (!persisted?.acp) {
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "The session disappeared before its model selection could be committed.",
    );
  }
  const cached = params.runtimeHandles.get(params);
  if (cached) {
    cached.appliedControlSignature = undefined;
  }
  return persisted.acp;
}

/** Release only this actor's untouched reservation; this cleanup never selects or controls a model. */
async function releaseUnsubmittedModelReservation(
  params: RuntimeOptionCommandContext & {
    expected: ReadySession;
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    reservation: SessionAcpLifecycle;
  },
): Promise<void> {
  const ownsReservation = () => {
    const cached = params.runtimeHandles.get(params);
    const current = params.resolveSession(params);
    return (
      cached?.runtime === params.runtime &&
      cached.handle === params.handle &&
      current.kind === "ready" &&
      current.entry.sessionId === params.expected.entry.sessionId &&
      current.entry.lifecycleRevision === params.expected.entry.lifecycleRevision &&
      isDeepStrictEqual(current.selection, params.expected.selection) &&
      isDeepStrictEqual(current.meta, params.reservation)
    );
  };
  if (!ownsReservation()) {
    return;
  }
  const assertCustody = () => {
    if (!ownsReservation()) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        "The model reservation no longer belongs to this operation.",
      );
    }
  };
  const released = await params.writeSessionMeta({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    preserveActivity: true,
    failOnError: true,
    assertCommitAllowed: assertCustody,
    mutate: (current, entry) => {
      assertCustody();
      if (!current || !entry || !isDeepStrictEqual(current, params.reservation)) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          "The model reservation changed before cleanup.",
        );
      }
      const next = { ...current, state: params.expected.meta.state };
      if (params.expected.meta.lastError === undefined) {
        delete next.lastError;
      } else {
        next.lastError = params.expected.meta.lastError;
      }
      return next;
    },
  });
  if (!released?.acp) {
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "The model reservation could not be released.",
    );
  }
}

export async function commitManagerExecutionSelection(
  params: RuntimeOptionCommandContext & {
    expected: ReadySession;
    selection: AcpExecutionSelection;
  },
): Promise<ReadySession["entry"]> {
  const target = resolveSessionStorePathForAcp(params);
  const committed = await patchSessionEntryWithKey(
    { agentId: target.agentId, storePath: target.storePath, sessionKey: target.storeSessionKey },
    (entry) => {
      params.assertActive?.();
      if (
        entry.sessionId !== params.expected.entry.sessionId ||
        entry.lifecycleRevision !== params.expected.entry.lifecycleRevision ||
        !isDeepStrictEqual(entry.executionSelection, params.expected.entry.executionSelection) ||
        !isDeepStrictEqual(requireAcpExecutionSelection(entry), params.expected.selection)
      ) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          "The session changed while its model selection was being applied.",
        );
      }
      const next = { ...entry, updatedAt: Date.now() };
      commitSessionExecutionSelection(next, params.selection, {
        cause: { kind: "inherit", entry },
      });
      return next;
    },
    { replaceEntry: true, assertCommitAllowed: params.assertActive },
  );
  if (!committed) {
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "The session disappeared before its model selection could be committed.",
    );
  }
  return committed.entry;
}

/** Resolve a staged request before a prepared turn, without reentering its held actor. */
export async function initializeManagerExecutionSelection(
  params: RuntimeOptionCommandContext,
): Promise<void> {
  const before = requireReadySession(params.resolveSession(params));
  if (getSessionExecutionSelection(before.entry)) {
    return;
  }
  const target = resolveSessionStorePathForAcp(params);
  const prepared = await prepareSessionExecutionSelection({
    cfg: target.cfg,
    agentId: target.agentId,
    sessionKey: target.storeSessionKey,
    storePath: target.storePath,
    sessionEntry: before.entry,
    request: { kind: "initialize" },
  });
  if (prepared.status !== "ready" || !isAcpExecutionSelection(prepared.selection)) {
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      prepared.status === "ready"
        ? "This app cannot apply the pending selection in the current conversation."
        : prepared.message,
    );
  }
  const selection = prepared.selection;
  const assertActive = () => {
    params.assertActive?.();
    const error = prepared.validateCommit();
    if (error) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", error);
    }
  };
  const assertSelectionCurrent = () => {
    params.assertSelectionCurrent?.();
    const current = params.resolveSession(params);
    if (
      current.kind !== "ready" ||
      current.entry.sessionId !== before.entry.sessionId ||
      current.entry.lifecycleRevision !== before.entry.lifecycleRevision ||
      !isDeepStrictEqual(current.entry.executionSelection, before.entry.executionSelection)
    ) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        "The session changed during model preparation.",
      );
    }
  };
  await runWithManagerExecutionSelection({
    ...params,
    assertActive,
    assertSelectionCurrent,
    selection,
    commitAccepted: async (accepted) =>
      await commitManagerExecutionSelection({
        ...params,
        assertActive,
        expected: before,
        selection: accepted,
      }),
  });
  if (!getSessionExecutionSelection(requireReadySession(params.resolveSession(params)).entry)) {
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "The model choice changed during preparation. Send the message again.",
    );
  }
}
