import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { requireReadySessionMeta } from "../../acp/control-plane/manager.utils.js";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareSessionExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
import {
  isAcpExecutionSelection,
  type AcpExecutionSelection,
} from "../../model-picker/execution-selection.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
} from "../../sessions/model-overrides.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import {
  invalidSessionPatchOutcome,
  sessionChangedError,
  unexpectedPatchError,
} from "./sessions-patch-errors.js";

export function isAcpModelSelectionPatch(
  patch: Pick<SessionsPatchParams, "model" | "agentRuntime">,
): boolean {
  return patch.model !== undefined || patch.agentRuntime === null;
}

/** Apply backend selection and the caller's complete agent-row commit under one session actor. */
export async function applyAcpSessionPatch<T extends { ok: true }>(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  entry: SessionEntry;
  patch: SessionsPatchParams;
  assertCurrent: () => void;
  commitAccepted: (selection: AcpExecutionSelection) => Promise<T>;
}): Promise<T | { ok: false; error: ErrorShape }> {
  if (typeof params.patch.agentRuntime === "string") {
    return invalidSessionPatchOutcome("Runtime selection is owned by this ACP session.");
  }
  if (isModelSelectionLocked(params.entry)) {
    return invalidSessionPatchOutcome(MODEL_SELECTION_LOCKED_MESSAGE);
  }
  const raw = params.patch.model;
  const reset = raw === null || params.patch.agentRuntime === null;
  if (!reset && typeof raw !== "string") {
    return invalidSessionPatchOutcome("A model selection is required.");
  }
  if (typeof raw === "string" && !raw.trim()) {
    return invalidSessionPatchOutcome("invalid model: empty");
  }
  if (typeof raw === "string" && splitTrailingAuthProfile(raw).profile) {
    return invalidSessionPatchOutcome(
      "This app owns its account selection. Change accounts in the app.",
    );
  }
  const { getAcpSessionManager } = await import("../../acp/control-plane/manager.js");
  const manager = getAcpSessionManager();
  const target = { cfg: params.cfg, sessionKey: params.sessionKey, agentId: params.agentId };
  const assertActive = () => {
    params.assertCurrent();
    const current = manager.resolveSession(target);
    if (
      current.kind !== "ready" ||
      !current.entry ||
      current.entry.sessionId !== params.entry.sessionId ||
      current.entry.lifecycleRevision !== params.entry.lifecycleRevision
    ) {
      throw new SessionMutationAuthorizationChangedError(sessionChangedError(params.sessionKey));
    }
    if (isModelSelectionLocked(current.entry)) {
      throw new SessionMutationAuthorizationChangedError(
        errorShape(ErrorCodes.INVALID_REQUEST, MODEL_SELECTION_LOCKED_MESSAGE),
      );
    }
  };
  try {
    assertActive();
    const current = manager.resolveSession(target);
    const meta = requireReadySessionMeta(current);
    const defaults = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
    const prepared = await prepareSessionExecutionSelection({
      ...target,
      sessionEntry: { ...params.entry, acp: meta },
      request: reset
        ? {
            kind: "reset",
            ...(typeof raw === "string"
              ? { model: { provider: defaults.provider, id: raw.trim() } }
              : {}),
          }
        : typeof raw === "string"
          ? { kind: "model", model: { provider: defaults.provider, id: raw.trim() } }
          : { kind: "reset" },
    });
    if (prepared.status !== "ready") {
      return invalidSessionPatchOutcome(prepared.message);
    }
    if (!isAcpExecutionSelection(prepared.selection)) {
      return invalidSessionPatchOutcome("Changing apps requires a new conversation.");
    }
    return await manager.withExecutionSelection({
      ...target,
      selection: prepared.selection,
      assertActive,
      commitAccepted: params.commitAccepted,
    });
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof AcpRuntimeError
          ? errorShape(
              error.code === "ACP_BACKEND_UNSUPPORTED_CONTROL"
                ? ErrorCodes.INVALID_REQUEST
                : ErrorCodes.UNAVAILABLE,
              error.message,
            )
          : unexpectedPatchError(params.sessionKey, error),
    };
  }
}
