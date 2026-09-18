// Applies parsed directives to session state, config overrides, and run options.
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import { modelKey } from "../../agents/model-selection.js";
import { resolveContextConfigProviderForRuntime } from "../../agents/openai-routing.js";
import { resolveStickyModelSelectionScope } from "../../agents/sticky-model-selection.js";
import type { SessionEntry, SessionScope } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getCommittedSessionExecutionSelection,
  isModelExecutionSelection,
  type ExecutionSelection,
  type SessionExecutionSelection,
} from "../../model-picker/execution-selection.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
} from "../../sessions/model-overrides.js";
import { readSessionInputProfileId } from "../../sessions/session-participant-input.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { MsgContext } from "../templating.js";
import type { ElevatedLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { CommandContext } from "./commands-types.js";
import { maybeHandleUnexpectedDirectiveArguments } from "./directive-handling.arguments.js";
import { isDirectiveOnly } from "./directive-handling.directive-only.js";
import { resolveModelRuntimeDirective } from "./directive-handling.model-runtime.js";
import { resolveModelSelectionFromDirective } from "./directive-handling.model-selection.js";
import type { HandleDirectiveOnlyParams } from "./directive-handling.params.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { formatConfiguredDefaultSelectionAck } from "./directive-handling.shared.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { resolveContextTokens } from "./model-selection-context.js";
import type { createModelSelectionState } from "./model-selection.js";
import type { ReplyPreRunRejectionCode } from "./reply-operation-run-state.js";
import type { TypingController } from "./typing.js";

type AgentDefaults = NonNullable<OpenClawConfig["agents"]>["defaults"];
type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

const commandsStatusLoader = createLazyImportLoader(() => import("./commands-status.runtime.js"));
const directiveLevelsLoader = createLazyImportLoader(
  () => import("./directive-handling.levels.js"),
);
const directiveImplLoader = createLazyImportLoader(() => import("./directive-handling.impl.js"));
const directivePersistLoader = createLazyImportLoader(
  () => import("./directive-handling.persist.runtime.js"),
);

function loadCommandsStatus() {
  return commandsStatusLoader.load();
}

function loadDirectiveLevels() {
  return directiveLevelsLoader.load();
}

function loadDirectiveImpl() {
  return directiveImplLoader.load();
}

function loadDirectivePersist() {
  return directivePersistLoader.load();
}

function hasOnlyModelDirective(directives: InlineDirectives): boolean {
  return (
    directives.hasModelDirective &&
    !directives.hasThinkDirective &&
    !directives.hasFastDirective &&
    !directives.hasVerboseDirective &&
    !directives.hasTraceDirective &&
    !directives.hasReasoningDirective &&
    !directives.hasElevatedDirective &&
    !directives.hasExecDirective &&
    !directives.hasQueueDirective &&
    !directives.hasStatusDirective
  );
}

type ApplyDirectiveResult =
  | {
      kind: "reply";
      reply: ReplyPayload | ReplyPayload[] | undefined;
      preRunRejection?: ReplyPreRunRejectionCode;
    }
  | {
      kind: "continue";
      executionSelection: ExecutionSelection | undefined;
      sessionExecutionSelection: SessionExecutionSelection | undefined;
      directives: InlineDirectives;
      provider: string;
      model: string;
      contextTokens: number;
      directiveAck?: ReplyPayload;
      perMessageQueueMode?: InlineDirectives["queueMode"];
      perMessageQueueOptions?: {
        debounceMs?: number;
        cap?: number;
        dropPolicy?: InlineDirectives["dropPolicy"];
      };
    };

const directiveRejection = (
  code: ReplyPreRunRejectionCode,
  text: string,
): ApplyDirectiveResult => ({
  kind: "reply",
  reply: { text, isError: true },
  preRunRejection: code,
});

export async function applyInlineDirectiveOverrides(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  agentCfg: AgentDefaults;
  agentEntry?: AgentEntry;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  sessionScope: SessionScope | undefined;
  isGroup: boolean;
  allowTextCommands: boolean;
  command: CommandContext;
  directives: InlineDirectives;
  messageProviderKey: string;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  elevatedFailures: Array<{ gate: string; key: string }>;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: HandleDirectiveOnlyParams["aliasIndex"];
  provider: string;
  model: string;
  modelState: Awaited<ReturnType<typeof createModelSelectionState>>;
  initialModelLabel: string;
  formatModelSwitchEvent: (label: string, alias?: string) => string;
  resolvedElevatedLevel: ElevatedLevel;
  defaultActivation: () => "always" | "mention";
  contextTokens: number;
  effectiveModelDirective?: string;
  typing: TypingController;
}): Promise<ApplyDirectiveResult> {
  const {
    ctx,
    cfg,
    agentId,
    agentDir,
    workspaceDir,
    agentCfg,
    agentEntry,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    isGroup,
    allowTextCommands,
    command,
    messageProviderKey,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultProvider,
    defaultModel,
    aliasIndex,
    modelState,
    initialModelLabel,
    formatModelSwitchEvent,
    resolvedElevatedLevel,
    defaultActivation,
    typing,
    effectiveModelDirective,
  } = params;
  const requesterProfileId = readSessionInputProfileId(ctx);
  let { directives } = params;
  let { provider, model } = params;
  let { contextTokens } = params;
  let executionSelection = modelState.executionSelection;
  let sessionExecutionSelection = modelState.sessionExecutionSelection;
  const directiveModelState = {
    modelPolicy: modelState.modelPolicy,
    allowedModelKeys: modelState.allowedModelKeys,
    allowedModelCatalog: modelState.allowedModelCatalog,
    policyAliasIndex: modelState.policyAliasIndex,
  };
  const createDirectiveHandlingBase = () => ({
    cfg,
    agentId,
    directives,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    messageProviderKey,
    defaultProvider,
    defaultModel,
    aliasIndex,
    ...directiveModelState,
    provider,
    model,
    initialModelLabel,
    formatModelSwitchEvent,
    canPersistStickyModelSelection,
    ...(stickyModelSelectionTarget ? { stickyModelSelectionTarget } : {}),
  });

  let directiveAck: ReplyPayload | undefined;
  let selectionCatalog = modelState.allowedModelCatalog;

  if (!command.isAuthorizedSender) {
    directives = clearInlineDirectives(directives.cleaned);
  }

  // Derive the persistent write target from the directives that survived the
  // unauthorized-sender clearing above. Reading the pre-clearing value would let
  // an unauthorized "/model … -a|-g" reach the authority error below instead of
  // the plain-text path every other directive takes.
  const modelSelectionScope = resolveStickyModelSelectionScope({
    cfg,
    scope: directives.modelScope,
  });
  const canWriteModelDefaults = Array.isArray(ctx.GatewayClientScopes)
    ? ctx.GatewayClientScopes.includes("operator.admin")
    : command.senderIsOwner;
  const stickyModelSelectionTarget =
    canWriteModelDefaults && modelSelectionScope === "agent"
      ? ("agent" as const)
      : canWriteModelDefaults && modelSelectionScope === "global"
        ? ("defaults" as const)
        : undefined;
  const canPersistStickyModelSelection = modelSelectionScope !== "session" && canWriteModelDefaults;

  if (directives.modelScopeConflict) {
    typing.cleanup();
    return directiveRejection("model-scope-conflict", "Use only one model scope option.");
  }

  if (
    (directives.modelScope === "agent" || directives.modelScope === "global") &&
    !canWriteModelDefaults
  ) {
    typing.cleanup();
    return directiveRejection(
      "model-scope-not-authorized",
      "Agent and global model defaults require owner authority or operator.admin scope.",
    );
  }

  if (
    directives.hasModelDirective &&
    effectiveModelDirective &&
    isModelSelectionLocked(sessionEntry)
  ) {
    const lockedModelResolution = resolveModelSelectionFromDirective({
      directives: {
        ...directives,
        rawModelDirective: effectiveModelDirective,
      },
      cfg,
      agentDir,
      defaultProvider,
      defaultModel,
      aliasIndex,
      modelPolicy: modelState.modelPolicy,
      allowedModelKeys: modelState.allowedModelKeys,
      allowedModelCatalog: modelState.allowedModelCatalog,
      provider,
      agentId,
      requesterProfileId,
      executionSelection: getCommittedSessionExecutionSelection(sessionEntry),
    });
    if (lockedModelResolution.modelSelection) {
      typing.cleanup();
      return directiveRejection("model-selection-locked", MODEL_SELECTION_LOCKED_MESSAGE);
    }
  }

  const hasAnyDirective =
    directives.hasThinkDirective ||
    directives.hasFastDirective ||
    directives.hasVerboseDirective ||
    directives.hasTraceDirective ||
    directives.hasReasoningDirective ||
    directives.hasElevatedDirective ||
    directives.hasExecDirective ||
    directives.hasModelDirective ||
    directives.hasQueueDirective ||
    directives.hasStatusDirective;

  if (!hasAnyDirective) {
    return {
      kind: "continue",
      executionSelection,
      sessionExecutionSelection,
      directives,
      provider,
      model,
      contextTokens,
    };
  }

  // Model-only directives have a focused persistence service; reject leftovers before that mutation.
  if (directives.command?.name === "model") {
    const unexpectedArguments = maybeHandleUnexpectedDirectiveArguments(directives);
    if (unexpectedArguments) {
      typing.cleanup();
      return {
        kind: "reply",
        reply: unexpectedArguments,
        preRunRejection: "session-directive-rejected",
      };
    }
  }

  const directiveOnly = isDirectiveOnly({
    directives,
    cleanedBody: directives.cleaned,
    ctx,
    cfg,
    agentId,
    isGroup,
  });

  const handleDirectives = async (
    persistenceState?: NonNullable<HandleDirectiveOnlyParams["persistenceState"]>,
  ) => {
    let rejected = false;
    const currentLevels = await (
      await loadDirectiveLevels()
    ).resolveCurrentDirectiveLevels({
      sessionEntry,
      agentEntry: persistenceState ? undefined : agentEntry,
      agentCfg,
      resolveDefaultThinkingLevel:
        !persistenceState || directives.hasThinkDirective
          ? () => modelState.resolveDefaultThinkingLevel()
          : async () => undefined,
    });
    const thinkingCatalog = await modelState.resolveThinkingCatalog();
    const reply = await (
      await loadDirectiveImpl()
    ).handleDirectiveOnly({
      ...createDirectiveHandlingBase(),
      ...currentLevels,
      thinkingCatalog,
      ctx,
      messageProvider: ctx.Provider,
      surface: ctx.Surface,
      gatewayClientScopes: ctx.GatewayClientScopes,
      commandAuthorized: command.isAuthorizedSender,
      senderIsOwner: command.senderIsOwner,
      workspaceDir,
      onRejection: () => {
        rejected = true;
      },
      ...(persistenceState ? { persistenceState } : {}),
    });
    return { reply, rejected, currentLevels, thinkingCatalog };
  };

  if (directiveOnly) {
    if (!command.isAuthorizedSender) {
      typing.cleanup();
      return { kind: "reply", reply: undefined };
    }
    // Only the exact model-only case uses the focused service; mixed directives
    // fall through so their settings remain one broad atomic session transaction.
    if (hasOnlyModelDirective(directives) && effectiveModelDirective) {
      const modelResolution = resolveModelSelectionFromDirective({
        directives: {
          ...directives,
          rawModelDirective: effectiveModelDirective,
        },
        cfg,
        agentDir,
        defaultProvider,
        defaultModel,
        aliasIndex,
        modelPolicy: modelState.modelPolicy,
        allowedModelKeys: modelState.allowedModelKeys,
        allowedModelCatalog: modelState.allowedModelCatalog,
        provider,
        agentId,
        requesterProfileId,
        executionSelection: getCommittedSessionExecutionSelection(sessionEntry),
      });
      if (modelResolution.errorText) {
        typing.cleanup();
        return directiveRejection("model-selection-rejected", modelResolution.errorText);
      }
      const modelSelection = modelResolution.modelSelection;
      if (modelSelection) {
        const runtime = resolveModelRuntimeDirective(directives.rawModelRuntime);
        const selectionOwner = await loadDirectivePersist();
        const executorKind =
          runtime.kind === "set"
            ? selectionOwner.resolveExecutionSelectionExecutorKind(cfg, runtime.runtime)
            : undefined;
        if (runtime.kind === "set" && !executorKind) {
          typing.cleanup();
          return directiveRejection(
            "model-selection-rejected",
            "Could not confirm support for the selected app. Your selection is unchanged.",
          );
        }
        const executor =
          runtime.kind === "set" && executorKind
            ? { kind: executorKind, id: runtime.runtime }
            : undefined;
        const applied = await selectionOwner.applySessionExecutionSelection({
          cfg,
          agentId,
          sessionKey,
          storePath,
          sessionEntry,
          sessionStore,
          currentProvider: provider,
          modelPolicy: modelState.modelPolicy,
          modelCatalog: modelState.allowedModelCatalog,
          canPersistStickyModelSelection,
          validateCommit: modelResolution.validateAuthProfileSelection,
          ...(stickyModelSelectionTarget ? { stickyModelSelectionTarget } : {}),
          profileOverride: modelResolution.profileOverride,
          fallbackPermission: modelSelection.isDefault ? "configured" : "explicit",
          request: modelSelection.resetToDefault
            ? { kind: "reset", executor }
            : {
                kind: runtime.kind === "clear" ? "reset" : "model",
                model: { provider: modelSelection.provider, id: modelSelection.model },
                executor,
              },
          patchModel: effectiveModelDirective,
          markLiveSwitchPending: true,
        });
        if (applied.status === "rejected") {
          typing.cleanup();
          return directiveRejection("model-selection-rejected", applied.message);
        }
        if (applied.status === "conflict") {
          typing.cleanup();
          return directiveRejection("model-selection-conflict", applied.message);
        }
        // Model change first, then the thinking remap it triggered: the remap is a
        // consequence of the model switch, so the cause is announced before the effect.
        const parts = [
          applied.message,
          formatConfiguredDefaultSelectionAck({
            configuredDefaultUpdate: applied.configuredDefaultUpdate,
            stickyModelSelectionTarget,
          }),
          applied.thinkingRemap ? `Thinking level set to ${applied.thinkingRemap.to}.` : undefined,
          modelResolution.profileOverride ? "Selected account updated." : undefined,
        ].filter(Boolean);
        typing.cleanup();
        return { kind: "reply", reply: { text: parts.join(" ") } };
      }
    }
    const {
      reply: directiveReply,
      rejected,
      currentLevels,
      thinkingCatalog,
    } = await handleDirectives();
    const preRunRejection = rejected ? "session-directive-rejected" : undefined;
    const {
      currentThinkLevel: resolvedDefaultThinkLevel,
      currentVerboseLevel,
      currentReasoningLevel,
    } = currentLevels;
    let statusReply: ReplyPayload | undefined;
    if (directives.hasStatusDirective && allowTextCommands && command.isAuthorizedSender) {
      const { buildStatusReply } = await loadCommandsStatus();
      const targetSessionEntry = sessionStore[sessionKey] ?? sessionEntry;
      statusReply = await buildStatusReply({
        cfg,
        agentId,
        command,
        sessionEntry: targetSessionEntry,
        sessionKey,
        parentSessionKey: targetSessionEntry?.parentSessionKey ?? ctx.ParentSessionKey,
        sessionScope,
        storePath,
        provider,
        model,
        contextTokens,
        thinkingCatalog,
        workspaceDir,
        resolvedThinkLevel: resolvedDefaultThinkLevel,
        resolvedVerboseLevel: currentVerboseLevel ?? "off",
        resolvedReasoningLevel: currentReasoningLevel ?? "off",
        resolvedElevatedLevel,
        resolveDefaultThinkingLevel: async () => resolvedDefaultThinkLevel,
        isGroup,
        defaultGroupActivation: defaultActivation,
        mediaDecisions: ctx.MediaUnderstandingDecisions,
      });
    }
    typing.cleanup();
    if (statusReply?.text && directiveReply?.text) {
      return {
        kind: "reply",
        reply: { text: `${directiveReply.text}\n${statusReply.text}` },
        preRunRejection,
      };
    }
    return { kind: "reply", reply: statusReply ?? directiveReply, preRunRejection };
  }

  if (hasAnyDirective && command.isAuthorizedSender) {
    const persistenceState: NonNullable<HandleDirectiveOnlyParams["persistenceState"]> = {
      outcome: { kind: "pending" },
    };
    directiveAck = (await handleDirectives(persistenceState)).reply;
    if (persistenceState.outcome.kind === "rejected") {
      typing.cleanup();
      return {
        kind: "reply",
        reply: { text: persistenceState.outcome.errorText, isError: true },
        preRunRejection: "session-directive-rejected",
      };
    }
    if (persistenceState.outcome.kind === "applied") {
      selectionCatalog = persistenceState.outcome.modelCatalog ?? selectionCatalog;
      if (persistenceState.outcome.executionSelection) {
        executionSelection = persistenceState.outcome.executionSelection;
        sessionExecutionSelection = persistenceState.outcome.sessionExecutionSelection;
        if (isModelExecutionSelection(executionSelection)) {
          provider = executionSelection.model.provider;
          model = executionSelection.model.id;
        }
      }
    }
  }

  const selectedCatalogEntry = selectionCatalog.find(
    (entry) => modelKey(entry.provider, entry.id) === modelKey(provider, model),
  );
  contextTokens = resolveContextTokens({
    cfg,
    provider: resolveContextConfigProviderForRuntime({
      provider,
      runtimeId: resolveAgentHarnessPolicy({
        provider,
        modelId: model,
        config: cfg,
        agentId,
        sessionKey,
      }).runtime,
      config: cfg,
    }),
    model,
    modelContextWindow: selectedCatalogEntry?.contextWindow,
    modelContextTokens: selectedCatalogEntry?.contextTokens,
  });

  const perMessageQueueMode =
    directives.hasQueueDirective && !directives.queueReset ? directives.queueMode : undefined;
  const perMessageQueueOptions =
    directives.hasQueueDirective && !directives.queueReset
      ? {
          debounceMs: directives.debounceMs,
          cap: directives.cap,
          dropPolicy: directives.dropPolicy,
        }
      : undefined;

  return {
    kind: "continue",
    executionSelection,
    sessionExecutionSelection,
    directives,
    provider,
    model,
    contextTokens,
    directiveAck,
    perMessageQueueMode,
    perMessageQueueOptions,
  };
}
