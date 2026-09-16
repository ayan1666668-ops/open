/** Command handlers for changing ACP runtime mode and config options on live sessions. */
import { isDeepStrictEqual } from "node:util";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { patchSessionEntryWithKey } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  commitSessionExecutionSelection,
  prepareSessionExecutionSelection,
  getSessionExecutionSelection,
} from "../../model-picker/apply-session-model-selection.js";
import {
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
  requireReadySessionMeta,
  requireReadySession,
} from "./manager.utils.js";
import {
  inferRuntimeOptionPatchFromConfigOption,
  mergeRuntimeOptions,
  normalizeRuntimeOptions,
  reconcileAcceptedRuntimeOptions,
  resolveRuntimeConfigOptionKey,
  resolveRuntimeOptionsFromMeta,
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
  const resolvedMeta = requireReadySessionMeta(resolution);
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
    current: resolveRuntimeOptionsFromMeta(meta),
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
  let committed: T | undefined;
  await runSetManagerSessionConfigOption({
    ...params,
    key: "model",
    value: params.selection.model.id,
    commitAccepted: async (selection) => {
      committed = await params.commitAccepted(selection);
    },
  });
  return committed!;
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
  const cached = params.runtimeHandles.get(params);
  if (cached) cached.appliedControlSignature = undefined;
  if (selectingModel)
    await persistManagerRuntimeOptions({
      ...params,
      options: resolveRuntimeOptionsFromMeta(meta),
      expected: before,
      selectionState: "unconfirmed",
    });
  let controlCompleted = false;
  try {
    params.assertActive?.();
    const result = await withAcpRuntimeErrorBoundary({
      run: async () =>
        await runtime.setConfigOption!({ handle, key: wireKey, value: params.value }),
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "Could not update ACP runtime config option.",
    });
    controlCompleted = true;
    const nextOptions = reconcileAcceptedRuntimeOptions(
      mergeRuntimeOptions({ current: resolveRuntimeOptionsFromMeta(meta), patch: inferredPatch }),
      result,
    );
    const accepted: AcpExecutionSelection = {
      ...before.selection,
      model: nextOptions.model ? { id: nextOptions.model } : "native-managed",
    };
    if (selectingModel) {
      params.assertActive?.();
      if (params.commitAccepted) await params.commitAccepted(accepted);
      else
        await commitManagerExecutionSelection({ ...params, expected: before, selection: accepted });
    }
    await persistManagerRuntimeOptions({
      ...params,
      options: nextOptions,
      expected: { ...before, selection: selectingModel ? accepted : before.selection },
      selectionState: selectingModel ? "confirmed" : undefined,
    });
    return nextOptions;
  } catch (error) {
    // Rejection does not prove that an external control has stopped. Fulfillment does.
    if (selectingModel && controlCompleted) {
      const current = params.resolveSession(params);
      if (
        current.kind === "ready" &&
        current.meta.runtimeSessionName === meta.runtimeSessionName &&
        isDeepStrictEqual(current.selection.executor, before.selection.executor) &&
        current.selection.model !== "native-managed"
      ) {
        try {
          params.assertActive?.();
          const restored = await runtime.setConfigOption!({
            handle,
            key: wireKey,
            value: current.selection.model.id,
          });
          const options = reconcileAcceptedRuntimeOptions(
            { ...resolveRuntimeOptionsFromMeta(current.meta), model: current.selection.model.id },
            restored,
          );
          if (options.model === current.selection.model.id)
            await persistManagerRuntimeOptions({
              ...params,
              options,
              expected: current,
              selectionState: "confirmed",
            });
        } catch {
          // Keep the durable pause until both settlement and restoration are confirmed.
        }
      }
    }
    throw error;
  }
}

/** Persists non-model controls; model changes use the same acceptance operation. */
export async function runUpdateManagerSessionRuntimeOptions(
  params: RuntimeOptionCommandContext & { patch: Partial<AcpSessionRuntimeOptions> },
): Promise<AcpSessionRuntimeOptions> {
  if (params.patch.model !== undefined)
    await runSetManagerSessionConfigOption({ ...params, key: "model", value: params.patch.model });
  const { model: _model, ...patch } = params.patch;
  const meta = requireReadySessionMeta(params.resolveSession(params));
  const options = mergeRuntimeOptions({ current: resolveRuntimeOptionsFromMeta(meta), patch });
  await persistManagerRuntimeOptions({ ...params, options });
  return options;
}

export async function runResetManagerSessionRuntimeOptions(
  params: RuntimeOptionCommandContext,
): Promise<AcpSessionRuntimeOptions> {
  const current = requireReadySession(params.resolveSession(params));
  if (current.selection.model !== "native-managed")
    throw new AcpRuntimeError(
      "ACP_BACKEND_UNSUPPORTED_CONTROL",
      "This app cannot restore its default model in the current conversation. Select a model explicitly.",
    );
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
  },
): Promise<void> {
  const { model: _model, ...options } = normalizeRuntimeOptions(params.options);
  const persisted = await params.writeSessionMeta({
    ...params,
    mutate: (current, entry) => {
      if (!current || !entry) return null;
      if (
        params.expected &&
        (entry.sessionId !== params.expected.entry.sessionId ||
          entry.lifecycleRevision !== params.expected.entry.lifecycleRevision ||
          current.runtimeSessionName !== params.expected.meta.runtimeSessionName ||
          !isDeepStrictEqual(requireAcpExecutionSelection(entry), params.expected.selection))
      )
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          "The session changed while its model selection was being applied.",
        );
      const next: SessionAcpLifecycle = {
        ...current,
        runtimeOptions: Object.keys(options).length ? options : undefined,
        cwd: options.cwd,
        lastActivityAt: Date.now(),
      };
      if (params.selectionState === "unconfirmed") {
        next.state = "error";
        next.lastError = ACP_SELECTION_REPAIR_MESSAGE;
      }
      if (params.selectionState === "confirmed") {
        next.state = "idle";
        delete next.lastError;
      }
      return next;
    },
    failOnError: true,
    assertCommitAllowed: params.assertActive,
  });
  if (!persisted?.acp)
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "The session disappeared before its model selection could be committed.",
    );
  const cached = params.runtimeHandles.get(params);
  if (cached) cached.appliedControlSignature = undefined;
}

export async function commitManagerExecutionSelection(
  params: RuntimeOptionCommandContext & {
    expected: ReadySession;
    selection: AcpExecutionSelection;
  },
): Promise<void> {
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
      )
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          "The session changed while its model selection was being applied.",
        );
      const next = { ...entry };
      commitSessionExecutionSelection(next, params.selection, {
        cause: { kind: "inherit", entry },
      });
      return next;
    },
    { replaceEntry: true, assertCommitAllowed: params.assertActive },
  );
  if (!committed)
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "The session disappeared before its model selection could be committed.",
    );
}

/** Resolve a staged request before a prepared turn, without reentering its held actor. */
export async function initializeManagerExecutionSelection(
  params: RuntimeOptionCommandContext,
): Promise<void> {
  const before = requireReadySession(params.resolveSession(params));
  if (getSessionExecutionSelection(before.entry)) return;
  const prepared = await prepareSessionExecutionSelection({
    cfg: params.cfg,
    agentId: params.agentId,
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
  await runWithManagerExecutionSelection({
    ...params,
    selection,
    commitAccepted: async (accepted) =>
      await commitManagerExecutionSelection({ ...params, expected: before, selection: accepted }),
  });
  if (!getSessionExecutionSelection(requireReadySession(params.resolveSession(params)).entry))
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "The model choice changed during preparation. Send the message again.",
    );
}
