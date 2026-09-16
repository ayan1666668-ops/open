/** Command handlers for changing ACP runtime mode and config options on live sessions. */
import { isDeepStrictEqual } from "node:util";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { commitAcpExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
import type { AcpExecutionSelection } from "../../model-picker/execution-selection.js";
import { AcpRuntimeError, withAcpRuntimeErrorBoundary } from "../runtime/errors.js";
import { resolveManagerRuntimeCapabilities } from "./manager.runtime-controls.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import type {
  AcpSessionRuntimeOptions,
  EnsureManagerRuntimeHandle,
  ResolveManagerSession,
  WriteManagerSessionMeta,
  SessionAcpMeta,
} from "./manager.types.js";
import {
  ACP_SELECTION_REPAIR_MESSAGE,
  createUnsupportedControlError,
  requireAcpExecutionSelection,
  requireReadySessionMeta,
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
      backend: handle.backend || requireAcpExecutionSelection(meta).executor.backend,
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

/** Applies a backend config-option control and persists the inferred runtime option patch. */
export async function runSetManagerSessionConfigOption(
  params: RuntimeOptionCommandContext & {
    key: string;
    value: string;
    assertActive?: () => void;
  },
): Promise<AcpSessionRuntimeOptions> {
  params.assertActive?.();
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
  const inferredPatch = inferRuntimeOptionPatchFromConfigOption(params.key, params.value);
  const capabilities = await resolveManagerRuntimeCapabilities({
    runtime,
    handle,
    includeStatusConfigOptionKeys: true,
  });
  if (!capabilities.controls.includes("session/set_config_option") || !runtime.setConfigOption) {
    throw createUnsupportedControlError({
      backend: handle.backend || requireAcpExecutionSelection(meta).executor.backend,
      control: "session/set_config_option",
    });
  }

  const advertisedKeys = new Set(
    (capabilities.configOptionKeys ?? [])
      .map((entry) => normalizeLowercaseStringOrEmpty(entry))
      .filter(Boolean),
  );
  const wireKey = resolveRuntimeConfigOptionKey(params.key, capabilities.configOptionKeys);
  if (advertisedKeys.size > 0 && !advertisedKeys.has(normalizeLowercaseStringOrEmpty(wireKey))) {
    throw new AcpRuntimeError(
      "ACP_BACKEND_UNSUPPORTED_CONTROL",
      `ACP backend "${handle.backend || requireAcpExecutionSelection(meta).executor.backend}" does not accept config key "${wireKey}".`,
    );
  }

  params.assertActive?.();
  const selectingModel = inferredPatch.model !== undefined;
  const cached = params.runtimeHandles.get(params);
  if (cached) {
    cached.appliedControlSignature = undefined;
  }
  if (selectingModel) {
    // This survives process loss between remote application and the local commit.
    await markSelectionUnconfirmed(params, meta);
  }
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
    await persistManagerRuntimeOptions({
      ...params,
      options: nextOptions,
      selectionConfirmed: selectingModel,
      expectedSelection: requireAcpExecutionSelection(meta),
      expectedRuntimeSessionName: meta.runtimeSessionName,
    });
    return nextOptions;
  } catch (error) {
    // Fulfillment settles this call. Rejection does not prove the remote control has stopped.
    if (selectingModel && controlCompleted) {
      const current = params.resolveSession(params);
      if (current.kind === "ready") {
        const committed = requireAcpExecutionSelection(current.meta);
        if (
          committed.model &&
          current.meta.runtimeSessionName === meta.runtimeSessionName &&
          isDeepStrictEqual(committed.executor, requireAcpExecutionSelection(meta).executor)
        ) {
          try {
            params.assertActive?.();
            const restored = await runtime.setConfigOption!({
              handle,
              key: wireKey,
              value: committed.model.id,
            });
            const options = reconcileAcceptedRuntimeOptions(
              resolveRuntimeOptionsFromMeta(current.meta),
              restored,
            );
            if (options.model === committed.model.id) {
              await persistManagerRuntimeOptions({
                ...params,
                options,
                selectionConfirmed: true,
                expectedSelection: committed,
                expectedRuntimeSessionName: current.meta.runtimeSessionName,
              });
            }
          } catch {
            // The durable repair state remains authoritative until restoration is confirmed.
          }
        }
      }
    }
    throw error;
  }
}

/** Persists runtime option changes that do not need an immediate backend control call. */
export async function runUpdateManagerSessionRuntimeOptions(
  params: RuntimeOptionCommandContext & { patch: Partial<AcpSessionRuntimeOptions> },
): Promise<AcpSessionRuntimeOptions> {
  if (params.patch.model !== undefined) {
    await runSetManagerSessionConfigOption({ ...params, key: "model", value: params.patch.model });
  }
  const resolution = params.resolveSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  const resolvedMeta = requireReadySessionMeta(resolution);
  const { model: _model, ...patch } = params.patch;
  const nextOptions = mergeRuntimeOptions({
    current: resolveRuntimeOptionsFromMeta(resolvedMeta),
    patch,
  });
  await persistManagerRuntimeOptions({
    ...params,
    options: nextOptions,
  });
  return nextOptions;
}

/** Closes the current runtime handle and clears persisted runtime options. */
export async function runResetManagerSessionRuntimeOptions(
  params: RuntimeOptionCommandContext,
): Promise<AcpSessionRuntimeOptions> {
  const resolution = params.resolveSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  const meta = requireReadySessionMeta(resolution);
  if (requireAcpExecutionSelection(meta).model) {
    throw new AcpRuntimeError(
      "ACP_BACKEND_UNSUPPORTED_CONTROL",
      "This app cannot restore its default model in the current conversation. Select a model explicitly.",
    );
  }
  const cached = params.runtimeHandles.get(params);
  if (cached) {
    await withAcpRuntimeErrorBoundary({
      run: async () =>
        await cached.runtime.close({
          handle: cached.handle,
          reason: "reset-runtime-options",
        }),
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "Could not reset ACP runtime options.",
    });
    params.runtimeHandles.clear(params);
  }
  await persistManagerRuntimeOptions({
    ...params,
    options: {},
  });
  return {};
}

async function persistManagerRuntimeOptions(
  params: Pick<
    RuntimeOptionCommandContext,
    "cfg" | "sessionKey" | "agentId" | "runtimeHandles" | "writeSessionMeta" | "assertActive"
  > & {
    options: AcpSessionRuntimeOptions;
    selectionConfirmed?: boolean;
    expectedSelection?: AcpExecutionSelection;
    expectedRuntimeSessionName?: string;
  },
): Promise<void> {
  const normalized = normalizeRuntimeOptions(params.options);
  const hasOptions = Object.keys(normalized).length > 0;
  const persisted = await params.writeSessionMeta({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    mutate: (current, entry) => {
      if (!entry || !current) {
        return null;
      }
      const selection = requireAcpExecutionSelection(current);
      if (
        (params.expectedSelection && !isDeepStrictEqual(params.expectedSelection, selection)) ||
        (params.expectedRuntimeSessionName &&
          params.expectedRuntimeSessionName !== current.runtimeSessionName)
      ) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          "The session changed while its model selection was being applied.",
        );
      }
      const next = commitAcpExecutionSelection(
        {
          ...current,
          runtimeOptions: hasOptions ? normalized : undefined,
          cwd: normalized.cwd,
          lastActivityAt: Date.now(),
        },
        { ...selection, model: normalized.model ? { id: normalized.model } : null },
      );
      if (params.selectionConfirmed) {
        next.state = "idle";
        delete next.lastError;
      }
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
  if (!cached) {
    return;
  }
  // Persisting options does not guarantee this process pushed all controls to the runtime.
  // Force the next turn to reconcile runtime controls from persisted metadata.
  cached.appliedControlSignature = undefined;
}

async function markSelectionUnconfirmed(
  params: RuntimeOptionCommandContext,
  expected: SessionAcpMeta,
): Promise<void> {
  const persisted = await params.writeSessionMeta({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    mutate: (current, entry) => {
      if (!current || !entry) return null;
      if (
        current.runtimeSessionName !== expected.runtimeSessionName ||
        !isDeepStrictEqual(
          requireAcpExecutionSelection(current),
          requireAcpExecutionSelection(expected),
        )
      ) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          "The session changed before its model selection could be applied.",
        );
      }
      return {
        ...current,
        state: "error",
        lastError: ACP_SELECTION_REPAIR_MESSAGE,
        lastActivityAt: Date.now(),
      };
    },
    failOnError: true,
    assertCommitAllowed: params.assertActive,
  });
  if (!persisted?.acp) {
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "Could not reserve the model change for this session.",
    );
  }
}
