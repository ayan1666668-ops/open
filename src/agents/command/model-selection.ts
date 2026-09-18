import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import {
  formatThinkingLevels,
  normalizeThinkLevel,
  type ThinkLevel,
} from "../../auto-reply/thinking.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  commitSessionExecutionSelection,
  hasSessionModelSelection,
  prepareSessionExecutionSelection,
} from "../../model-picker/apply-session-model-selection.js";
import {
  getSessionExecutionSelection,
  isAcpExecutionSelection,
  isModelExecutionSelection,
} from "../../model-picker/execution-selection.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { shouldPreserveUnavailableSessionAuthProfileOverride } from "../../sessions/auth-profile-preservation.js";
import {
  isModelSelectionLocked,
  ModelSelectionLockedError,
} from "../../sessions/model-overrides.js";
import {
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel.js";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
} from "../agent-scope.js";
import { isStoredCredentialCompatibleWithAuthProvider } from "../auth-profiles/order.js";
import { clearSessionAuthProfileOverride } from "../auth-profiles/session-override.js";
import { ensureAuthProfileStore } from "../auth-profiles/store-runtime.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import { resolveModelProviderAuthConfig } from "../model-auth-provider-route.js";
import { findModelInCatalog } from "../model-catalog-lookup.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";
import { splitTrailingAuthProfile } from "../model-ref-profile.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import { dedupeModelCatalogEntries } from "../model-selection-shared.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import {
  resolveConfiguredThinkingDefault,
  resolveThinkingSelection,
} from "../model-thinking-default.js";
import { createModelVisibilityPolicy } from "../model-visibility-policy.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../openai-routing.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { needsThinkHydration, normalizeThinkingCatalogProviders } from "../thinking-runtime.js";
import { persistAgentSession } from "./attempt-execution.shared.js";
import { normalizeAgentCommandModelRef, parseAgentCommandModelRef } from "./model-ref.js";
import { prepareCommandModelCatalog } from "./model-selection-catalog.js";
import { normalizeExplicitOverrideInput } from "./prepare.js";
import type { resolveAgentRunContext } from "./run-context.js";
import { loadTranscriptResolveRuntime } from "./runtime-loaders.js";
import type { AgentCommandOpts } from "./types.js";

type AgentRunContext = ReturnType<typeof resolveAgentRunContext>;

export async function resolveEmbeddedModelSelection(params: {
  cfg: OpenClawConfig;
  opts: AgentCommandOpts;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  sessionId: string;
  storePath: string;
  sessionAgentId: string;
  workspaceDir: string;
  pluginsEnabled: boolean;
  manifestMetadataSnapshot?: PluginMetadataSnapshot;
  modelManifestContext: ModelManifestNormalizationContext;
  configuredThinkingCatalog: ModelCatalogEntry[];
  requestedThinkLevel?: ThinkLevel;
  thinkOverride?: ThinkLevel;
  thinkOnce?: ThinkLevel;
  isSubagentLane: boolean;
  suppressVisibleSessionEffects: boolean;
  runContext: AgentRunContext;
}) {
  const configuredDefaultRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.sessionAgentId,
    allowPluginNormalization: params.pluginsEnabled,
    ...params.modelManifestContext,
  });
  const configuredDefaultAuthProfileId = splitTrailingAuthProfile(
    resolveAgentEffectiveModelPrimary(params.cfg, params.sessionAgentId) ?? "",
  ).profile;
  const { provider: defaultProvider, model: defaultModel } = configuredDefaultRef;
  let provider = defaultProvider;
  let model = defaultModel;
  let sessionEntry = params.sessionEntry;
  const acceptedSelection = getSessionExecutionSelection(sessionEntry);
  const explicitProviderOverride =
    typeof params.opts.provider === "string"
      ? normalizeExplicitOverrideInput(params.opts.provider, "provider")
      : undefined;
  const explicitModelOverride =
    typeof params.opts.model === "string"
      ? normalizeExplicitOverrideInput(params.opts.model, "model")
      : undefined;
  const hasExplicitRunOverride = Boolean(explicitProviderOverride || explicitModelOverride);
  if (hasExplicitRunOverride && isModelSelectionLocked(sessionEntry)) {
    throw new ModelSelectionLockedError();
  }
  if (hasExplicitRunOverride && params.opts.allowModelOverride !== true) {
    throw new Error("Model override is not authorized for this caller.");
  }

  const { visibilityPolicy, modelCatalog, loadDeferredThinkingCatalog } =
    prepareCommandModelCatalog({
      cfg: params.cfg,
      agentId: params.sessionAgentId,
      sessionEntry,
      hasExplicitRunOverride,
      metadataSnapshot: params.manifestMetadataSnapshot,
      pluginsEnabled: params.pluginsEnabled,
      workspaceDir: params.workspaceDir,
      defaultProvider,
      defaultModel,
      modelManifestContext: params.modelManifestContext,
    });

  const currentRunModelChannel = [
    params.runContext.messageChannel,
    params.opts.replyChannel,
    params.opts.channel,
  ].find((channel): channel is string => Boolean(channel && isDeliverableMessageChannel(channel)));
  const channelOverrideGroupId = currentRunModelChannel
    ? (params.runContext.groupId ?? sessionEntry?.groupId ?? params.runContext.currentChannelId)
    : (sessionEntry?.groupId ?? params.runContext.groupId ?? params.runContext.currentChannelId);
  const channelModelOverride =
    params.cfg.channels?.modelByChannel &&
    !hasExplicitRunOverride &&
    !hasSessionModelSelection(sessionEntry)
      ? resolveChannelModelOverride({
          cfg: params.cfg,
          channel: currentRunModelChannel ?? sessionDeliveryChannel(sessionEntry),
          groupId: channelOverrideGroupId,
          groupChatType: sessionEntry?.chatType ?? sessionDeliveryOrigin(sessionEntry)?.chatType,
          groupChannel: params.runContext.groupChannel ?? sessionEntry?.groupChannel,
          groupSubject: sessionEntry?.subject,
          parentSessionKey: sessionEntry?.parentSessionKey ?? params.sessionKey,
          directUserIds: [
            sessionDeliveryOrigin(sessionEntry)?.nativeDirectUserId,
            sessionDeliveryOrigin(sessionEntry)?.from,
            sessionDeliveryOrigin(sessionEntry)?.to,
          ],
        })
      : null;
  const normalizedChannelOverride = channelModelOverride
    ? parseAgentCommandModelRef(
        params.cfg,
        params.sessionAgentId,
        channelModelOverride.model,
        defaultProvider,
        params.modelManifestContext,
      )
    : null;
  if (acceptedSelection && isModelExecutionSelection(acceptedSelection)) {
    provider = acceptedSelection.model.provider;
    model = acceptedSelection.model.id;
  } else if (normalizedChannelOverride) {
    provider = normalizedChannelOverride.provider;
    model = normalizedChannelOverride.model;
  }

  if (hasExplicitRunOverride) {
    const explicitRef = explicitModelOverride
      ? explicitProviderOverride
        ? normalizeAgentCommandModelRef(
            params.cfg,
            explicitProviderOverride,
            explicitModelOverride,
            params.modelManifestContext,
          )
        : parseAgentCommandModelRef(
            params.cfg,
            params.sessionAgentId,
            explicitModelOverride,
            provider,
            params.modelManifestContext,
          )
      : explicitProviderOverride
        ? normalizeAgentCommandModelRef(
            params.cfg,
            explicitProviderOverride,
            model,
            params.modelManifestContext,
          )
        : null;
    if (!explicitRef) {
      throw new Error("Invalid model override.");
    }
    if (!visibilityPolicy.allows(explicitRef)) {
      const rejectedKey = `${sanitizeForLog(explicitRef.provider)}/${sanitizeForLog(explicitRef.model)}`;
      const policyPath = visibilityPolicy.allowConfigPath ?? "modelPolicy.allow";
      const repairPath = visibilityPolicy.allowRepairConfigPath;
      throw new Error(
        `Model override "${rejectedKey}" is not allowed for agent "${params.sessionAgentId}" by ${policyPath}. Add "${rejectedKey}" or "${sanitizeForLog(explicitRef.provider)}/*" to ${repairPath}, or remove/empty the list to allow any model.`,
      );
    }
    provider = explicitRef.provider;
    model = explicitRef.model;
  }
  const preparedSelection = await prepareSessionExecutionSelection({
    cfg: params.cfg,
    agentId: params.sessionAgentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    sessionEntry,
    modelCatalog,
    manifestPlugins: params.modelManifestContext.manifestPlugins,
    request:
      params.opts.modelRun === true || params.opts.promptMode === "none"
        ? {
            kind: "model",
            model: { provider, id: model },
            executor: { kind: "harness", id: "openclaw" },
          }
        : hasExplicitRunOverride || normalizedChannelOverride
          ? { kind: "model", model: { provider, id: model } }
          : { kind: "initialize" },
  });
  if (preparedSelection.status !== "ready") {
    throw new Error(preparedSelection.message);
  }
  if (isAcpExecutionSelection(preparedSelection.selection)) {
    throw new Error("This command requires a direct execution selection.");
  }
  const executionSelection = preparedSelection.selection;
  if (isModelExecutionSelection(executionSelection)) {
    provider = executionSelection.model.provider;
    model = executionSelection.model.id;
  }
  const providerForAuthProfileValidation = provider;
  if (
    !acceptedSelection &&
    !hasExplicitRunOverride &&
    sessionEntry &&
    params.sessionStore &&
    params.sessionKey &&
    !params.suppressVisibleSessionEffects
  ) {
    const next = { ...sessionEntry };
    commitSessionExecutionSelection(next, executionSelection, {
      cause: { kind: "initialize", fallbackPermission: preparedSelection.fallbackPermission },
    });
    sessionEntry = await persistAgentSession({
      agentId: params.sessionAgentId,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      initialEntry: sessionEntry,
      entry: next,
      validateCommit: preparedSelection.validateCommit,
    });
  }
  let sessionEntryForAttempt = sessionEntry;
  const initialAgentHarnessRuntimeOverride = executionSelection.executor.id;
  await ensureSelectedAgentHarnessPlugin({
    config: params.cfg,
    provider,
    modelId: model,
    agentId: params.sessionAgentId,
    sessionKey: params.sessionKey,
    agentHarnessRuntimeOverride: initialAgentHarnessRuntimeOverride,
    workspaceDir: params.workspaceDir,
    pluginRegistry: requireActivePluginRegistry(),
  });

  const authProfileId = sessionEntryForAttempt?.authProfileOverride;
  if (isModelExecutionSelection(executionSelection) && sessionEntryForAttempt && authProfileId) {
    const entry = sessionEntryForAttempt;
    const authConfig = resolveModelProviderAuthConfig({
      config: params.cfg,
      provider: providerForAuthProfileValidation,
      modelId: model,
      workspaceDir: params.workspaceDir,
      metadataSnapshot: params.pluginsEnabled ? params.manifestMetadataSnapshot : { plugins: [] },
    });
    const agentDir = resolveAgentDir(params.cfg, params.sessionAgentId);
    const store = ensureAuthProfileStore(agentDir, {
      profileId: authProfileId,
      config: params.cfg,
      allowKeychainPrompt: false,
    });
    const profile = store.profiles[authProfileId];
    const authAliasLookupParams = params.pluginsEnabled
      ? {
          config: authConfig,
          workspaceDir: params.workspaceDir,
          ...(params.manifestMetadataSnapshot
            ? { metadataSnapshot: params.manifestMetadataSnapshot }
            : {}),
        }
      : {
          config: authConfig,
          workspaceDir: params.workspaceDir,
          metadataSnapshot: { plugins: [] },
        };
    const acceptedAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime({
      provider: providerForAuthProfileValidation,
      harnessRuntime: executionSelection.executor.id,
      config: params.cfg,
    }).map((candidateProvider) =>
      params.pluginsEnabled
        ? resolveProviderIdForAuth(candidateProvider, authAliasLookupParams)
        : candidateProvider,
    );
    const profileMatchesRuntime =
      profile &&
      acceptedAuthProviders.some((candidateProvider) =>
        isStoredCredentialCompatibleWithAuthProvider({
          cfg: authConfig,
          authAliasLookupParams,
          provider: candidateProvider,
          credential: profile,
        }),
      );
    const preserveUnavailableSelection = shouldPreserveUnavailableSessionAuthProfileOverride({
      store,
      cfg: authConfig,
      agentDir,
      entry,
      currentProvider:
        acceptedSelection && isModelExecutionSelection(acceptedSelection)
          ? acceptedSelection.model.provider
          : defaultProvider,
      provider: providerForAuthProfileValidation,
      metadataSnapshot: params.pluginsEnabled ? params.manifestMetadataSnapshot : { plugins: [] },
    });
    if (!profileMatchesRuntime && !preserveUnavailableSelection) {
      if (hasExplicitRunOverride) {
        sessionEntryForAttempt = {
          ...entry,
          authProfileOverride: undefined,
          authProfileOverrideSource: undefined,
          authProfileOverrideCompactionCount: undefined,
        };
      } else if (
        params.sessionStore &&
        params.sessionKey &&
        !params.suppressVisibleSessionEffects
      ) {
        await clearSessionAuthProfileOverride({
          agentId: params.sessionAgentId,
          sessionEntry: entry,
          sessionStore: params.sessionStore,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        });
      }
    }
  }

  const configuredThinkLevel = normalizeThinkLevel(
    resolveAgentConfig(params.cfg, params.sessionAgentId)?.thinkingDefault,
  );
  const immutableThinkLevel = params.requestedThinkLevel ?? configuredThinkLevel;
  const primaryConfiguredThinkLevel =
    immutableThinkLevel ??
    resolveConfiguredThinkingDefault({
      cfg: params.cfg,
      agentId: params.sessionAgentId,
      provider,
      model,
    });
  const thinkingRuntime = executionSelection.executor.id;
  let catalogForThinking =
    visibilityPolicy.catalog.length > 0
      ? visibilityPolicy.catalog
      : params.configuredThinkingCatalog;
  if (
    params.pluginsEnabled &&
    (primaryConfiguredThinkLevel !== "off" || thinkingRuntime !== "openclaw") &&
    needsThinkHydration(catalogForThinking, provider, model, thinkingRuntime)
  ) {
    // Thinking capability is a per-model fact; never materialize the full live catalog here.
    const { loadProviderScopedThinkingCatalog } = await import("../model-catalog.runtime.js");
    const runtimeCatalog = normalizeThinkingCatalogProviders(
      await loadProviderScopedThinkingCatalog({
        config: params.cfg,
        provider,
        model,
        agentRuntime: thinkingRuntime,
        ...(params.sessionAgentId ? { agentId: params.sessionAgentId } : {}),
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      }),
    );
    const refreshedModel = findModelInCatalog(runtimeCatalog, provider, model);
    if (refreshedModel) {
      // Replace this route's row whole; later fallback routes retain their prepared capabilities.
      catalogForThinking = createModelVisibilityPolicy({
        cfg: params.cfg,
        catalog: dedupeModelCatalogEntries([refreshedModel, ...catalogForThinking]),
        defaultProvider,
        defaultModel: configuredDefaultRef,
        agentId: params.sessionAgentId,
        allowManifestNormalization: true,
        allowPluginNormalization: params.pluginsEnabled,
        ...params.modelManifestContext,
      }).catalog;
    }
  }
  const thinkingCatalog = catalogForThinking.length > 0 ? catalogForThinking : undefined;
  const primaryThinking = resolveThinkingSelection({
    cfg: params.cfg,
    agentId: params.sessionAgentId,
    provider,
    model,
    level: primaryConfiguredThinkLevel,
    catalog: thinkingCatalog,
    agentRuntime: thinkingRuntime,
  });
  if (!primaryThinking.supported) {
    const explicitThink = Boolean(params.thinkOnce || params.thinkOverride);
    const isSubagentSpawnRun = params.isSubagentLane && isSubagentSessionKey(params.sessionKey);
    if (explicitThink && !isSubagentSpawnRun) {
      throw new Error(
        `Thinking level "${primaryThinking.requestedLevel}" is not supported for ${provider}/${model}. Use one of: ${formatThinkingLevels(provider, model, ", ", thinkingCatalog, thinkingRuntime)}.`,
      );
    }
  }
  if (
    params.thinkOverride &&
    params.sessionStore &&
    params.sessionKey &&
    !params.suppressVisibleSessionEffects
  ) {
    const now = Date.now();
    const entry = params.sessionStore[params.sessionKey] ??
      sessionEntry ?? { sessionId: params.sessionId, updatedAt: now, sessionStartedAt: now };
    const next: SessionEntry = {
      ...entry,
      sessionId: params.sessionId,
      updatedAt: now,
      sessionStartedAt: entry.sessionStartedAt ?? now,
      lastInteractionAt: now,
      thinkingLevel: params.thinkOverride,
    };
    sessionEntry =
      (await persistAgentSession({
        agentId: params.sessionAgentId,
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        initialEntry: entry,
        entry: next,
      })) ?? sessionEntry;
    sessionEntryForAttempt = {
      ...(sessionEntryForAttempt ?? next),
      thinkingLevel: params.thinkOverride,
    };
  }

  const { resolveSessionTranscriptFile } = await loadTranscriptResolveRuntime();
  let sessionFile: string | undefined;
  if (params.sessionStore && params.sessionKey) {
    const resolvedSessionFile = await resolveSessionTranscriptFile({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionStore: params.suppressVisibleSessionEffects ? undefined : params.sessionStore,
      storePath: params.suppressVisibleSessionEffects ? undefined : params.storePath,
      sessionEntry,
      agentId: params.sessionAgentId,
      threadId: params.opts.threadId,
    });
    sessionFile = resolvedSessionFile.sessionFile;
    sessionEntry = resolvedSessionFile.sessionEntry;
  }
  if (!sessionFile) {
    const resolvedSessionFile = await resolveSessionTranscriptFile({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey ?? params.sessionId,
      storePath: params.storePath,
      sessionEntry,
      agentId: params.sessionAgentId,
      threadId: params.opts.threadId,
    });
    sessionFile = resolvedSessionFile.sessionFile;
    sessionEntry = resolvedSessionFile.sessionEntry;
  }

  return {
    sessionEntry,
    provider,
    model,
    requestedRouteResolution: "resolved" as const,
    defaultProvider,
    defaultModel,
    configuredDefaultAuthProfileId,
    providerForAuthProfileValidation,
    hasExplicitRunOverride,
    executionSelection,
    ...(hasExplicitRunOverride && isModelExecutionSelection(executionSelection)
      ? { userSelection: executionSelection }
      : {}),
    sessionEntryForAttempt,
    thinkingCatalog,
    ...(loadDeferredThinkingCatalog ? { loadDeferredThinkingCatalog } : {}),
    immutableThinkLevel,
    effectiveTurnThinkLevel: primaryThinking.requestedLevel,
    sessionFile,
  };
}

export type EmbeddedModelSelection = Awaited<ReturnType<typeof resolveEmbeddedModelSelection>>;
