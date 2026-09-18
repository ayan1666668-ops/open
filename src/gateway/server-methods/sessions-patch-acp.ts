import { isDeepStrictEqual } from "node:util";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { requireReadySession } from "../../acp/control-plane/manager.utils.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  prepareSessionExecutionSelection,
  resolveSessionExecutionControlFailure,
  withPreparedSessionExecutionSelection,
  type PreparedSessionExecutionSelection,
} from "../../model-picker/apply-session-model-selection.js";
import {
  isAcpExecutionSelection,
  type AcpExecutionSelection,
  type ExecutionSelection,
} from "../../model-picker/execution-selection.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
} from "../../sessions/model-overrides.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { resolveSessionUnreadAck } from "./session-unread-ack.js";
import {
  invalidSessionPatchOutcome,
  sessionChangedError,
  unexpectedPatchError,
} from "./sessions-patch-errors.js";
import { sessionPatchExpectationsChanged } from "./sessions-patch-expectations.js";

export function isAcpModelSelectionPatch(
  patch: Pick<SessionsPatchParams, "model" | "agentRuntime">,
): boolean {
  return patch.model !== undefined || patch.agentRuntime === null;
}

export type PreparedAcpSessionPatch = {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  sessionId: string;
  lifecycleRevision?: string;
  execution: Omit<Extract<PreparedSessionExecutionSelection, { status: "ready" }>, "selection"> & {
    selection: AcpExecutionSelection;
  };
  assertActive: () => void;
  assertSelectionCurrent: () => void;
};

/** Validate the native request before any backend control or accompanying edit is applied. */
export async function prepareAcpSessionPatch(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  entry: SessionEntry;
  patch: SessionsPatchParams;
  assertCurrent: () => void;
}): Promise<{ ok: true; prepared: PreparedAcpSessionPatch } | { ok: false; error: ErrorShape }> {
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
  const { getAcpSessionManagerCore } = await import("../../acp/control-plane/manager.js");
  const manager = getAcpSessionManagerCore();
  const target = {
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    sessionId: params.entry.sessionId,
    lifecycleRevision: params.entry.lifecycleRevision,
  };
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
    return current;
  };
  try {
    const current = assertActive();
    const { meta } = requireReadySession(current);
    const prepared = await prepareSessionExecutionSelection({
      ...target,
      sessionEntry: { ...params.entry, acp: meta },
      request: reset
        ? {
            kind: "reset",
            ...(typeof raw === "string" ? { model: { id: raw.trim() } } : {}),
          }
        : typeof raw === "string"
          ? { kind: "model", model: { id: raw.trim() } }
          : { kind: "reset" },
    });
    if (prepared.status !== "ready") {
      return invalidSessionPatchOutcome(prepared.message);
    }
    if (!isAcpExecutionSelection(prepared.selection)) {
      return invalidSessionPatchOutcome("Changing apps requires a new conversation.");
    }
    const assertSelectionCurrent = () => {
      const latest = assertActive();
      if (
        !isDeepStrictEqual(latest.entry.executionSelection, params.entry.executionSelection) ||
        sessionPatchExpectationsChanged(latest.entry, params.patch) ||
        resolveSessionUnreadAck(latest.entry, params.patch).kind !== "apply"
      ) {
        throw new SessionMutationAuthorizationChangedError(sessionChangedError(params.sessionKey));
      }
      const error = prepared.validateCommit();
      if (error) {
        throw new SessionMutationAuthorizationChangedError(
          errorShape(ErrorCodes.INVALID_REQUEST, error),
        );
      }
    };
    return {
      ok: true,
      prepared: {
        ...target,
        execution: { ...prepared, selection: prepared.selection },
        assertActive,
        assertSelectionCurrent,
      },
    };
  } catch (error) {
    return { ok: false, error: await acpPatchError(target, error) };
  }
}

/** Hold the native actor through the caller's atomic agent-row commit. */
export async function applyAcpSessionPatch<T extends { ok: true }>(params: {
  prepared: PreparedAcpSessionPatch;
  commitAccepted: (selection: ExecutionSelection) => Promise<T>;
  selectionCommitted: () => boolean;
}): Promise<T | { ok: false; error: ErrorShape }> {
  const { execution, ...target } = params.prepared;
  try {
    return await withPreparedSessionExecutionSelection({
      ...target,
      prepared: execution,
      commitAccepted: params.commitAccepted,
    });
  } catch (error) {
    return { ok: false, error: await acpPatchError(target, error, params.selectionCommitted()) };
  }
}

async function acpPatchError(
  target: Pick<
    PreparedAcpSessionPatch,
    "cfg" | "agentId" | "sessionKey" | "sessionId" | "lifecycleRevision"
  >,
  error: unknown,
  selectionCommitted = false,
): Promise<ErrorShape> {
  const failure = await resolveSessionExecutionControlFailure(error, {
    ...target,
    selectionCommitted,
  });
  if (!failure) {
    return unexpectedPatchError(target.sessionKey, error);
  }
  return errorShape(
    !selectionCommitted && (failure.reason === "unsupported" || failure.reason === "not-allowed")
      ? ErrorCodes.INVALID_REQUEST
      : ErrorCodes.UNAVAILABLE,
    selectionCommitted
      ? `Session settings were saved.${failure.confirmationNotice ? ` ${failure.confirmationNotice}` : ""}`
      : failure.message,
  );
}
