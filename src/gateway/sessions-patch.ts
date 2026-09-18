// Session patch applier for gateway session metadata and model/runtime overrides.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  type SessionsPatchParams,
} from "../../packages/gateway-protocol/src/index.js";
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
} from "../agents/agent-runtime-id.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { commitPreparedSessionAuthSelection } from "../agents/auth-profiles/session-override.js";
import { selectModelCatalogRuntimeEntry } from "../agents/model-catalog-view.js";
import {
  findModelCatalogEntry,
  type ModelCatalogEntry,
  type ModelCatalogSnapshot,
} from "../agents/model-catalog.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import {
  type ModelRef,
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "../agents/model-selection.js";
import { resolveEffectiveAgentRuntimeCore } from "../agents/thinking-runtime.js";
import { normalizeGroupActivation } from "../auto-reply/group-activation.js";
import {
  normalizeThinkLevel,
  resolveSupportedThinkingLevelFromProfile,
  resolveThinkingProfile,
} from "../auto-reply/thinking.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import {
  buildSessionCreationStamp,
  type SessionCreatedVia,
} from "../config/sessions/session-entry-provenance.js";
import { projectCanonicalSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveExecutionSelectionExecutorKind,
  commitSessionModelSelectionWithAuth,
  commitStoredSessionExecutionSelection,
  commitSessionExecutionSelection,
  prepareSessionExecutionSelection,
  type ExecutionSelectionRequest,
  type PreparedSessionExecutionSelection,
} from "../model-picker/apply-session-model-selection.js";
import {
  getSessionExecutionSelection,
  isAcpExecutionSelection,
  isModelExecutionSelection,
  type SessionExecutionSelection,
} from "../model-picker/execution-selection.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  isAgentHarnessSessionKeyOwnedBy,
  resolveMissingAgentHarnessSessionError,
} from "../sessions/agent-harness-session-key.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
} from "../sessions/model-overrides.js";
import { normalizeSendPolicy } from "../sessions/send-policy.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import type { AgentRuntimeSpawnModelAutoSelection } from "./agent-runtime-session-spawn-context.js";
import type {
  ModelAccountConnectAction,
  UserModelAccountSelection,
} from "./model-account-authority.js";
import { resolveSessionPatchModelSelection } from "./server-methods/sessions-patch-model-selection.js";
import {
  isAgentSessionModelPatchOrigin,
  snapshotAgentModelFallback,
} from "./session-model-patch-origin.js";
import { applySessionContextWindowPatch } from "./sessions-patch-context-window.js";
import {
  applySessionsPatchDisplayMetadata,
  applySessionsPatchAgentStatus,
  applySessionsPatchListState,
} from "./sessions-patch-display-metadata.js";
import { applySessionsPatchPreferences } from "./sessions-patch-preferences.js";
import { applySessionsPatchSubagentPolicy } from "./sessions-patch-subagent-policy.js";

function invalid(message: string): { ok: false; error: ErrorShape } {
  return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, message) };
}

type SessionPatchProjectionParams = {
  cfg: OpenClawConfig;
  creation?: { via: SessionCreatedVia; actor?: SessionEntry["createdActor"] };
  existingEntry?: SessionEntry;
  isLabelInUse: (label: string) => boolean;
  storeKey: string;
  agentId?: string;
  patch: SessionsPatchParams;
  /** Canonical root prepared by the trusted create path; never accepted from public patches. */
  preparedSessionRoot?: string;
  /** Trusted catalog runtime must own selection checks before the new row is persisted. */
  preparedAgentRuntime?: string;
  archivedBy?: SessionEntry["archivedBy"];
  providerAuthMetadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
  /** Exact harness owner authorized to project its new reserved session row. */
  authorizedAgentHarnessId?: string;
  personalModelSelection?: UserModelAccountSelection;
  /** Linked defaults apply only to a new non-fork row selected by the creation owner. */
  personalAccountDefaults?: ModelAccountConnectAction;
  /** Resolved spawn identity supplied only by the trusted creation owner. */
  preparedModelSelection?: ModelRef;
  spawnModelAutoSelection?: AgentRuntimeSpawnModelAutoSelection;
  preparedExecution?: Extract<PreparedSessionExecutionSelection, { status: "ready" }>;
  initialExecutionSelection?: SessionExecutionSelection;
};

type SessionPatchProjectionResult =
  | {
      ok: true;
      entry: SessionEntry;
      execution?: Extract<PreparedSessionExecutionSelection, { status: "ready" }>;
    }
  | { ok: false; error: ErrorShape };

type SessionPatchPreparation =
  | { kind: "complete"; result: SessionPatchProjectionResult }
  | {
      kind: "model-catalog";
      finish: (catalog: ModelCatalogSnapshot | undefined) => Promise<SessionPatchProjectionResult>;
    };

/** Stop at the first actual catalog use without committing or acquiring runtime effects. */
export function prepareSessionsPatchEntry(
  params: SessionPatchProjectionParams,
): SessionPatchPreparation {
  const projection = projectSessionPatchSteps(params);
  const first = projection.next();
  if (first.done) {
    if ("request" in first.value) {
      throw new Error("Execution selection requires catalog preparation");
    }
    return { kind: "complete", result: first.value };
  }
  return {
    kind: "model-catalog",
    finish: async (catalog) => {
      const completed = projection.next(catalog);
      if (!completed.done) {
        throw new Error("Session patch preparation requested the catalog more than once");
      }
      if (!("request" in completed.value)) {
        return completed.value;
      }
      params.personalAccountDefaults?.assertCurrent();
      const prepared = await prepareSessionExecutionSelection({
        cfg: params.cfg,
        agentId: completed.value.agentId,
        sessionKey: params.storeKey,
        sessionEntry: completed.value.entry,
        modelCatalog: catalog?.entries,
        request: completed.value.request,
        modelInput: completed.value.modelInput,
        ...(params.personalAccountDefaults || completed.value.modelInput
          ? {
              replyAuth: {
                isNewSession: true,
                ...(params.personalAccountDefaults
                  ? { requesterProfileId: params.personalAccountDefaults.owner }
                  : {}),
              },
            }
          : {}),
      });
      params.personalAccountDefaults?.assertCurrent();
      if (prepared.status !== "ready") {
        return invalid(prepared.message);
      }
      return projectSessionsPatchEntry({
        ...params,
        preparedExecution: prepared,
        loadGatewayModelCatalogSnapshot: catalog ? async () => catalog : undefined,
      });
    },
  };
}

/** Project a validated gateway session patch for one session entry. */
export async function projectSessionsPatchEntry(
  params: SessionPatchProjectionParams & {
    loadGatewayModelCatalogSnapshot?: () => Promise<ModelCatalogSnapshot>;
  },
): Promise<SessionPatchProjectionResult> {
  const preparation = prepareSessionsPatchEntry(params);
  if (preparation.kind === "complete") {
    return preparation.result;
  }
  if (!params.loadGatewayModelCatalogSnapshot) {
    return preparation.finish(undefined);
  }
  const catalog = await params.loadGatewayModelCatalogSnapshot();
  return preparation.finish(catalog);
}

function* projectSessionPatchSteps(params: SessionPatchProjectionParams): Generator<
  void,
  | SessionPatchProjectionResult
  | {
      request: ExecutionSelectionRequest;
      entry: SessionEntry;
      agentId: string;
      modelInput?: { raw: string; resolvedRef?: ModelRef };
    },
  ModelCatalogSnapshot | undefined
> {
  const { cfg, storeKey, patch, creation } = params;
  if ("execSecurity" in patch || "execAsk" in patch) {
    return invalid(
      "execSecurity/execAsk are retired; set permissionMode (read-only|guarded|workspace|full) instead, or use /exec for this run only.",
    );
  }
  const authorizedHarnessCreation =
    params.existingEntry === undefined &&
    isAgentHarnessSessionKeyOwnedBy(storeKey, params.authorizedAgentHarnessId);
  const harnessSessionError = authorizedHarnessCreation
    ? undefined
    : resolveMissingAgentHarnessSessionError(storeKey, params.existingEntry);
  if (harnessSessionError) {
    return invalid(harnessSessionError);
  }
  if (typeof patch.archived === "boolean") {
    if (!params.existingEntry?.sessionId) {
      return invalid(`session not found: ${storeKey}`);
    }
    if (patch.expectedSessionId === undefined) {
      return invalid(`expectedSessionId required for session lifecycle patch: ${storeKey}`);
    }
  }
  if (
    ("model" in patch || "agentRuntime" in patch) &&
    isModelSelectionLocked(params.existingEntry)
  ) {
    return invalid(MODEL_SELECTION_LOCKED_MESSAGE);
  }
  if (typeof patch.agentRuntime === "string" && typeof patch.model !== "string") {
    return invalid("agentRuntime requires an explicit canonical provider/model selection");
  }
  const now = Date.now();
  const parsedAgent = parseAgentSessionKey(storeKey);
  const sessionAgentId = normalizeAgentId(
    params.agentId ?? parsedAgent?.agentId ?? resolveDefaultAgentId(cfg),
  );
  const resolvedDefault = resolveDefaultModelForAgent({ cfg, agentId: sessionAgentId });
  const subagentModelHint = isSubagentSessionKey(storeKey)
    ? resolveSubagentConfiguredModelSelection({ cfg, agentId: sessionAgentId })
    : undefined;
  const resolveThinkingRuntime = (
    provider: string,
    model: string,
    entry?: SessionEntry,
  ): string => {
    const selected = getSessionExecutionSelection(entry);
    return (
      params.preparedAgentRuntime ??
      (selected && isAcpExecutionSelection(selected) ? selected.executor.backend : undefined) ??
      resolveEffectiveAgentRuntimeCore({
        cfg,
        provider,
        modelId: model,
        agentId: sessionAgentId,
        sessionKey: storeKey,
        sessionEntry: entry,
      })
    );
  };
  let loadedModelCatalog: ModelCatalogSnapshot | undefined;
  let catalogPrepared = false;
  function* loadPreparedModelCatalogForPatch(): Generator<
    void,
    ModelCatalogEntry[] | undefined,
    ModelCatalogSnapshot | undefined
  > {
    if (!catalogPrepared) {
      loadedModelCatalog = yield;
      catalogPrepared = true;
    }
    return loadedModelCatalog?.entries;
  }
  function* loadThinkingProfileForPatch(
    provider: string,
    model: string,
    entry?: SessionEntry,
  ): Generator<void, ReturnType<typeof resolveThinkingProfile>, ModelCatalogSnapshot | undefined> {
    const catalog = yield* loadPreparedModelCatalogForPatch();
    const agentRuntime = resolveThinkingRuntime(provider, model, entry);
    const logical = catalog
      ? findModelCatalogEntry(catalog, { provider, modelId: model })
      : undefined;
    const selected =
      logical && loadedModelCatalog
        ? selectModelCatalogRuntimeEntry({
            entry: logical,
            routeVariants: loadedModelCatalog.routeVariants,
            runtimeId: agentRuntime,
          }).entry
        : undefined;
    return resolveThinkingProfile({
      provider,
      model,
      catalog: selected ? [selected] : catalog,
      agentRuntime,
    });
  }

  const existing =
    params.existingEntry && projectCanonicalSessionEntryShape({ ...params.existingEntry });
  // Existing entries without session ids are placeholder aliases; assigning an id makes them real.
  const next: SessionEntry = {
    ...existing,
    sessionId: existing?.sessionId || randomUUID(),
    // Reset retains sessionId, so rollback also needs the original lifecycle revision.
    ...(existing?.sessionId ? {} : { lifecycleRevision: randomUUID() }),
    updatedAt: Math.max(existing?.updatedAt ?? 0, now),
    ...(params.preparedSessionRoot ? { sessionRoot: params.preparedSessionRoot } : {}),
    // Stamp only genuinely new rows; existing placeholder aliases must not be restamped.
    ...(creation && params.existingEntry === undefined ? buildSessionCreationStamp(creation) : {}),
  };
  if (!existing?.executionSelection && params.initialExecutionSelection) {
    commitStoredSessionExecutionSelection(next, params.initialExecutionSelection);
  }
  if (existing && !existing.sessionId) {
    delete next.label;
    delete next.autoLabel;
    delete next.category;
    delete next.displayName;
  }

  const subagentPolicyError = applySessionsPatchSubagentPolicy({
    existing,
    next,
    patch,
    storeKey,
  });
  if (subagentPolicyError) {
    return invalid(subagentPolicyError);
  }

  const displayMetadataError = applySessionsPatchDisplayMetadata({
    patch,
    next,
    isLabelInUse: params.isLabelInUse,
  });
  if (displayMetadataError) {
    return invalid(displayMetadataError);
  }

  const agentStatusError = applySessionsPatchAgentStatus(patch, next, now);
  if (agentStatusError) {
    return invalid(agentStatusError);
  }

  const listStateError = applySessionsPatchListState({
    patch,
    next,
    storeKey,
    now,
    archivedBy: params.archivedBy,
  });
  if (listStateError) {
    return invalid(listStateError);
  }

  const rawThinking = patch.thinkingLevel;
  if (rawThinking === null) {
    delete next.thinkingLevel;
  } else if (rawThinking !== undefined) {
    const normalized = normalizeThinkLevel(rawThinking);
    if (!normalized) {
      const accepted = getSessionExecutionSelection(existing);
      const hintProvider =
        accepted && isModelExecutionSelection(accepted)
          ? accepted.model.provider
          : resolvedDefault.provider;
      const hintModel =
        accepted && accepted.model !== "native-managed" ? accepted.model.id : resolvedDefault.model;
      const profile = yield* loadThinkingProfileForPatch(hintProvider, hintModel, existing);
      return invalid(
        `invalid thinkingLevel (use ${profile.levels.map(({ label }) => label).join("|")})`,
      );
    }
    next.thinkingLevel = normalized;
  }

  const preferenceError = applySessionsPatchPreferences(patch, next);
  if (preferenceError) {
    return invalid(preferenceError);
  }
  if (
    typeof patch.agentRuntime === "string" &&
    getSessionExecutionSelection(existing)?.executor.kind === "acp"
  ) {
    return invalid("Runtime selection is owned by this ACP session.");
  }
  if (patch.model !== undefined || patch.agentRuntime !== undefined) {
    const agentModelFallback = isAgentSessionModelPatchOrigin()
      ? next.modelFallback?.source === "agent-patch"
        ? { ...next.modelFallback, ts: Math.max(now, next.modelFallback.ts + 1) }
        : snapshotAgentModelFallback(cfg, next, sessionAgentId, now)
      : undefined;
    delete next.modelFallback;
    const raw = patch.model;
    const runtimeOnlyReset = raw === undefined && patch.agentRuntime === null;
    const currentSelection = getSessionExecutionSelection(existing);
    if (typeof raw === "string" && !normalizeOptionalString(raw)) {
      return invalid("invalid model: empty");
    }
    const preparedAcp =
      params.preparedExecution && isAcpExecutionSelection(params.preparedExecution.selection)
        ? params.preparedExecution
        : undefined;
    if (typeof raw === "string" && params.spawnModelAutoSelection?.model === raw) {
      yield* loadPreparedModelCatalogForPatch();
      const prepared = params.preparedExecution;
      if (!prepared) {
        return {
          entry: next,
          agentId: sessionAgentId,
          request: { kind: "initialize" },
          modelInput: { raw, resolvedRef: params.preparedModelSelection },
        };
      }
      const error = prepared.validateCommit();
      if (error) {
        return invalid(error);
      }
      commitSessionExecutionSelection(next, prepared.selection, {
        cause: { kind: "initialize", fallbackPermission: prepared.fallbackPermission },
      });
      if (prepared.auth) {
        commitPreparedSessionAuthSelection(next, prepared.auth);
      }
    } else if (preparedAcp) {
      const error = preparedAcp.validateCommit();
      if (error) {
        return invalid(error);
      }
      commitSessionExecutionSelection(next, preparedAcp.selection, {
        cause: {
          kind:
            raw === null || (raw === undefined && patch.agentRuntime === null) ? "reset" : "user",
        },
        markLiveSwitchPending: true,
      });
    } else {
      const catalog = yield* loadPreparedModelCatalogForPatch();
      let selection:
        | { provider: string; model: string; profile?: string; isDefault: boolean }
        | undefined;
      if (raw === null || runtimeOnlyReset) {
        selection =
          runtimeOnlyReset && currentSelection && isModelExecutionSelection(currentSelection)
            ? {
                provider: currentSelection.model.provider,
                model: currentSelection.model.id,
                isDefault: false,
              }
            : { ...resolvedDefault, isDefault: true };
      } else if (raw !== undefined) {
        const trimmed = normalizeOptionalString(raw) ?? "";
        if (!trimmed) {
          return invalid("invalid model: empty");
        }
        if (!catalog) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.UNAVAILABLE,
              "model catalog is still loading; retry in a few seconds",
            ),
          };
        }
        const resolved = resolveSessionPatchModelSelection({
          cfg,
          agentId: sessionAgentId,
          catalog,
          raw: trimmed,
          defaultProvider: resolvedDefault.provider,
          defaultModel: resolvedDefault.model,
          subagentModelHint,
          preparedModelSelection: params.preparedModelSelection,
        });
        if (!resolved.ok) {
          return invalid(resolved.error);
        }
        selection = resolved;
      }
      if (selection) {
        if (typeof patch.agentRuntime === "string") {
          if (
            splitTrailingAuthProfile(raw ?? "").model !== `${selection.provider}/${selection.model}`
          ) {
            return invalid("agentRuntime requires an explicit canonical provider/model selection");
          }
          const runtime = normalizeOptionalAgentRuntimeId(patch.agentRuntime);
          if (runtime !== patch.agentRuntime || isDefaultAgentRuntimeId(runtime)) {
            return invalid("Use a canonical agentRuntime id, or null to reset configured routing");
          }
        }
        if (selection.profile && isUserModelAuthProfileId(selection.profile)) {
          if (params.personalModelSelection?.authProfileId !== selection.profile) {
            return {
              ok: false,
              error: errorShape(
                ErrorCodes.FORBIDDEN,
                "Choose your personal account from an identified Gateway connection.",
              ),
            };
          }
          params.personalModelSelection.assertCurrent();
        }
        const runtimeId =
          typeof patch.agentRuntime === "string" ? patch.agentRuntime : params.preparedAgentRuntime;
        const executorKind = runtimeId
          ? resolveExecutionSelectionExecutorKind(cfg, runtimeId)
          : undefined;
        if (runtimeId && !executorKind) {
          return invalid(
            "Could not confirm support for the selected app. Your selection is unchanged.",
          );
        }
        if (!params.preparedExecution) {
          return {
            entry: selection.profile
              ? {
                  ...next,
                  authProfileOverride: selection.profile,
                  authProfileOverrideSource: "user",
                  authProfileOverrideCompactionCount: undefined,
                }
              : next,
            agentId: sessionAgentId,
            request:
              raw === null
                ? { kind: "reset" }
                : patch.agentRuntime === null
                  ? { kind: "reset", model: { provider: selection.provider, id: selection.model } }
                  : {
                      kind: "model",
                      model: { provider: selection.provider, id: selection.model },
                      ...(runtimeId && executorKind
                        ? { executor: { kind: executorKind, id: runtimeId } }
                        : {}),
                    },
          };
        }
        const prepared = params.preparedExecution;
        const validationError = prepared.validateCommit?.();
        if (validationError) {
          return invalid(validationError);
        }
        if (isAcpExecutionSelection(prepared.selection)) {
          throw new Error("Expected model execution selection");
        }
        commitSessionModelSelectionWithAuth({
          cfg,
          agentId: sessionAgentId,
          entry: next,
          currentProvider:
            currentSelection && isModelExecutionSelection(currentSelection)
              ? currentSelection.model.provider
              : resolvedDefault.provider,
          selection: prepared.selection,
          profileOverride: selection.profile,
          ...(params.providerAuthMetadataSnapshot
            ? { metadataSnapshot: params.providerAuthMetadataSnapshot }
            : {}),
          markLiveSwitchPending: true,
          cause: runtimeOnlyReset
            ? { kind: "inherit", entry: existing ?? {} }
            : { kind: raw === null ? "reset" : "user" },
        });
        if (
          params.personalAccountDefaults &&
          prepared.auth?.state.authProfileOverrideSource === "user-link"
        ) {
          commitPreparedSessionAuthSelection(next, prepared.auth);
        }
      }
    }
    if (agentModelFallback) {
      next.modelFallback = agentModelFallback;
    }
  }

  if ("thinkingLevel" in patch || "model" in patch || "agentRuntime" in patch) {
    const accepted = getSessionExecutionSelection(next);
    const effectiveProvider =
      accepted && isModelExecutionSelection(accepted)
        ? accepted.model.provider
        : resolvedDefault.provider;
    const effectiveModel =
      accepted && accepted.model !== "native-managed" ? accepted.model.id : resolvedDefault.model;
    const thinkingLevel = normalizeThinkLevel(next.thinkingLevel);
    if (!thinkingLevel) {
      delete next.thinkingLevel;
    } else {
      const profile = yield* loadThinkingProfileForPatch(effectiveProvider, effectiveModel, next);
      if ("thinkingLevel" in patch && !profile.levels.some(({ id }) => id === thinkingLevel)) {
        return invalid(
          `thinkingLevel "${thinkingLevel}" is not supported for ${effectiveProvider}/${effectiveModel} (use ${profile.levels.map(({ label }) => label).join("|")})`,
        );
      }
      next.thinkingLevel = resolveSupportedThinkingLevelFromProfile(profile, thinkingLevel);
    }
  }

  const contextWindowPatch = yield* applySessionContextWindowPatch({
    defaultModel: resolvedDefault.model,
    defaultProvider: resolvedDefault.provider,
    loadModelCatalog: loadPreparedModelCatalogForPatch,
    runtimeId: resolveThinkingRuntime,
    routeVariants: () => loadedModelCatalog?.routeVariants,
    next,
    patch,
  });
  if (!contextWindowPatch.ok) {
    return invalid(contextWindowPatch.error);
  }

  // Independent preference changes must survive a later model rollback. Copy
  // the marker so previews and prepared patches keep their input snapshot intact.
  if (
    next.modelFallback?.source === "agent-patch" &&
    !("model" in patch) &&
    ("thinkingLevel" in patch || "contextWindow" in patch)
  ) {
    next.modelFallback = {
      ...next.modelFallback,
      ...("thinkingLevel" in patch ? { prevThinkingLevel: next.thinkingLevel } : {}),
      ...("contextWindow" in patch ? { prevContextWindow: next.contextWindow } : {}),
    };
  }

  if ("sendPolicy" in patch) {
    const raw = patch.sendPolicy;
    if (raw === null) {
      delete next.sendPolicy;
    } else if (raw !== undefined) {
      const normalized = normalizeSendPolicy(raw);
      if (!normalized) {
        return invalid('invalid sendPolicy (use "allow"|"deny")');
      }
      next.sendPolicy = normalized;
    }
  }

  if ("groupActivation" in patch) {
    const raw = patch.groupActivation;
    if (raw === null) {
      delete next.groupActivation;
    } else if (raw !== undefined) {
      const normalized = normalizeGroupActivation(raw);
      if (!normalized) {
        return invalid('invalid groupActivation (use "mention"|"always")');
      }
      next.groupActivation = normalized;
    }
  }

  // Fresh rows and placeholder aliases have no running model to replace. Model
  // and context-window initialization must not queue a switch on their first turn.
  if (!existing?.sessionId) {
    delete next.liveModelSwitchPending;
  }

  const execution = params.preparedExecution;
  return {
    ok: true,
    entry: next,
    ...(execution
      ? {
          execution: {
            ...execution,
            validateCommit: () => {
              params.personalModelSelection?.assertCurrent();
              params.personalAccountDefaults?.assertCurrent();
              return execution.validateCommit?.();
            },
          },
        }
      : {}),
  };
}
