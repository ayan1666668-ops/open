import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import {
  getModelRefStatus,
  resolveAllowedModelRef,
  type ModelRef,
} from "../../agents/model-selection.js";
import { resolveSessionModelRefCore as resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import { refreshQueuedFollowupSession } from "../../auto-reply/reply/queue.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PreparedSessionExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
import {
  getSessionExecutionSelection,
  isAcpExecutionSelection,
} from "../../model-picker/execution-selection.js";
import type { SessionWorkerPlacementContext } from "../worker-environments/session-placement-lifecycle.js";
import { resolveGatewayModelSelectionPolicy } from "./session-model-selection-policy.js";
import { resolveSessionWorkerPlacementPatchError } from "./sessions-shared.js";

export function persistSessionPatchModelSelection(params: {
  callerScopes: readonly string[];
  cfg: OpenClawConfig;
  entry: SessionEntry;
  patch: SessionsPatchParams;
  sessionKey: string;
  targetAgentId: string;
}): void {
  const selection = getSessionExecutionSelection(params.entry);
  if (typeof params.patch.model !== "string" || (selection && isAcpExecutionSelection(selection))) {
    return;
  }
  const policy = resolveGatewayModelSelectionPolicy({
    callerScopes: params.callerScopes,
    cfg: params.cfg,
  });
  if (policy.target === "session") {
    return;
  }
  const agentId = resolveSessionAgentId({
    config: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.targetAgentId,
  });
  const resolved = resolveSessionModelRef(params.cfg, params.entry, agentId);
  persistStickyModelSelectionBestEffort({
    agentId,
    model: `${resolved.provider}/${resolved.model}`,
    target: policy.target === "agent" ? "agent" : "defaults",
  });
}

/** Refresh only after commit, while this patch still holds session mutation ordering. */
export function refreshSessionPatchQueuedSelection(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  patch: SessionsPatchParams;
  sessionKey: string;
  agentId: string;
  catalog?: ModelCatalogEntry[];
}): void {
  if (!("agentRuntime" in params.patch) && !("model" in params.patch)) {
    return;
  }
  const { entry, sessionKey } = params;
  const selection = getSessionExecutionSelection(entry);
  if (!selection || isAcpExecutionSelection(selection)) {
    return;
  }
  refreshQueuedFollowupSession({
    key: sessionKey,
    nextSelection: selection,
    nextAuthProfileId: entry.authProfileOverride,
    nextAuthProfileIdSource: resolveCollapsedSessionAuthPinSource(entry),
    nextThinking: {
      level: entry.thinkingLevel,
      catalog: params.catalog,
    },
  });
}

export function resolveSessionPatchModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  catalog: ModelCatalogEntry[];
  raw: string;
  defaultProvider: string;
  defaultModel: string;
  subagentModelHint?: string;
  preparedModelSelection?: ModelRef;
}):
  | { ok: true; provider: string; model: string; profile?: string; isDefault: boolean }
  | { ok: false; error: string } {
  const { model: modelWithoutProfile, profile } = splitTrailingAuthProfile(params.raw);
  if (params.preparedModelSelection) {
    const ref = params.preparedModelSelection;
    if (modelWithoutProfile !== `${ref.provider}/${ref.model}`) {
      return { ok: false, error: "Resolved spawn model does not match the requested model." };
    }
    const status = getModelRefStatus({
      cfg: params.cfg,
      agentId: params.agentId,
      catalog: params.catalog,
      ref,
      defaultProvider: params.defaultProvider,
      defaultModel: params.subagentModelHint ?? {
        provider: params.defaultProvider,
        model: params.defaultModel,
      },
    });
    return status.allowed
      ? { ok: true, ...ref, ...(profile ? { profile } : {}), isDefault: false }
      : { ok: false, error: `model not allowed: ${status.key}` };
  }
  const resolved = resolveAllowedModelRef({
    cfg: params.cfg,
    agentId: params.agentId,
    catalog: params.catalog,
    raw: modelWithoutProfile,
    defaultProvider: params.defaultProvider,
    defaultModel: params.subagentModelHint ?? {
      provider: params.defaultProvider,
      model: params.defaultModel,
    },
  });
  if ("error" in resolved) {
    return { ok: false, error: resolved.error };
  }
  return {
    ok: true,
    provider: resolved.ref.provider,
    model: resolved.ref.model,
    ...(profile ? { profile } : {}),
    // A concrete model request is a pin even when it currently equals the
    // configured default. Only the explicit null patch represents Default.
    isDefault: false,
  };
}

/** Bind runtime availability and placement checks to the selection's commit guard. */
export async function prepareSessionPatchRuntimeSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  patch: SessionsPatchParams;
  entry: SessionEntry;
  execution?: Extract<PreparedSessionExecutionSelection, { status: "ready" }>;
  placement?: { context: SessionWorkerPlacementContext; sessionKey: string };
}): Promise<
  { ok: true; validate?: () => ErrorShape | undefined } | { ok: false; error: ErrorShape }
> {
  const validate = () => {
    const message =
      params.execution?.validateCommit?.() ??
      (params.placement
        ? resolveSessionWorkerPlacementPatchError({
            cfg: params.cfg,
            agentId: params.agentId,
            context: params.placement.context,
            entry: params.entry,
            key: params.patch.key,
            sessionKey: params.placement.sessionKey,
            patch: params.patch,
            validateModelRuntime: true,
          })
        : undefined);
    return message ? errorShape(ErrorCodes.INVALID_REQUEST, message) : undefined;
  };
  const error = validate();
  return error
    ? { ok: false, error }
    : {
        ok: true,
        ...(params.execution || params.patch.agentRuntime !== undefined ? { validate } : {}),
      };
}
