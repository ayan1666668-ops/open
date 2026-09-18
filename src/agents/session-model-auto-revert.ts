import { isDeepStrictEqual } from "node:util";
import { resolveCollapsedSessionAuthPinSource } from "../config/sessions/auth-profile-override-provenance.js";
/** One-run rollback for agent-selected session models. */
import {
  appendTranscriptMessage,
  loadSessionEntry,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { AgentPatchedSessionModelFallback } from "../config/sessions/session-model-fallback.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createAgentPatchedSessionModelFallback,
  prepareSessionExecutionSelection,
  commitSessionExecutionSelection,
  executionSelectionTransactionChanged,
  formatExecutionSelectionAcknowledgment,
} from "../model-picker/apply-session-model-selection.js";
import { getCommittedSessionExecutionSelection } from "../model-picker/execution-selection.js";
import { isModelSelectionLocked } from "../sessions/model-overrides.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import { resolveFailoverReasonFromError } from "./failover-error.js";
import type { FailoverReason } from "./failover/signal.js";
import { resolveSessionModelRefCore as resolveSessionModelRef } from "./session-model-ref.js";

// Revert only when the chosen model is definitively unusable. Transient
// provider states (rate_limit/overloaded/timeout/server_error) hit working
// models too; reverting on them would undo a valid choice.
const REVERT_REASONS = new Set<FailoverReason>([
  "auth",
  "auth_permanent",
  "billing",
  "model_not_found",
]);

type SessionModelRunOutcome =
  | { success: true }
  | { success: false; error?: unknown; reason?: FailoverReason };

async function reconcileAgentPatchedSessionModel(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  storePath?: string;
  outcome: SessionModelRunOutcome;
  expectedMarkerTs?: number;
  validatedFallback?: AgentPatchedSessionModelFallback;
  now?: number;
}): Promise<"cleared" | "promoted" | "reverted" | "kept" | "none"> {
  const reason = params.outcome.success
    ? undefined
    : (params.outcome.reason ?? resolveFailoverReasonFromError(params.outcome.error));
  if (!params.outcome.success && (!reason || !REVERT_REASONS.has(reason))) {
    return "kept";
  }

  const rollbackEntry = !params.outcome.success
    ? loadSessionEntry({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        readConsistency: "latest",
      })
    : undefined;
  const rollbackMarker = rollbackEntry?.modelFallback;
  const rollback =
    rollbackMarker?.source === "agent-patch"
      ? await prepareSessionExecutionSelection({
          cfg: params.cfg,
          agentId: resolveSessionAgentId({
            config: params.cfg,
            sessionKey: params.sessionKey,
            agentId: params.agentId,
          }),
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          sessionEntry: {
            ...rollbackEntry,
            executionSelection: rollbackMarker.previous,
            authProfileOverride: rollbackMarker.prevAuthProfileOverride,
            authProfileOverrideSource: resolveCollapsedSessionAuthPinSource({
              authProfileOverride: rollbackMarker.prevAuthProfileOverride,
              authProfileOverrideSource: rollbackMarker.prevAuthProfileOverrideSource,
              authProfileOverrideCompactionCount:
                rollbackMarker.prevAuthProfileOverrideCompactionCount,
            }),
            authProfileOverrideCompactionCount:
              rollbackMarker.prevAuthProfileOverrideCompactionCount,
          },
          request: { kind: "initialize" },
        })
      : undefined;
  let note: string | undefined;
  let sessionId: string | undefined;
  let result: "cleared" | "promoted" | "reverted" | "kept" | "none" = "none";
  await patchSessionEntryCore(
    {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    (entry) => {
      const marker = entry.modelFallback;
      if (marker?.source !== "agent-patch") {
        return null;
      }
      if (params.expectedMarkerTs !== undefined && marker.ts !== params.expectedMarkerTs) {
        if (
          params.outcome.success &&
          params.validatedFallback &&
          marker.ts > params.expectedMarkerTs &&
          params.expectedMarkerTs > (marker.lastValidatedPatchTs ?? -1)
        ) {
          result = "promoted";
          return {
            modelFallback: {
              ...params.validatedFallback,
              ts: marker.ts,
              lastValidatedPatchTs: params.expectedMarkerTs,
            },
          };
        }
        return null;
      }
      sessionId = entry.sessionId;
      if (params.outcome.success) {
        result = "cleared";
        return { modelFallback: undefined };
      }
      if (
        !rollback ||
        rollback.status !== "ready" ||
        !rollbackEntry ||
        isModelSelectionLocked(entry) ||
        entry.sessionId !== rollbackEntry.sessionId ||
        entry.lifecycleRevision !== rollbackEntry.lifecycleRevision ||
        !isDeepStrictEqual(rollbackMarker, marker) ||
        entry.thinkingLevel !== rollbackEntry.thinkingLevel ||
        entry.contextWindow !== rollbackEntry.contextWindow ||
        executionSelectionTransactionChanged(rollbackEntry, entry)
      ) {
        result = "kept";
        note = rollback?.status === "rejected" ? rollback.message : undefined;
        return null;
      }
      const selectionError = rollback.validateCommit();
      if (selectionError) {
        throw new Error(selectionError);
      }
      const next = { ...entry };
      commitSessionExecutionSelection(next, rollback.selection, {
        cause: {
          kind: "inherit",
          entry: {
            executionSelection: {
              ...marker.previous,
              fallbackPermission: rollback.fallbackPermission ?? marker.previous.fallbackPermission,
            },
          },
        },
      });
      result = "reverted";
      note =
        "The requested model could not be used. Restored the previous selection. " +
        formatExecutionSelectionAcknowledgment({
          selection: rollback.selection,
          before: getCommittedSessionExecutionSelection(rollbackEntry),
          reason: "explicit",
          catalog: rollback.catalogEntry ? [rollback.catalogEntry] : [],
        });
      return {
        ...next,
        model: marker.prevModel,
        modelProvider: marker.prevProvider,
        authProfileOverride: marker.prevAuthProfileOverride,
        authProfileOverrideSource: marker.prevAuthProfileOverrideSource,
        authProfileOverrideCompactionCount: marker.prevAuthProfileOverrideCompactionCount,
        contextWindow: marker.prevContextWindow,
        thinkingLevel: marker.prevThinkingLevel,
        modelFallback: undefined,
        liveModelSwitchPending: undefined,
      };
    },
  );
  if (note && sessionId) {
    try {
      const timestamp = params.now ?? Date.now();
      await appendTranscriptMessage(
        {
          agentId: params.agentId,
          sessionId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        },
        {
          config: params.cfg,
          message: {
            role: "custom" as const,
            customType: "openclaw.system-note",
            content: note,
            display: true,
            timestamp,
          },
          ...(params.now === undefined ? {} : { now: params.now }),
        },
      );
    } catch {
      // Rollback is authoritative; transcript note is best effort.
    }
  }
  return result;
}

export function createAgentPatchedSessionModelRunGuard(params: {
  cfg: OpenClawConfig;
  agentId: string | undefined;
  sessionKey: string | undefined;
  storePath: string | undefined;
  onError?: (error: unknown) => void;
}) {
  let markerTs: number | undefined;
  let validatedFallback: AgentPatchedSessionModelFallback | undefined;
  if (params.sessionKey) {
    try {
      const entry = loadSessionEntry({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      });
      const marker = entry?.modelFallback;
      markerTs = marker?.source === "agent-patch" ? marker.ts : undefined;
      if (entry && markerTs !== undefined) {
        const current = resolveSessionModelRef(params.cfg, entry, params.agentId);
        validatedFallback = createAgentPatchedSessionModelFallback({
          model: current.model,
          provider: current.provider,
          entry,
          ts: markerTs,
        });
      }
    } catch {
      markerTs = undefined;
    }
  }
  let failure: { error?: unknown; reason?: FailoverReason } = {};
  let reconciled = false;
  const captureFailure = (error: unknown, reason?: string) => {
    // Only the patch captured when this guard was created can be reconciled.
    if (markerTs === undefined) {
      return false;
    }
    const classifiedReason = reason
      ? (reason as FailoverReason)
      : resolveFailoverReasonFromError(error);
    const revertReason =
      classifiedReason && REVERT_REASONS.has(classifiedReason) ? classifiedReason : undefined;
    failure = { error, ...(revertReason ? { reason: revertReason } : {}) };
    return revertReason !== undefined;
  };
  const captureFallbackFailure = (
    attempts: readonly { error: string; reason?: string }[],
  ): boolean | undefined => {
    const attempt = attempts[0];
    return attempt ? captureFailure(new Error(attempt.error), attempt.reason) : undefined;
  };
  const reconcile = async (success: boolean) => {
    if (reconciled || !params.sessionKey || markerTs === undefined) {
      return;
    }
    reconciled = true;
    try {
      await reconcileAgentPatchedSessionModel({
        cfg: params.cfg,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        sessionKey: params.sessionKey,
        ...(params.storePath ? { storePath: params.storePath } : {}),
        expectedMarkerTs: markerTs,
        ...(validatedFallback ? { validatedFallback } : {}),
        outcome: success ? { success: true } : { success: false, ...failure },
      });
    } catch (error) {
      params.onError?.(error);
    }
  };
  return {
    captureFailure,
    captureFallbackFailure,
    async fail(error: unknown, reason?: string) {
      captureFailure(error, reason);
      await reconcile(false);
    },
    async finish(success: boolean) {
      await reconcile(success);
    },
  };
}
