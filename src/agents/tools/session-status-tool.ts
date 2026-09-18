/**
 * session_status built-in tool.
 *
 * Reports and updates session runtime state, model overrides, visibility, task status, and delivery context.
 */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type {
  ElevatedLevel,
  ReasoningLevel,
  ThinkLevel,
  VerboseLevel,
} from "../../auto-reply/thinking.js";
import {
  patchSessionEntryWithKey,
  resolveSessionStorePathCore,
  type SessionEntry,
} from "../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import {
  prepareSessionExecutionSelection,
  applySessionExecutionSelection,
  commitSessionModelSelectionWithAuth,
  executionSelectionTransactionChanged,
} from "../../model-picker/apply-session-model-selection.js";
import {
  getSessionExecutionSelection,
  isAcpExecutionSelection,
  isModelExecutionSelection,
} from "../../model-picker/execution-selection.js";
import {
  isPluginMetadataSnapshotCompatible,
  resolvePluginMetadataSnapshot,
} from "../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import {
  buildAgentMainSessionKey,
  isIncognitoSessionKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import {
  isModelSelectionLocked,
  ModelSelectionLockedError,
} from "../../sessions/model-overrides.js";
import {
  getSessionStateVersion,
  listSessionStateEventsSince,
} from "../../sessions/session-state-events.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { BuildStatusTextParams } from "../../status/status-text.types.js";
import { buildTaskStatusSnapshotForRelatedSessionKeyForOwner } from "../../tasks/task-owner-access.js";
import {
  formatTaskStatus,
  formatTaskStatusDetail,
  formatTaskStatusTitle,
} from "../../tasks/task-status.js";
import {
  sessionDeliveryChannel,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentIds,
} from "../agent-scope.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../model-selection.js";
import { resolveThinkingDefault } from "../model-thinking-default.js";
import { loadPublishedPreparedModelCatalog } from "../prepared-model-catalog.js";
import {
  resolveSessionModelRefCore as resolveSessionModelRef,
  resolveSessionModelIdentityRef,
} from "../session-model-ref.js";
import {
  describeSessionStatusTool,
  SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import {
  normalizeToolModelOverride,
  readNonNegativeIntegerParam,
  readToolStringParam,
} from "./common.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import {
  resolveSessionToolTargetAgentId,
  runWithScopedSessionAccess,
} from "./scoped-session-access.js";
import {
  SessionStatusOutputSchema,
  buildSessionStatusRouteDetails,
  compactSessionStateChanges,
  formatSessionStateChanges,
  formatSessionStatusRouteContext,
} from "./session-status-projection.js";
import {
  listImplicitDefaultDirectFallbackKeys,
  resolveImplicitCurrentSessionFallback,
  resolveSessionStatusEntry,
  resolveStoreScopedRequesterKey,
} from "./session-status-session-resolve.js";
import {
  formatSessionToolAccessDenial,
  resolveCurrentSessionClientAlias,
  resolveSessionReference,
  resolveSessionToolAccess,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
  shouldResolveSessionIdInput,
} from "./sessions-helpers.js";

const SessionStatusToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  changesSince: Type.Optional(Type.Integer({ minimum: 0 })),
});

type CommandsStatusRuntimeModule = {
  buildStatusText: (params: BuildStatusTextParams) => Promise<string>;
};

const commandsStatusRuntimeLoader = createLazyImportLoader<CommandsStatusRuntimeModule>(
  () => import("../../status/status-text.js") as Promise<CommandsStatusRuntimeModule>,
);

function loadCommandsStatusRuntime(): Promise<CommandsStatusRuntimeModule> {
  return commandsStatusRuntimeLoader.load();
}

type ActiveStatusModelIdentity = { provider?: string; model: string };

function resolveActiveStatusModelIdentity(params: {
  activeModelId?: string;
  activeModelProvider?: string;
  isImplicitCurrentRequest: boolean;
  isSemanticCurrentRequest: boolean;
  liveSessionKeys: Iterable<string | undefined>;
  modelRaw?: string;
  resolvedKey: string;
  resolvedAgentId: string;
  requesterAgentId: string;
}): ActiveStatusModelIdentity | undefined {
  const activeModelId = params.activeModelId?.trim();
  if (!activeModelId || params.modelRaw !== undefined) {
    return undefined;
  }
  if (!params.isSemanticCurrentRequest && !params.isImplicitCurrentRequest) {
    return undefined;
  }
  if (params.resolvedAgentId !== params.requesterAgentId) {
    return undefined;
  }
  const resolvedKey = params.resolvedKey.trim();
  const liveSessionKeys = new Set(
    Array.from(params.liveSessionKeys, (value) => value?.trim()).filter((value): value is string =>
      Boolean(value),
    ),
  );
  if (!liveSessionKeys.has(resolvedKey)) {
    return undefined;
  }
  const activeModelProvider = params.activeModelProvider?.trim();
  return activeModelProvider
    ? { provider: activeModelProvider, model: activeModelId }
    : { model: activeModelId };
}

function formatSessionTaskLine(params: {
  relatedSessionKey: string;
  callerOwnerKey: string;
  callerAgentId: string;
  config: OpenClawConfig;
}): string | undefined {
  const snapshot = buildTaskStatusSnapshotForRelatedSessionKeyForOwner({
    relatedSessionKey: params.relatedSessionKey,
    callerOwnerKey: params.callerOwnerKey,
    callerAgentId: params.callerAgentId,
    config: params.config,
  });
  const task = snapshot.focus;
  if (!task) {
    return undefined;
  }
  const headline =
    snapshot.activeCount > 0
      ? `${snapshot.activeCount} active`
      : snapshot.recentFailureCount > 0
        ? `${snapshot.recentFailureCount} recent failure${snapshot.recentFailureCount === 1 ? "" : "s"}`
        : `latest ${formatTaskStatus(task).replaceAll("_", " ")}`;
  const title = formatTaskStatusTitle(task);
  const detail = formatTaskStatusDetail(task);
  const blocked = formatTaskStatus(task) === "blocked" ? "blocked" : undefined;
  const parts = [headline, blocked, task.runtime, title, detail].filter(Boolean);
  return parts.length ? `📌 Tasks: ${parts.join(" · ")}` : undefined;
}

async function resolveModelOverride(params: {
  cfg: OpenClawConfig;
  raw: string;
  sessionEntry?: SessionEntry;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  metadataSnapshot?: PluginMetadataSnapshot;
}): Promise<
  | { kind: "reset"; catalog: Awaited<ReturnType<typeof loadPublishedPreparedModelCatalog>> }
  | {
      kind: "set";
      provider: string;
      model: string;
      catalog: Awaited<ReturnType<typeof loadPublishedPreparedModelCatalog>>;
    }
> {
  const raw = normalizeToolModelOverride(params.raw);
  const { provider: currentProvider } = resolveSessionModelRef(
    params.cfg,
    params.sessionEntry,
    params.agentId,
  );

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: currentProvider,
  });
  const catalog = await loadPublishedPreparedModelCatalog({
    config: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
    readOnly: true,
    ...(params.sessionEntry?.spawnedWorkspaceDir
      ? { workspaceDir: params.sessionEntry.spawnedWorkspaceDir }
      : {}),
  });
  if (!raw) {
    return { kind: "reset", catalog };
  }
  const workspaceDir = params.sessionEntry?.spawnedWorkspaceDir ?? params.workspaceDir;
  const manifestMetadataSnapshot =
    params.metadataSnapshot &&
    params.metadataSnapshot.pluginIds === undefined &&
    isPluginMetadataSnapshotCompatible({
      snapshot: params.metadataSnapshot,
      config: params.cfg,
      env: process.env,
      workspaceDir,
    })
      ? params.metadataSnapshot
      : resolvePluginMetadataSnapshot({
          config: params.cfg,
          ...(workspaceDir ? { workspaceDir } : {}),
          env: process.env,
        });
  const modelManifestContext = {
    manifestPlugins: manifestMetadataSnapshot,
  };

  const resolved = resolveModelRefFromString({
    cfg: params.cfg,
    agentId: params.agentId,
    raw,
    defaultProvider: currentProvider,
    aliasIndex,
    allowManifestNormalization: true,
    allowPluginNormalization: true,
    ...modelManifestContext,
  });
  if (!resolved) {
    throw new Error(`Unrecognized model "${raw}".`);
  }
  return {
    kind: "set",
    provider: resolved.ref.provider,
    model: resolved.ref.model,
    catalog,
  };
}

export function createSessionStatusTool(opts?: {
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
  /**
   * The actual live run session key. When the tool is constructed with a sandbox/policy
   * session key (e.g. a Telegram direct peer key), this allows `session_status({sessionKey:
   * "current"})` to resolve to the live run session instead of the stale sandbox key.
   */
  runSessionKey?: string;
  config?: OpenClawConfig;
  sandboxed?: boolean;
  activeModelProvider?: string;
  activeModelId?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
  callGateway?: AgentToolGatewayRequestCaller;
  /** Active live-run route, kept separate from the persisted/origin delivery route. */
  activeDeliveryContext?: DeliveryContext;
}): AnyAgentTool {
  return {
    label: "Session Status",
    name: "session_status",
    displaySummary: SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
    description: describeSessionStatusTool(),
    parameters: SessionStatusToolSchema,
    outputSchema: SessionStatusOutputSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = args as Record<string, unknown>;
      const gatewayCall = opts?.callGateway ?? callAgentToolGatewayRequest;
      const changesSince = readNonNegativeIntegerParam(params, "changesSince");
      const {
        cfg,
        mainKey,
        alias,
        effectiveRequesterKey,
        mainSessionKey,
        restrictToSpawned,
        sessionVisibility,
        a2aPolicy,
      } = resolveSessionToolContext(opts);
      const requesterAgentId = resolveSessionAgentIds({
        config: cfg,
        sessionKey: opts?.agentSessionKey ?? effectiveRequesterKey,
        agentId: opts?.requesterAgentIdOverride,
      }).sessionAgentId;
      const configuredDefaultAgentId = requesterAgentId;
      const visibilityRequesterKey = (opts?.agentSessionKey ?? effectiveRequesterKey).trim();
      const usesLegacyMainAlias = alias === mainKey;
      const isLegacyMainVisibilityKey = (sessionKey: string) => {
        const trimmed = sessionKey.trim();
        return usesLegacyMainAlias && (trimmed === "main" || trimmed === mainKey);
      };
      const resolveVisibilityMainSessionKey = (sessionAgentId: string) => {
        const requesterParsed = parseAgentSessionKey(visibilityRequesterKey);
        if (
          resolveAgentIdFromSessionKey(visibilityRequesterKey, configuredDefaultAgentId) ===
            sessionAgentId &&
          (requesterParsed?.rest === mainKey || isLegacyMainVisibilityKey(visibilityRequesterKey))
        ) {
          return visibilityRequesterKey;
        }
        return buildAgentMainSessionKey({
          agentId: sessionAgentId,
          mainKey,
        });
      };
      const normalizeVisibilityTargetSessionKey = (sessionKey: string, sessionAgentId: string) => {
        const trimmed = sessionKey.trim();
        if (!trimmed) {
          return trimmed;
        }
        if (trimmed.startsWith("agent:")) {
          const parsed = parseAgentSessionKey(trimmed);
          if (parsed?.rest === mainKey) {
            return resolveVisibilityMainSessionKey(sessionAgentId);
          }
          return trimmed;
        }
        // Preserve legacy bare main keys for requester tree checks.
        if (isLegacyMainVisibilityKey(trimmed)) {
          return resolveVisibilityMainSessionKey(sessionAgentId);
        }
        return trimmed;
      };
      const accessByTarget = new Map<
        string,
        Awaited<ReturnType<typeof resolveSessionToolAccess>>
      >();
      const checkVisibilityAccess = async (target: {
        targetSessionKey: string;
        targetAgentId: string;
        authorizationTargetSessionKey: string;
        requesterOwned: boolean;
      }) => {
        const cacheKey = `${target.requesterOwned ? "owned" : "unowned"}:${target.targetAgentId}:${target.targetSessionKey}:${target.authorizationTargetSessionKey}`;
        const cached = accessByTarget.get(cacheKey);
        if (cached) {
          return cached;
        }
        const access = await resolveSessionToolAccess({
          action: "status",
          requesterAgentId,
          requesterSessionKey: visibilityRequesterKey,
          mainSessionKey,
          authorizationTargetSessionKey: target.authorizationTargetSessionKey,
          targetAgentId: target.targetAgentId,
          targetSessionKey: target.targetSessionKey,
          requesterOwned: target.requesterOwned,
          visibility: sessionVisibility,
          a2aPolicy,
          callGateway: gatewayCall,
        });
        accessByTarget.set(cacheKey, access);
        return access;
      };

      const requestedKeyParam = readToolStringParam(params, "sessionKey");
      const isImplicitRunSessionStatus =
        requestedKeyParam === undefined && Boolean(opts?.runSessionKey?.trim());
      let requestedKeyRaw = requestedKeyParam ?? opts?.agentSessionKey;

      // No-arg status should prefer the live run session when available (#82669).
      if (isImplicitRunSessionStatus) {
        requestedKeyRaw = opts?.runSessionKey;
      }
      let requestedKeyInput = requestedKeyRaw?.trim() ?? "";

      // Track whether this is a semantic-current request (literal "current" or a
      // current-client alias) BEFORE any rewrite, so visibility treats it as self.
      const isSemanticCurrentRequest =
        requestedKeyInput === "current" ||
        isImplicitRunSessionStatus ||
        Boolean(
          resolveCurrentSessionClientAlias({
            key: requestedKeyInput,
            requesterInternalKey: effectiveRequesterKey,
          }),
        );

      // Resolve semantic "current" to the live run session key for lookup purposes (#76708).
      // In sandboxed channel runs there may be no separate runSessionKey because the sandbox
      // key already is the live requester; avoid probing literal "current" through the gateway.
      if (requestedKeyInput === "current" && (opts?.runSessionKey || opts?.sandboxed === true)) {
        requestedKeyRaw = opts.runSessionKey ?? effectiveRequesterKey;
        requestedKeyInput = requestedKeyRaw?.trim() ?? "";
      }

      const currentSessionAlias = resolveCurrentSessionClientAlias({
        key: requestedKeyInput,
        requesterInternalKey: effectiveRequesterKey,
      });
      if (currentSessionAlias) {
        requestedKeyRaw = opts?.runSessionKey ?? currentSessionAlias;
        requestedKeyInput = requestedKeyRaw?.trim() ?? "";
      }
      const effectiveRequesterLookupKey = effectiveRequesterKey.trim();
      let resolvedViaSessionId = false;
      let resolvedViaImplicitCurrentFallback = false;
      if (!requestedKeyInput) {
        throw new Error("sessionKey required");
      }
      requestedKeyRaw = requestedKeyInput;
      let resolvedRequesterOwned = false;

      const deferTargetOwnerResolution =
        !isSemanticCurrentRequest && shouldResolveSessionIdInput(requestedKeyInput);
      let agentId = deferTargetOwnerResolution
        ? requesterAgentId
        : resolveSessionToolTargetAgentId({
            cfg,
            targetSessionKey: requestedKeyInput,
            requesterAgentId,
          });
      // Semantic current is self for ordinary visibility, but its live-run key can
      // still be process-only. Preserve that target for the shared guard before storage.
      const mustCheckRequestedKeyBeforeStore =
        !isSemanticCurrentRequest || isIncognitoSessionKey(requestedKeyInput);
      if (mustCheckRequestedKeyBeforeStore && !deferTargetOwnerResolution) {
        const access = await checkVisibilityAccess({
          targetSessionKey: requestedKeyInput,
          targetAgentId: agentId,
          authorizationTargetSessionKey: normalizeVisibilityTargetSessionKey(
            requestedKeyInput,
            agentId,
          ),
          requesterOwned: false,
        });
        if (!access.allowed) {
          throw new Error(
            formatSessionToolAccessDenial(access, {
              action: "status",
              targetSessionKey: requestedKeyInput,
            }),
          );
        }
      }
      let storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
      let storeScopedRequesterKey = resolveStoreScopedRequesterKey({
        requesterKey: effectiveRequesterKey,
        agentId,
        mainKey,
      });

      // Resolve against the requester-scoped store first to avoid leaking default agent data.
      let resolved = deferTargetOwnerResolution
        ? undefined
        : resolveSessionStatusEntry({
            cfg,
            agentId,
            keyRaw: requestedKeyRaw,
            alias,
            mainKey,
            requesterInternalKey: storeScopedRequesterKey,
            includeAliasFallback: requestedKeyInput !== "current",
          });

      if (
        !resolved &&
        (requestedKeyInput === "current" || shouldResolveSessionIdInput(requestedKeyInput))
      ) {
        const resolvedSession = await resolveSessionReference({
          action: "status",
          sessionKey: requestedKeyInput,
          ...(requestedKeyInput === "current" ? { agentId: requesterAgentId } : {}),
          keyAgentId: requesterAgentId,
          alias,
          mainKey,
          requesterInternalKey: effectiveRequesterKey,
          restrictToSpawned,
          callGateway: gatewayCall,
        });
        if (resolvedSession.ok) {
          const visibleSession = await resolveVisibleSessionReference({
            action: "status",
            resolvedSession,
            requesterSessionKey: effectiveRequesterKey,
            requesterAgentId,
            restrictToSpawned: opts?.sandboxed === true,
            visibilitySessionKey: requestedKeyInput,
            callGateway: gatewayCall,
          });
          if (!visibleSession.ok) {
            // The resolver's copy already names the denying policy (including the
            // watched-group carve-out); a local string here would drift from it.
            throw new Error(visibleSession.error);
          }
          const visibleAgentId = resolveSessionToolTargetAgentId({
            cfg,
            targetSessionKey: visibleSession.key,
            resolvedAgentId: visibleSession.agentId,
            requesterAgentId,
          });
          if (opts?.sandboxed === true || visibleAgentId !== requesterAgentId) {
            const access = await checkVisibilityAccess({
              targetSessionKey: visibleSession.key,
              targetAgentId: visibleAgentId,
              authorizationTargetSessionKey: normalizeVisibilityTargetSessionKey(
                visibleSession.key,
                visibleAgentId,
              ),
              requesterOwned: visibleSession.requesterOwned,
            });
            if (!access.allowed) {
              throw new Error(
                formatSessionToolAccessDenial(access, {
                  action: "status",
                  targetSessionKey: visibleSession.displayKey,
                }),
              );
            }
          }
          resolvedRequesterOwned = visibleSession.requesterOwned;
          resolvedViaSessionId = resolvedSession.resolvedViaSessionId;
          requestedKeyRaw = visibleSession.key;
          requestedKeyInput = requestedKeyRaw.trim();
          agentId = visibleAgentId;
          storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
          storeScopedRequesterKey = resolveStoreScopedRequesterKey({
            requesterKey: effectiveRequesterKey,
            agentId,
            mainKey,
          });
          resolved = resolveSessionStatusEntry({
            cfg,
            agentId,
            keyRaw: requestedKeyRaw,
            alias,
            mainKey,
            requesterInternalKey: storeScopedRequesterKey,
          });
        } else if (
          !resolvedSession.ok &&
          (!resolvedSession.notFound || resolvedSession.status === "forbidden")
        ) {
          throw new Error(resolvedSession.error);
        }
      }

      if (!resolved && requestedKeyInput === "current" && effectiveRequesterLookupKey) {
        resolved = resolveSessionStatusEntry({
          cfg,
          agentId,
          keyRaw: effectiveRequesterLookupKey,
          alias,
          mainKey,
          requesterInternalKey: storeScopedRequesterKey,
          includeAliasFallback: false,
        });
      }

      if (!resolved && requestedKeyInput === "current") {
        resolved = resolveSessionStatusEntry({
          cfg,
          agentId,
          keyRaw: requestedKeyRaw,
          alias,
          mainKey,
          requesterInternalKey: storeScopedRequesterKey,
          includeAliasFallback: true,
        });
      }

      if (!resolved && requestedKeyParam === undefined) {
        for (const fallbackKey of listImplicitDefaultDirectFallbackKeys({
          keyRaw: requestedKeyRaw,
          mainKey,
        })) {
          resolved = resolveSessionStatusEntry({
            cfg,
            agentId,
            keyRaw: fallbackKey,
            alias,
            mainKey,
            requesterInternalKey: storeScopedRequesterKey,
            includeAliasFallback: true,
          });
          if (resolved) {
            resolvedViaImplicitCurrentFallback = true;
            break;
          }
        }
      }

      if (!resolved) {
        const runSessionFallbackKey = opts?.runSessionKey?.trim();
        const fallback = resolveImplicitCurrentSessionFallback({
          agentId,
          allowFallback: isSemanticCurrentRequest || requestedKeyParam === undefined,
          cfg,
          fallbackKey:
            (isSemanticCurrentRequest || isImplicitRunSessionStatus) && runSessionFallbackKey
              ? runSessionFallbackKey
              : isSemanticCurrentRequest
                ? effectiveRequesterLookupKey
                : storeScopedRequesterKey,
        });
        if (fallback) {
          resolved = fallback;
          resolvedViaImplicitCurrentFallback = true;
        }
      }

      if (!resolved) {
        const kind = shouldResolveSessionIdInput(requestedKeyInput) ? "sessionId" : "sessionKey";
        throw new Error(`Unknown ${kind}: ${requestedKeyInput}`);
      }

      // Preserve caller-scoped raw-key/current lookups as "self" for visibility checks.
      const shouldTreatVisibilityTargetAsSelf =
        isSemanticCurrentRequest ||
        resolvedViaImplicitCurrentFallback ||
        (!resolvedViaSessionId &&
          (requestedKeyInput === "current" ||
            (resolved.key === requestedKeyInput && agentId === requesterAgentId)));
      const visibilityTargetKey =
        shouldTreatVisibilityTargetAsSelf && !isIncognitoSessionKey(resolved.key)
          ? visibilityRequesterKey
          : normalizeVisibilityTargetSessionKey(resolved.key, agentId);
      const access = await checkVisibilityAccess({
        targetSessionKey: resolved.key,
        targetAgentId: agentId,
        authorizationTargetSessionKey: visibilityTargetKey,
        requesterOwned: resolvedRequesterOwned,
      });
      if (!access.allowed) {
        throw new Error(
          formatSessionToolAccessDenial(access, {
            action: "status",
            targetSessionKey: requestedKeyInput,
          }),
        );
      }
      let scopedResolved = resolved;

      return await runWithScopedSessionAccess({
        cfg,
        agentId,
        expectedSessionId:
          access.expectedSessionId ??
          (scopedResolved.persisted ? scopedResolved.entry.sessionId : undefined),
        signal,
        targetSessionKey: scopedResolved.key,
        run: async (assertCurrentAccess) => {
          const configured = resolveDefaultModelForAgent({ cfg, agentId });
          const selectedAgentDir = resolveAgentDir(cfg, agentId);
          const selectedWorkspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
          const modelRaw = readToolStringParam(params, "model");
          let changedModel = false;
          let resetModelRequested = false;
          let modelChangeMessage: string | undefined;
          if (typeof modelRaw === "string") {
            const initialEntry = { ...scopedResolved.entry };
            if (isModelSelectionLocked(initialEntry)) {
              throw new ModelSelectionLockedError();
            }
            const accepted = getSessionExecutionSelection(initialEntry);
            const assertCurrentSelectionAccess = () => {
              assertCurrentAccess();
              const current = scopedResolved.persisted
                ? loadSessionEntryReadOnly({
                    agentId,
                    storePath,
                    sessionKey: scopedResolved.key,
                    readConsistency: "latest",
                  })
                : scopedResolved.entry;
              if (
                !current ||
                current.sessionId !== initialEntry.sessionId ||
                current.lifecycleRevision !== initialEntry.lifecycleRevision
              ) {
                throw new Error("Session changed while selecting a model.");
              }
              if (isModelSelectionLocked(current)) {
                throw new ModelSelectionLockedError();
              }
            };
            if (accepted && isAcpExecutionSelection(accepted)) {
              const model = normalizeToolModelOverride(modelRaw);
              resetModelRequested = !model;
              const applied = await applySessionExecutionSelection({
                cfg,
                agentId,
                sessionKey: scopedResolved.key,
                storePath,
                sessionEntry: initialEntry,
                request: {
                  kind: "selection",
                  selection: { ...accepted, model: model ? { id: model } : "native-managed" },
                },
                validateCommit: () => {
                  assertCurrentSelectionAccess();
                  return undefined;
                },
              });
              if (applied.status !== "applied") {
                throw new Error(applied.message);
              }
              const current = loadSessionEntryReadOnly({
                agentId,
                storePath,
                sessionKey: scopedResolved.key,
                readConsistency: "latest",
              });
              if (!current) {
                throw new Error(`Unknown sessionKey: ${scopedResolved.key}`);
              }
              scopedResolved = { entry: current, key: scopedResolved.key, persisted: true };
              changedModel = applied.changed;
              modelChangeMessage = applied.message;
            } else {
              const parsed = await resolveModelOverride({
                cfg,
                raw: modelRaw,
                sessionEntry: initialEntry,
                agentId,
                agentDir: selectedAgentDir,
                workspaceDir: selectedWorkspaceDir,
                metadataSnapshot: opts?.metadataSnapshot,
              });
              resetModelRequested = parsed.kind === "reset";
              const prepared = await prepareSessionExecutionSelection({
                cfg,
                agentId,
                sessionKey: scopedResolved.key,
                storePath,
                sessionEntry: initialEntry,
                modelCatalog: parsed.catalog,
                request:
                  parsed.kind === "reset"
                    ? { kind: "reset" }
                    : { kind: "model", model: { provider: parsed.provider, id: parsed.model } },
              });
              if (prepared.status !== "ready") {
                throw new Error(prepared.message);
              }
              if (isAcpExecutionSelection(prepared.selection)) {
                throw new Error("The selected app changed while selecting a model.");
              }
              const selection = prepared.selection;
              const currentProvider =
                accepted && isModelExecutionSelection(accepted)
                  ? accepted.model.provider
                  : resolveSessionModelRef(cfg, initialEntry, agentId).provider;
              const patchResult = await patchSessionEntryWithKey(
                { agentId, sessionKey: scopedResolved.key, storePath },
                (entry, context) => {
                  assertCurrentAccess();
                  if (isModelSelectionLocked(entry)) {
                    throw new ModelSelectionLockedError();
                  }
                  if (
                    context.existingEntry &&
                    (entry.sessionId !== initialEntry.sessionId ||
                      entry.lifecycleRevision !== initialEntry.lifecycleRevision ||
                      executionSelectionTransactionChanged(initialEntry, entry))
                  ) {
                    throw new Error("Session model selection changed. Try again.");
                  }
                  const next: SessionEntry = { ...entry };
                  const applied = commitSessionModelSelectionWithAuth({
                    cfg,
                    agentId,
                    entry: next,
                    currentProvider,
                    selection,
                    markLiveSwitchPending: true,
                    cause: {
                      kind: parsed.kind === "reset" ? "reset" : "user",
                    },
                  });
                  changedModel = applied.changed;
                  if (applied.changed) {
                    next.updatedAt = Date.now();
                  }
                  if (!next.sessionId.trim() && !context.existingEntry?.sessionId?.trim()) {
                    next.sessionId = randomUUID();
                  }
                  return next;
                },
                {
                  fallbackEntry: scopedResolved.persisted ? undefined : initialEntry,
                  replaceEntry: true,
                  assertCommitAllowed: () => {
                    assertCurrentAccess();
                    const error = prepared.validateCommit();
                    if (error) {
                      throw new Error(error);
                    }
                  },
                },
              );
              if (!patchResult) {
                throw new Error(`Unknown sessionKey: ${scopedResolved.key}`);
              }
              scopedResolved = {
                entry: patchResult.entry,
                key: patchResult.sessionKey,
                persisted: true,
              };
              modelChangeMessage = prepared.message;
            }
            if (changedModel) {
              triggerSessionPatchHook({
                cfg,
                sessionEntry: scopedResolved.entry,
                sessionKey: scopedResolved.key,
                patch: { key: scopedResolved.key, model: resetModelRequested ? null : modelRaw },
              });
            }
          }

          const activeModelId = opts?.activeModelId?.trim();
          const activeModelProvider = opts?.activeModelProvider?.trim();
          const isImplicitCurrentRequest = requestedKeyParam === undefined;
          const liveSessionKeys = [
            opts?.runSessionKey,
            storeScopedRequesterKey,
            effectiveRequesterKey,
            visibilityRequesterKey,
          ];
          const activeModelIdentity = resolveActiveStatusModelIdentity({
            activeModelId,
            activeModelProvider,
            isImplicitCurrentRequest,
            isSemanticCurrentRequest,
            liveSessionKeys,
            modelRaw,
            resolvedKey: scopedResolved.key,
            resolvedAgentId: agentId,
            requesterAgentId,
          });
          const runtimeModelIdentity = activeModelIdentity
            ? activeModelIdentity
            : resolveSessionModelIdentityRef(
                cfg,
                scopedResolved.entry,
                agentId,
                `${configured.provider}/${configured.model}`,
              );
          const statusSelection = getSessionExecutionSelection(scopedResolved.entry);
          const selectedModel =
            statusSelection && statusSelection.model !== "native-managed"
              ? {
                  model: statusSelection.model.id,
                  provider: isModelExecutionSelection(statusSelection)
                    ? statusSelection.model.provider
                    : undefined,
                }
              : undefined;
          const displayModel = selectedModel ?? activeModelIdentity ?? runtimeModelIdentity;
          const providerForCard = displayModel.provider ?? "";
          const defaultModelForCard = displayModel.model;
          const statusSessionEntry = activeModelIdentity
            ? {
                ...scopedResolved.entry,
                model: activeModelIdentity.model,
                modelProvider: activeModelIdentity.provider,
              }
            : scopedResolved.entry;
          const primaryModelLabel =
            statusSelection?.model === "native-managed"
              ? "the app's default model"
              : providerForCard
                ? `${providerForCard}/${defaultModelForCard}`
                : defaultModelForCard;
          const isGroup =
            statusSessionEntry.chatType === "group" ||
            statusSessionEntry.chatType === "channel" ||
            scopedResolved.key.includes(":group:") ||
            scopedResolved.key.includes(":channel:");
          const taskLine = formatSessionTaskLine({
            relatedSessionKey: scopedResolved.key,
            callerOwnerKey: visibilityRequesterKey,
            callerAgentId: requesterAgentId,
            config: cfg,
          });
          // Tool status may read persisted/configured facts, but must not start provider discovery.
          const thinkingCatalog = await loadPublishedPreparedModelCatalog({
            config: cfg,
            agentId,
            agentDir: selectedAgentDir,
            readOnly: true,
            ...(statusSessionEntry.spawnedWorkspaceDir
              ? { workspaceDir: statusSessionEntry.spawnedWorkspaceDir }
              : {}),
          });
          const { buildStatusText } = await loadCommandsStatusRuntime();
          const statusText = await buildStatusText({
            cfg,
            agentId,
            sessionEntry: statusSessionEntry,
            activeModel: activeModelIdentity,
            sessionKey: scopedResolved.key,
            parentSessionKey: statusSessionEntry.parentSessionKey,
            sessionScope: cfg.session?.scope,
            storePath,
            statusChannel: sessionDeliveryChannel(statusSessionEntry) ?? "unknown",
            workspaceDir: statusSessionEntry.spawnedWorkspaceDir,
            provider: providerForCard,
            model: defaultModelForCard,
            thinkingCatalog,
            resolvedThinkLevel: statusSessionEntry.thinkingLevel as ThinkLevel | undefined,
            resolvedFastMode: statusSessionEntry.fastMode,
            resolvedVerboseLevel: (statusSessionEntry.verboseLevel ?? "off") as VerboseLevel,
            resolvedReasoningLevel: (statusSessionEntry.reasoningLevel ?? "off") as ReasoningLevel,
            resolvedElevatedLevel: statusSessionEntry.elevatedLevel as ElevatedLevel | undefined,
            resolveDefaultThinkingLevel: async (selection) =>
              resolveThinkingDefault({
                cfg,
                agentId,
                provider: selection?.provider ?? providerForCard,
                model: selection?.model ?? defaultModelForCard,
                agentRuntime: selection?.agentRuntime,
                catalog: thinkingCatalog,
              }),
            isGroup,
            defaultGroupActivation: () => "mention",
            taskLineOverride: taskLine,
            skipDefaultTaskLookup: true,
            primaryModelLabelOverride: primaryModelLabel,
            ...(providerForCard ? {} : { modelAuthOverride: undefined }),
            includeTranscriptUsage: true,
          });
          const statusWithTask =
            taskLine && !statusText.includes(taskLine) ? `${statusText}\n${taskLine}` : statusText;
          const fullStatusText = [modelChangeMessage, statusWithTask].filter(Boolean).join("\n\n");
          const resultOverrideProvider =
            statusSelection && isModelExecutionSelection(statusSelection)
              ? statusSelection.model.provider
              : undefined;
          const resultOverrideModel =
            statusSelection && statusSelection.model !== "native-managed"
              ? statusSelection.model.id
              : undefined;
          const liveSessionKeySet = new Set(
            liveSessionKeys
              .map((value) => value?.trim())
              .filter((value): value is string => Boolean(value)),
          );
          const activeRouteRunSessionKey = opts?.runSessionKey?.trim();
          const isLiveRouteSession = activeRouteRunSessionKey
            ? agentId === requesterAgentId && scopedResolved.key.trim() === activeRouteRunSessionKey
            : agentId === requesterAgentId && liveSessionKeySet.has(scopedResolved.key.trim());
          const routeDetails = buildSessionStatusRouteDetails({
            entry: statusSessionEntry,
            sessionKey: scopedResolved.key,
            activeDeliveryContext: opts?.activeDeliveryContext,
            isLiveRunSession: isLiveRouteSession,
          });
          const routeContextText = formatSessionStatusRouteContext(routeDetails);
          const stateVersion = getSessionStateVersion(scopedResolved.key, agentId);
          const rawStateChanges =
            changesSince !== undefined
              ? listSessionStateEventsSince(scopedResolved.key, agentId, changesSince, 200)
              : undefined;
          const stateChanges = rawStateChanges
            ? compactSessionStateChanges(rawStateChanges)
            : undefined;
          const extraBlocks = [
            routeContextText,
            stateChanges ? formatSessionStateChanges({ stateVersion, stateChanges }) : undefined,
          ].filter((block): block is string => Boolean(block));
          const visibleStatusText =
            extraBlocks.length > 0
              ? `${fullStatusText}\n\n${extraBlocks.join("\n\n")}`
              : fullStatusText;
          const modelOverrideForResult =
            modelRaw === undefined
              ? undefined
              : resetModelRequested
                ? null
                : resultOverrideModel
                  ? resultOverrideProvider
                    ? `${resultOverrideProvider}/${resultOverrideModel}`
                    : resultOverrideModel
                  : null;

          return {
            content: [{ type: "text", text: visibleStatusText }],
            details: {
              ok: true,
              sessionKey: scopedResolved.key,
              agentId,
              changedModel,
              stateVersion,
              ...(stateChanges ? { stateChanges } : {}),
              ...(modelRaw !== undefined
                ? {
                    ...(resultOverrideModel ? { model: resultOverrideModel } : {}),
                    ...(resultOverrideProvider ? { modelProvider: resultOverrideProvider } : {}),
                    modelOverride: modelOverrideForResult,
                  }
                : {}),
              statusText: visibleStatusText,
              ...routeDetails,
            },
          };
        },
      });
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
