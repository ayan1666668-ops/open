/** Handles /new and /reset command flows, including soft reset and ACP-bound sessions. */
import { getAcpSessionManagerCore } from "../../acp/control-plane/manager.js";
import { clearBootstrapSnapshot } from "../../agents/bootstrap-cache.js";
import { clearAllCliSessions } from "../../agents/cli-session.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resetConfiguredBindingTargetInPlace } from "../../channels/plugins/binding-targets.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import {
  resolveSessionEntryAccessTarget,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { logVerbose } from "../../globals.js";
import { isAcpSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_RESET_MESSAGE,
} from "../../sessions/model-overrides.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { isResetAuthorizedForContext } from "../command-auth.js";
import { applyCommandTextToContext } from "./command-context-rewrite.js";
import { commandReply } from "./command-gates.js";
import { resolveBoundAcpThreadSessionKey } from "./commands-acp/targets.js";
import { buildCommandContext } from "./commands-context.js";
import { emitResetCommandHooks, type ResetCommandAction } from "./commands-reset-hooks.js";
import { parseSoftResetCommand } from "./commands-reset-mode.js";
import type { CommandHandlerResult, HandleCommandsParams } from "./commands-types.js";
import type { ReplySessionBinding } from "./get-reply.types.js";
import { resolveAuthorizedSessionResetCommand } from "./session-reset-command.js";

type ResetCommandParams = Omit<
  HandleCommandsParams,
  "resolvedThinkLevel" | "resolvedReasoningLevel"
>;

type InternalResetCommandOptions = NonNullable<HandleCommandsParams["opts"]> & {
  onSessionPrepared?: (binding: ReplySessionBinding) => void;
};

function applyAcpResetTailContext(ctx: HandleCommandsParams["ctx"], resetTail: string): void {
  applyCommandTextToContext(ctx, resetTail);
  // Mark the context so ACP dispatch continues with the post-reset tail, not the reset command.
  ctx.AcpDispatchTailAfterReset = true;
}

function isResetAuthorized(params: ResetCommandParams): boolean {
  return isResetAuthorizedForContext({
    ctx: params.ctx,
    cfg: params.cfg,
    commandAuthorized: params.command.isAuthorizedSender || params.ctx.CommandAuthorized === true,
  });
}

/** Handles reset/new commands or returns null when another command handler should continue. */
export async function maybeHandleResetCommand(
  params: ResetCommandParams,
): Promise<CommandHandlerResult | null> {
  const resetMatch = params.command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/i);
  if (!resetMatch) {
    return null;
  }
  if (!isResetAuthorized(params)) {
    logVerbose(
      `Ignoring /${resetMatch[1]} from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    // Internal ingress can forward replies externally; keep those denials silent too.
    return isInternalMessageChannel(params.ctx.Provider || params.ctx.Surface) &&
      isInternalMessageChannel(params.command.channel)
      ? commandReply(
          "⚠️ You are not authorized to reset this session. Gateway resets require operator.admin and command access. Ask your administrator to reset it, or send your message without the command.",
        )
      : { shouldContinue: false };
  }
  const softReset = parseSoftResetCommand(params.command.commandBodyNormalized);
  if (softReset.matched) {
    const boundAcpSessionKey = resolveBoundAcpThreadSessionKey(params);
    const boundAcpKey =
      boundAcpSessionKey && isAcpSessionKey(boundAcpSessionKey)
        ? boundAcpSessionKey.trim()
        : undefined;
    if (boundAcpKey) {
      return {
        shouldContinue: false,
        reply: { text: "Usage: /reset soft is not available for ACP-bound sessions yet." },
      };
    }

    const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
    const previousSessionEntry =
      params.previousSessionEntry ?? (targetSessionEntry ? { ...targetSessionEntry } : undefined);
    if (targetSessionEntry) {
      const now = Date.now();
      clearAllCliSessions(targetSessionEntry);
      if (params.sessionEntry && params.sessionEntry !== targetSessionEntry) {
        clearAllCliSessions(params.sessionEntry);
        params.sessionEntry.updatedAt = now;
        params.sessionEntry.lastInteractionAt = now;
      }
      if (params.sessionKey) {
        clearBootstrapSnapshot(params.sessionKey);
      }
      targetSessionEntry.updatedAt = now;
      targetSessionEntry.lastInteractionAt = now;
      if (params.sessionStore && params.sessionKey) {
        params.sessionStore[params.sessionKey] = targetSessionEntry;
      }
      if (params.storePath && params.sessionKey) {
        await updateSessionEntry(
          {
            storePath: params.storePath,
            sessionKey: params.sessionKey,
          },
          async (entry) => {
            const next = { ...entry };
            clearAllCliSessions(next);
            return {
              cliSessionBindings: next.cliSessionBindings,
              cliSessionIds: next.cliSessionIds,
              claudeCliSessionId: next.claudeCliSessionId,
              updatedAt: now,
              lastInteractionAt: now,
            };
          },
          { consumePendingReset: true },
        );
      }
    }

    await emitResetCommandHooks({
      action: "reset",
      agentId: params.agentId,
      ctx: params.ctx,
      cfg: params.cfg,
      command: params.command,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      sessionEntry: targetSessionEntry,
      previousSessionEntry,
      previousSessionMemory: params.previousSessionMemory,
      previousSessionResetMessages: params.previousSessionResetMessages,
      onObservedReplyDelivery: params.opts?.onObservedReplyDelivery,
      workspaceDir: params.workspaceDir,
    });
    params.command.softResetTriggered = true;
    params.command.softResetTail = softReset.tail;
    return null;
  }

  const commandAction: ResetCommandAction =
    resetMatch[1]?.toLowerCase() === "reset" ? "reset" : "new";
  const resetTail = params.command.commandBodyNormalized.slice(resetMatch[0].length).trimStart();
  const boundAcpSessionKey = resolveBoundAcpThreadSessionKey(params);
  const boundAcpKey =
    boundAcpSessionKey && isAcpSessionKey(boundAcpSessionKey)
      ? boundAcpSessionKey.trim()
      : undefined;
  if (boundAcpKey) {
    return resetAcpSessionForCommand({
      ...params,
      sessionKey: boundAcpKey,
      agentId: resolveAgentIdFromSessionKey(boundAcpKey),
      action: commandAction,
      tail: resetTail,
    });
  }

  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;

  const hookResult = await emitResetCommandHooks({
    action: commandAction,
    agentId: params.agentId,
    ctx: params.ctx,
    cfg: params.cfg,
    command: params.command,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    sessionEntry: targetSessionEntry,
    previousSessionEntry: params.previousSessionEntry,
    previousSessionMemory: params.previousSessionMemory,
    previousSessionResetMessages: params.previousSessionResetMessages,
    onObservedReplyDelivery: params.opts?.onObservedReplyDelivery,
    workspaceDir: params.workspaceDir,
  });
  if (!resetTail) {
    return {
      shouldContinue: false,
      ...(hookResult.routedReply
        ? {}
        : {
            reply: {
              text: commandAction === "reset" ? "✅ Session reset." : "✅ New session started.",
              isStatusNotice: true,
            },
          }),
    };
  }
  return null;
}

async function resetAcpSessionForCommand(
  params: Pick<ResetCommandParams, "cfg" | "ctx" | "rootCtx" | "opts"> & {
    command: Pick<ResetCommandParams["command"], "surface" | "resetHookTriggered">;
    sessionKey: string;
    agentId: string;
    action: ResetCommandAction;
    tail: string;
    expectedSessionId?: string;
  },
): Promise<CommandHandlerResult> {
  const resetResult = await resetConfiguredBindingTargetInPlace({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    reason: params.action,
    ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
    ...(params.opts?.abortSignal
      ? { assertCurrent: () => params.opts?.abortSignal?.throwIfAborted() }
      : {}),
    commandSource: `${params.command.surface}:${params.ctx.CommandSource ?? "text"}`,
  });
  if (!resetResult.ok) {
    logVerbose(
      `acp reset failed for ${params.sessionKey}: ${resetResult.error ?? "unknown error"}`,
    );
  }
  if (resetResult.ok) {
    if (resetResult.sessionId) {
      (params.opts as InternalResetCommandOptions | undefined)?.onSessionPrepared?.({
        sessionKey: resetResult.sessionKey ?? params.sessionKey,
        sessionId: resetResult.sessionId,
        storePath: resetResult.storePath,
      });
    }
    params.command.resetHookTriggered = true;
    if (params.tail) {
      applyAcpResetTailContext(params.ctx, params.tail);
      if (params.rootCtx && params.rootCtx !== params.ctx) {
        applyAcpResetTailContext(params.rootCtx, params.tail);
      }
      return { shouldContinue: false };
    }
    return {
      shouldContinue: false,
      reply: { text: "✅ ACP session reset in place.", isStatusNotice: true },
    };
  }
  return {
    shouldContinue: false,
    reply: {
      text: "⚠️ ACP session reset failed. Check /acp status and try again.",
      isStatusNotice: true,
    },
  };
}

/** ACP reset tails belong to the app, before core initialization can parse model hints. */
export async function maybeHandleExplicitAcpResetCommand(params: {
  cfg: ResetCommandParams["cfg"];
  ctx: ResetCommandParams["ctx"];
  rootCtx?: ResetCommandParams["rootCtx"];
  opts?: ResetCommandParams["opts"];
  agentId: string;
  sessionKey: string;
}): Promise<CommandHandlerResult | null> {
  const chatType = normalizeChatType(params.ctx.ChatType);
  const isGroup =
    chatType != null && chatType !== "direct" ? true : Boolean(resolveGroupSessionKey(params.ctx));
  const { resetAuthorized, resetCommand } = resolveAuthorizedSessionResetCommand({
    cfg: params.cfg,
    ctx: params.ctx,
    agentId: params.agentId,
    commandAuthorized: params.ctx.CommandAuthorized === true,
    isGroup,
  });
  if (!resetAuthorized || resetCommand.softResetMatched || !resetCommand.matchedResetTriggerLower) {
    return null;
  }
  const command = buildCommandContext({
    cfg: params.cfg,
    ctx: params.ctx,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    commandAuthorized: true,
    isGroup,
    triggerBodyNormalized: resetCommand.triggerBodyNormalized,
  });
  const resetMatch = command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/i);
  if (!resetMatch) {
    return null;
  }
  params.opts?.abortSignal?.throwIfAborted();
  const resolved = getAcpSessionManagerCore().resolveSession({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  if (resolved.kind === "none") {
    return null;
  }
  const entry =
    resolved.kind === "ready"
      ? resolved.entry
      : resolveSessionEntryAccessTarget({
          cfg: params.cfg,
          agentId: resolved.agentId,
          sessionKey: resolved.sessionKey,
        }).entry;
  if (isModelSelectionLocked(entry)) {
    return {
      shouldContinue: false,
      reply: { text: MODEL_SELECTION_LOCKED_RESET_MESSAGE, isError: true },
    };
  }
  return resetAcpSessionForCommand({
    ...params,
    agentId: resolved.agentId,
    sessionKey: resolved.sessionKey,
    command,
    expectedSessionId: params.opts?.expectedExistingSessionId ?? entry?.sessionId,
    action: resetMatch[1]?.toLowerCase() === "reset" ? "reset" : "new",
    tail: command.commandBodyNormalized.slice(resetMatch[0].length).trimStart(),
  });
}
