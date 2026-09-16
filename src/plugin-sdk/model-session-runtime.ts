/**
 * Runtime SDK subpath for model overrides and agent concurrency session helpers.
 */
import { expectDefined } from "@openclaw/normalization-core";
import type { ModelVisibilityPolicy } from "../agents/model-selection.js";
import type {
  ApplySessionModelSelectionParams as OwnerSelectionParams,
  ApplySessionModelSelectionResult as OwnerSelectionResult,
  SessionModelSelectionRequest as OwnerSelectionRequest,
} from "../model-picker/apply-session-model-selection.js";
import {
  isAcpExecutionSelection,
  type ModelExecutionSelection,
} from "../model-picker/execution-selection.js";

export type SessionModelSelectionRequest = Pick<
  OwnerSelectionRequest,
  "provider" | "model" | "isDefault" | "alias" | "profileOverride" | "runtime"
>;
export type ApplySessionModelSelectionParams = Omit<
  OwnerSelectionParams,
  "request" | "modelPolicy"
> & {
  request: SessionModelSelectionRequest;
  modelPolicy?: ModelVisibilityPolicy;
};
export type ApplySessionModelSelectionResult =
  | (Omit<Extract<OwnerSelectionResult, { status: "applied" }>, "selection" | "contextTokens"> & {
      selection: ModelExecutionSelection;
      provider: string;
      model: string;
      effectiveModelRef: string;
      agentRuntime: string;
      contextTokens: number;
      runtimeChange?: { kind: "clear" } | { kind: "set"; runtime: string };
    })
  | {
      status: "rejected";
      reason: "locked" | "not-allowed" | "invalid-runtime" | "unknown-provider";
      message: string;
    }
  | Extract<OwnerSelectionResult, { status: "conflict" }>;

/** Preserve the shipped flat response while the session owner accepts and commits one pair. */
export async function applySessionModelSelection(
  params: ApplySessionModelSelectionParams,
): Promise<ApplySessionModelSelectionResult> {
  const { readAcpSessionMetaForEntry } = await import("../acp/runtime/session-meta.js");
  const acpInstruction =
    "Change the model in its own request for this session. Use the dedicated session model request for this app.";
  const isAcpBound = () => {
    const entry = params.storePath
      ? params.sessionEntry
      : (params.sessionStore[params.sessionKey] ?? params.sessionEntry);
    return Boolean(
      entry.acp ||
      readAcpSessionMetaForEntry({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        entry,
      }),
    );
  };
  if (isAcpBound())
    return { status: "rejected", reason: "invalid-runtime", message: acpInstruction };
  const owner = await import("../model-picker/apply-session-model-selection.js");
  const result = await owner.applySessionModelSelection({
    ...params,
    validateAuthProfileSelection: () =>
      params.validateAuthProfileSelection?.() ?? (isAcpBound() ? acpInstruction : undefined),
  });
  if (result.status === "conflict") return result;
  if (result.status === "rejected") {
    const reason =
      result.reason === "locked" ||
      result.reason === "not-allowed" ||
      result.reason === "unknown-provider"
        ? result.reason
        : "invalid-runtime";
    return { ...result, reason };
  }
  if (isAcpExecutionSelection(result.selection)) {
    throw new Error("ACP selection crossed the flat SDK response boundary.");
  }
  const { provider, id: model } = result.selection.model;
  return {
    ...result,
    selection: result.selection,
    provider,
    model,
    effectiveModelRef: `${provider}/${model}`,
    agentRuntime: result.selection.executor.id,
    contextTokens: expectDefined(
      result.contextTokens,
      "Accepted model selection has no context budget.",
    ),
    ...(params.request.runtime.kind === "clear"
      ? { runtimeChange: { kind: "clear" as const } }
      : params.request.runtime.kind === "set"
        ? { runtimeChange: { kind: "set" as const, runtime: result.selection.executor.id } }
        : {}),
  };
}

export { resolveChannelModelOverride } from "../channels/model-overrides.js";
export { resolveAgentMaxConcurrent } from "../config/agent-limits.js";
export { resolvePersistedSessionRuntimeId } from "../agents/session-runtime-compat.js";
export { resolveSessionModelRef } from "../agents/session-model-ref.js";
export {
  applyModelOverrideToSessionEntry,
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
  ModelSelectionLockedError,
} from "../sessions/model-overrides.js";
export { applyModelOverrideWithAuthProfileCompatibility } from "../sessions/auth-profile-preservation.js";
