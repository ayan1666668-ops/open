/** Ensures or recreates a live ACP runtime handle for persisted session metadata. */
import { isDeepStrictEqual } from "node:util";
import {
  createIdentityFromEnsure,
  identityEquals,
  identityHasStableSessionId,
  mergeSessionIdentity,
  resolveRuntimeHandleIdentifiersFromIdentity,
  resolveRuntimeResumeSessionId,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import { resolveRuntimeConfigCacheKey } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { admitSessionExecutionFallback } from "../../model-picker/apply-session-model-selection.js";
import type { AcpExecutionSelection } from "../../model-picker/execution-selection.js";
import {
  AcpRuntimeError,
  toAcpRuntimeError,
  withAcpRuntimeErrorBoundary,
} from "../runtime/errors.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import {
  assertAcpRuntimeOwnerSupport,
  isAcpOwnerRepairRequired,
  persistedAcpRuntimeHandle,
} from "./manager.runtime-owner.js";
import type {
  AcpSessionManagerDeps,
  SessionAcpLifecycle,
  WriteManagerSessionMeta,
} from "./manager.types.js";
import {
  ACP_SELECTION_REPAIR_MESSAGE,
  hasLegacyAcpIdentityProjection,
  requireAcpExecutionSelection,
} from "./manager.utils.js";
import {
  normalizeRuntimeOptions,
  normalizeText,
  resolveRuntimeOptionsFromMeta,
  runtimeOptionsEqual,
} from "./runtime-options.js";

/** Returns a reusable cached handle or initializes a fresh runtime session for the metadata. */
export async function ensureManagerRuntimeHandle(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  meta: SessionAcpLifecycle;
  selection: AcpExecutionSelection;
  selectedBackend?: string;
  preserveActivity?: boolean;
  deps: Pick<AcpSessionManagerDeps, "requireRuntimeBackend">;
  runtimeHandles: ManagerRuntimeHandleCache;
  writeSessionMeta: WriteManagerSessionMeta;
}): Promise<{ runtime: AcpRuntime; handle: AcpRuntimeHandle; meta: SessionAcpLifecycle }> {
  const { selection } = params;
  const agent = selection.executor.agent;
  const mode = params.meta.mode;
  const runtimeOptions = resolveRuntimeOptionsFromMeta(params.meta);
  const cwd = runtimeOptions.cwd ?? normalizeText(params.meta.cwd);
  const model = selection.model === "native-managed" ? undefined : selection.model.id;
  const thinking = normalizeText(runtimeOptions.thinking);
  const configuredBackend = params.selectedBackend || selection.executor.backend;
  const turnLocal = configuredBackend !== selection.executor.backend;
  const configSignature = resolveRuntimeConfigCacheKey(params.cfg);
  const backend = params.deps.requireRuntimeBackend(configuredBackend || undefined);
  const runtime = backend.runtime;
  assertAcpRuntimeOwnerSupport(runtime, params);
  if (turnLocal) {
    // Missing backends and unsupported owners cannot have started an external operation.
    // Reserve only after those preconditions, but before any runtime call can become uncertain.
    const reserved = await params.writeSessionMeta({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      mutate: (current, entry) => {
        if (!current || !entry) {
          return null;
        }
        if (
          current.runtimeSessionName !== params.meta.runtimeSessionName ||
          !isDeepStrictEqual(requireAcpExecutionSelection(entry), selection) ||
          admitSessionExecutionFallback({
            entry,
            candidate: {
              ...selection,
              executor: { ...selection.executor, backend: configuredBackend },
            },
          }).status !== "accepted"
        ) {
          throw new AcpRuntimeError(
            "ACP_SESSION_INIT_FAILED",
            "The session selection no longer permits this fallback backend.",
          );
        }
        return { ...current, state: "error", lastError: ACP_SELECTION_REPAIR_MESSAGE };
      },
      failOnError: true,
    });
    if (!reserved?.acp) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        "Could not reserve the temporary app selection.",
      );
    }
  }
  const cached = params.runtimeHandles.get(params);
  if (cached) {
    const backendMatches = !configuredBackend || cached.backend === configuredBackend;
    const agentMatches = cached.agent === agent;
    const modeMatches = cached.mode === mode;
    const cwdMatches = (cached.cwd ?? "") === (cwd ?? "");
    const configMatches = cached.configSignature === configSignature;
    const handleMatchesMeta = params.runtimeHandles.handleMatchesMeta({
      handle: cached.handle,
      meta: params.meta,
    });
    if (
      backendMatches &&
      agentMatches &&
      modeMatches &&
      cwdMatches &&
      configMatches &&
      handleMatchesMeta &&
      (await params.runtimeHandles.isReusable({
        sessionKey: params.sessionKey,
        runtime: cached.runtime,
        handle: cached.handle,
      }))
    ) {
      return {
        runtime: cached.runtime,
        handle: cached.handle,
        meta: params.meta,
      };
    }
    await params.runtimeHandles.close({
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      reason: "runtime-handle-replaced",
    });
  }

  const previousMeta = params.meta;
  const persistedIdentity = resolveSessionIdentityFromMeta(previousMeta);
  // Identifiers belong to their persisted backend; a new backend may recover its own named session.
  const backendOwnsPreviousIdentity = selection.executor.backend === backend.id;
  const previousIdentity = backendOwnsPreviousIdentity ? persistedIdentity : undefined;
  const persistedHandle = backendOwnsPreviousIdentity
    ? persistedAcpRuntimeHandle(params, previousMeta, selection)
    : undefined;
  let identityForEnsure = previousIdentity;
  const persistedResumeSessionId =
    mode === "persistent" ? resolveRuntimeResumeSessionId(previousIdentity) : undefined;
  const shouldPrepareFreshPersistentSession =
    mode === "persistent" &&
    previousIdentity != null &&
    !identityHasStableSessionId(previousIdentity);
  const ensureSession = async (resumeSessionId?: string) =>
    await withAcpRuntimeErrorBoundary({
      run: async () =>
        await runtime.ensureSession({
          persistedHandle,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          agent,
          mode,
          ...(resumeSessionId ? { resumeSessionId } : {}),
          // Stored options lack caller intent; runtime controls validate the
          // saved model before submitting any prompt.
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
          cwd,
        }),
      fallbackCode: "ACP_SESSION_INIT_FAILED",
      fallbackMessage: "Could not initialize ACP session runtime.",
    });
  let ensured: AcpRuntimeHandle;
  if (shouldPrepareFreshPersistentSession) {
    await runtime.prepareFreshSession?.({
      persistedHandle,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
  }
  if (persistedResumeSessionId) {
    try {
      ensured = await ensureSession(persistedResumeSessionId);
    } catch (error) {
      const acpError = toAcpRuntimeError({
        error,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Could not initialize ACP session runtime.",
      });
      if (isAcpOwnerRepairRequired(acpError) || acpError.code !== "ACP_SESSION_INIT_FAILED") {
        throw acpError;
      }
      logVerbose(
        `acp-manager: resume init failed for ${params.sessionKey}; retrying without persisted ACP session id: ${acpError.message}`,
      );
      if (identityForEnsure) {
        const {
          acpxSessionId: _staleAcpxSessionId,
          agentSessionId: _staleAgentSessionId,
          ...retryIdentity
        } = identityForEnsure;
        // The persisted resume identifiers already failed, so do not merge them back into the
        // fresh named-session handle returned by the retry path.
        identityForEnsure = {
          ...retryIdentity,
          state: "pending",
        };
      }
      ensured = await ensureSession();
    }
  } else {
    ensured = await ensureSession();
  }

  const now = Date.now();
  const effectiveCwd = normalizeText(ensured.cwd) ?? cwd;
  const nextRuntimeOptions = normalizeRuntimeOptions({
    ...runtimeOptions,
    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
  });
  const nextIdentity =
    mergeSessionIdentity({
      current: identityForEnsure,
      incoming: createIdentityFromEnsure({
        handle: ensured,
        now,
      }),
      now,
    }) ?? identityForEnsure;
  const nextHandleIdentifiers = resolveRuntimeHandleIdentifiersFromIdentity(nextIdentity);
  const nextHandle: AcpRuntimeHandle = {
    ...ensured,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    ...(nextHandleIdentifiers.backendSessionId
      ? { backendSessionId: nextHandleIdentifiers.backendSessionId }
      : {}),
    ...(nextHandleIdentifiers.agentSessionId
      ? { agentSessionId: nextHandleIdentifiers.agentSessionId }
      : {}),
  };
  const nextMeta: SessionAcpLifecycle = {
    runtimeSessionName: ensured.runtimeSessionName,
    ...(nextIdentity ? { identity: nextIdentity } : {}),
    mode: params.meta.mode,
    ...(Object.keys(nextRuntimeOptions).length > 0 ? { runtimeOptions: nextRuntimeOptions } : {}),
    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
    state: previousMeta.state,
    lastActivityAt: now,
    ...(previousMeta.lastError ? { lastError: previousMeta.lastError } : {}),
  };
  const shouldPersistMeta =
    previousMeta.runtimeSessionName !== nextMeta.runtimeSessionName ||
    !identityEquals(persistedIdentity, nextIdentity) ||
    previousMeta.cwd !== nextMeta.cwd ||
    !runtimeOptionsEqual(previousMeta.runtimeOptions, nextMeta.runtimeOptions) ||
    hasLegacyAcpIdentityProjection(previousMeta);
  if (shouldPersistMeta && !turnLocal) {
    await params.writeSessionMeta({
      preserveActivity: params.preserveActivity,
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      mutate: (_current, entry) => {
        if (!entry) {
          return null;
        }
        return nextMeta;
      },
    });
  }
  params.runtimeHandles.set(params, {
    runtime,
    handle: nextHandle,
    backend: ensured.backend || backend.id,
    agent,
    mode,
    cwd: effectiveCwd,
    configSignature,
    appliedControlSignature: undefined,
  });
  return {
    runtime,
    handle: nextHandle,
    meta: nextMeta,
  };
}
