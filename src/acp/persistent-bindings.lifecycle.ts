/** Ensures configured channel-to-ACP bindings have live sessions and matching runtime options. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { SessionAcpLifecycle } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { AcpExecutionSelection } from "../model-picker/execution-selection.js";
import { getAcpSessionManagerCore } from "./control-plane/manager.js";
import { requireReadySession } from "./control-plane/manager.utils.js";
import {
  buildConfiguredAcpSessionKey,
  normalizeText,
  type ConfiguredAcpBindingSpec,
  type ResolvedConfiguredAcpBinding,
} from "./persistent-bindings.types.js";

// Binding lifecycle keeps configured channel conversations attached to matching ACP sessions.
function sessionStructurallyMatchesConfiguredBinding(params: {
  spec: ConfiguredAcpBindingSpec;
  meta: SessionAcpLifecycle;
  selection: AcpExecutionSelection;
}): boolean {
  if (params.meta.state === "error") {
    return false;
  }

  const desiredAgent = normalizeLowercaseStringOrEmpty(
    params.spec.acpAgentId ?? params.spec.agentId,
  );
  const currentAgent = normalizeLowercaseStringOrEmpty(params.selection.executor.agent);
  if (!currentAgent || currentAgent !== desiredAgent) {
    return false;
  }

  if (params.meta.mode !== params.spec.mode) {
    return false;
  }

  const desiredBackend = normalizeText(params.spec.backend);
  if (desiredBackend) {
    const currentBackend = params.selection.executor.backend;
    if (!currentBackend || currentBackend !== desiredBackend) {
      return false;
    }
  }

  const desiredCwd = normalizeText(params.spec.cwd);
  if (desiredCwd !== undefined) {
    const currentCwd = (params.meta.runtimeOptions?.cwd ?? params.meta.cwd ?? "").trim();
    if (desiredCwd !== currentCwd) {
      return false;
    }
  }
  return true;
}

/** Creates or replaces the ACP session required by one configured binding. */
export async function ensureConfiguredAcpBindingSession(params: {
  cfg: OpenClawConfig;
  spec: ConfiguredAcpBindingSpec;
}): Promise<{ ok: true; sessionKey: string } | { ok: false; sessionKey: string; error: string }> {
  const sessionKey = buildConfiguredAcpSessionKey(params.spec);
  const acpManager = getAcpSessionManagerCore();
  const runtimeOptions = {
    ...(params.spec.model ? { model: params.spec.model } : {}),
    ...(params.spec.thinking ? { thinking: params.spec.thinking } : {}),
  };
  try {
    const resolution = acpManager.resolveSession({
      cfg: params.cfg,
      agentId: params.spec.agentId,
      sessionKey,
    });
    if (resolution.kind === "ready") {
      requireReadySession(resolution);
    }
    if (
      resolution.kind === "ready" &&
      sessionStructurallyMatchesConfiguredBinding({
        spec: params.spec,
        meta: resolution.meta,
        selection: resolution.selection,
      })
    ) {
      // Configured model preferences initialize once; the accepted model survives later ensures.
      const thinking = runtimeOptions.thinking;
      if (
        thinking !== undefined &&
        normalizeText(resolution.meta.runtimeOptions?.thinking) !== thinking
      ) {
        await acpManager.setSessionConfigOption({
          cfg: params.cfg,
          agentId: params.spec.agentId,
          sessionKey,
          key: "thinking",
          value: thinking,
        });
      }
      return {
        ok: true,
        sessionKey,
      };
    }

    if (resolution.kind !== "none") {
      await acpManager.closeSession({
        cfg: params.cfg,
        agentId: params.spec.agentId,
        sessionKey,
        reason: "config-binding-reconfigure",
        clearMeta: false,
        allowBackendUnavailable: true,
        requireAcpSession: false,
      });
    }

    await acpManager.initializeSession({
      cfg: params.cfg,
      agentId: params.spec.agentId,
      sessionKey,
      agent: params.spec.acpAgentId ?? params.spec.agentId,
      mode: params.spec.mode,
      runtimeOptions,
      cwd: params.spec.cwd,
      backendId: params.spec.backend,
    });

    return {
      ok: true,
      sessionKey,
    };
  } catch (error) {
    const message = formatErrorMessage(error);
    logVerbose(
      `acp-configured-binding: failed ensuring ${params.spec.channel}:${params.spec.accountId}:${params.spec.conversationId} -> ${sessionKey}: ${message}`,
    );
    return {
      ok: false,
      sessionKey,
      error: message,
    };
  }
}

/** Resolves a configured binding for a conversation and ensures its ACP session exists. */
export async function ensureConfiguredAcpBindingReadyCore(params: {
  cfg: OpenClawConfig;
  configuredBinding: ResolvedConfiguredAcpBinding | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!params.configuredBinding) {
    return { ok: true };
  }
  const ensured = await ensureConfiguredAcpBindingSession({
    cfg: params.cfg,
    spec: params.configuredBinding.spec,
  });
  if (ensured.ok) {
    return { ok: true };
  }
  return {
    ok: false,
    error: ensured.error ?? "unknown error",
  };
}
