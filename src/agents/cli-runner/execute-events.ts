import { projectAgentToolActivity } from "../../infra/agent-activity-events.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { emitTrustedDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { projectProgressCardChannelUpdate } from "../../session-cards/progress-card-channel-summary.js";
import { isAgentPlanProgressToolName } from "../../session-cards/progress-card-input.js";
import type {
  CliCompactionDelta,
  CliStreamingDelta,
  CliThinkingDelta,
  CliThinkingProgress,
  CliToolUseStartDelta,
} from "../cli-output-contracts.js";
import type { ToolSummaryTrace } from "../embedded-agent-runner/types.js";
import {
  extractToolErrorMessage,
  sanitizeToolArgs,
  sanitizeToolResult,
} from "../embedded-agent-tool-results.js";
import { runAgentHarnessAfterToolCallHook } from "../harness/hook-helpers.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { resolveCliToolTerminalReason } from "../run-termination.js";
import { normalizeToolPolicyName } from "../tool-policy.js";
import type { CliToolTracking } from "./execute-tool-tracking.js";
import { stripOpenClawMcpToolPrefix } from "./tool-policy.js";
import type { PreparedCliRunContext } from "./types.js";

type CliToolResult = {
  toolCallId: string;
  name: string;
  isError: boolean;
  result?: unknown;
};

function resolveCliToolSource(name: string, kind?: CliToolUseStartDelta["kind"]): "core" | "mcp" {
  return kind === "mcp_tool_use" || name.startsWith("mcp__") ? "mcp" : "core";
}

function resolveCliObserverToolName(name: string): string {
  return normalizeToolPolicyName(stripOpenClawMcpToolPrefix(name));
}

function resolveCliToolObserverError(isError: boolean, result: unknown): string | undefined {
  if (!isError) {
    return undefined;
  }
  if (typeof result === "string" && result.length > 0) {
    return result;
  }
  return extractToolErrorMessage(result) ?? "tool execution failed";
}

export function createCliEventHandlers(params: {
  context: PreparedCliRunContext;
  toolTracking: CliToolTracking;
  getRunState: () => { failed: boolean; error: unknown };
}) {
  const context = params.context;
  const runParams = context.params;
  const emitLiveEvents = runParams.executionMode !== "side-question";
  let observedCliActivity = false;
  let signaledToolExecutionStarted = false;
  let signaledAssistantOutputStarted = false;
  let commentaryCounter = 0;
  const toolSummaryById = new Map<string, { name: string; failed: boolean }>();
  // CLI results report an outcome without repeating the request, so the terminal
  // progress event would otherwise describe the output instead of the command.
  const toolArgsByCallId = new Map<
    string,
    { args: Record<string, unknown>; tracked: boolean; startedAt: number }
  >();
  const dispatchedAfterToolCallIds = new Set<string>();
  const dispatchCliAfterToolCall = (input: {
    toolCallId: string;
    toolName: string;
    startArgs: Record<string, unknown>;
    result?: unknown;
    error?: string;
    startedAt?: number;
  }) => {
    if (dispatchedAfterToolCallIds.has(input.toolCallId)) {
      return;
    }
    dispatchedAfterToolCallIds.add(input.toolCallId);
    try {
      void runAgentHarnessAfterToolCallHook({
        toolName: resolveCliObserverToolName(input.toolName),
        toolCallId: input.toolCallId,
        runId: runParams.runId,
        ...(runParams.agentId ? { agentId: runParams.agentId } : {}),
        sessionId: runParams.sessionId,
        ...(runParams.sessionKey ? { sessionKey: runParams.sessionKey } : {}),
        ...(runParams.currentChannelId ? { channelId: runParams.currentChannelId } : {}),
        startArgs: input.startArgs,
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.error ? { error: input.error } : {}),
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      }).catch(() => {
        // Rejected observers must not change the CLI tool result.
      });
    } catch {
      // Synchronous observer failures must not change the CLI tool result.
    }
  };
  const emitToolEvent = (
    data: Parameters<typeof projectAgentToolActivity>[0] & {
      result?: unknown;
      resultContentSource?: "network";
    },
    execution?: { args: unknown },
  ) => {
    const item = projectAgentToolActivity({
      ...data,
      name: stripOpenClawMcpToolPrefix(data.name),
      args: execution ? execution.args : data.args,
    });
    const activity = { runId: runParams.runId, stream: "item", data: item };
    if (data.phase === "start") {
      emitAgentEvent(activity);
    }
    emitAgentEvent({ runId: runParams.runId, stream: "tool", data });
    if (data.phase !== "start") {
      emitAgentEvent(activity);
    }
  };
  const toolSummaryNames: string[] = [];
  const toolSummaryNameSet = new Set<string>();
  const activeParsedTools = new Map<
    string,
    { startedAt: number; toolName: string; kind: CliToolUseStartDelta["kind"] }
  >();
  const rememberToolName = (name: string) => {
    if (!name || toolSummaryNameSet.has(name)) {
      return;
    }
    toolSummaryNameSet.add(name);
    toolSummaryNames.push(name);
  };
  const recordToolSummary = (event: { toolCallId: string; name: string }, failed: boolean) => {
    const current = toolSummaryById.get(event.toolCallId);
    if (current) {
      current.failed ||= failed;
      if (!current.name && event.name) {
        current.name = event.name;
      }
    } else {
      toolSummaryById.set(event.toolCallId, { name: event.name, failed });
    }
    rememberToolName(event.name);
  };
  const getToolSummary = (): ToolSummaryTrace => ({
    calls: toolSummaryById.size,
    tools: toolSummaryNames.slice(),
    failures: Array.from(toolSummaryById.values()).filter((entry) => entry.failed).length,
  });
  const emitToolUseStart = (
    event: CliToolUseStartDelta,
    tracked: boolean,
    startedAt = Date.now(),
  ) => {
    observedCliActivity = true;
    // Empty arguments are meaningful: progress-card calls use {} to clear the card.
    toolArgsByCallId.set(event.toolCallId, { args: event.args, tracked, startedAt });
    recordToolSummary(event, false);
    if (!signaledToolExecutionStarted) {
      signaledToolExecutionStarted = true;
      runParams.onExecutionPhase?.({
        phase: "tool_execution_started",
        provider: runParams.provider,
        model: context.modelId,
        backend: context.backendResolved.id,
      });
    }
    if (tracked) {
      params.toolTracking.handleCliToolUseStart(event);
    }
    if (emitLiveEvents) {
      emitToolEvent({
        phase: "start",
        name: event.name,
        toolCallId: event.toolCallId,
        args: sanitizeToolArgs(event.args),
      });
    }
  };
  const emitToolResult = (event: CliToolResult, tracked: boolean, dispatchAfterHook = true) => {
    observedCliActivity = true;
    recordToolSummary(event, event.isError);
    const loopbackOutcome = tracked
      ? params.toolTracking.resolveCliLoopbackTerminalOutcome(event.toolCallId)
      : undefined;
    const executedArgs = tracked ? params.toolTracking.handleCliToolResult(event) : undefined;
    const startedCall = toolArgsByCallId.get(event.toolCallId);
    const startedArgs = startedCall?.args;
    toolArgsByCallId.delete(event.toolCallId);
    if (dispatchAfterHook) {
      dispatchCliAfterToolCall({
        toolCallId: event.toolCallId,
        toolName: event.name,
        startArgs: startedArgs ?? {},
        result: event.result,
        error: resolveCliToolObserverError(event.isError, event.result),
        startedAt: startedCall?.startedAt,
      });
    }
    if (emitLiveEvents) {
      const strippedName = stripOpenClawMcpToolPrefix(event.name);
      const resultContentSource = tracked
        ? context.resultContentSourceByToolName?.get(strippedName)
        : undefined;
      const planUpdate =
        tracked &&
        startedCall?.tracked &&
        !event.isError &&
        (!loopbackOutcome || loopbackOutcome.outcome === "completed") &&
        isAgentPlanProgressToolName(strippedName)
          ? projectProgressCardChannelUpdate(executedArgs ?? startedArgs)
          : undefined;
      if (planUpdate) {
        emitAgentEvent({
          runId: runParams.runId,
          stream: "plan",
          data: {
            phase: "update",
            title: "Plan updated",
            source: "openclaw",
            ...planUpdate,
          },
        });
      }
      emitToolEvent(
        {
          phase: "result",
          name: event.name,
          toolCallId: event.toolCallId,
          isError: event.isError,
          result: sanitizeToolResult(event.result),
          ...(tracked && startedArgs ? { args: sanitizeToolArgs(startedArgs) } : {}),
          ...(resultContentSource ? { resultContentSource } : {}),
        },
        { args: tracked ? executedArgs : startedArgs },
      );
    }
  };
  // Display-only native events never enter host-tool correlation or delivery accounting.
  const emitCliToolUseStart = (event: CliToolUseStartDelta) => emitToolUseStart(event, true);
  const emitCliToolResult = (event: CliToolResult) => emitToolResult(event, true);
  const emitCliDisplayToolUseStart = (event: CliToolUseStartDelta) =>
    emitToolUseStart(event, false);
  const emitCliDisplayToolResult = (event: CliToolResult) => emitToolResult(event, false);
  const emitParsedToolUseStart = (event: CliToolUseStartDelta) => {
    const startedAt = Date.now();
    activeParsedTools.set(event.toolCallId, {
      startedAt,
      toolName: event.name,
      kind: event.kind,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: runParams.runId,
      sessionId: runParams.sessionId,
      ...(runParams.sessionKey ? { sessionKey: runParams.sessionKey } : {}),
      ...(runParams.agentId ? { agentId: runParams.agentId } : {}),
      toolName: event.name,
      toolSource: resolveCliToolSource(event.name, event.kind),
      toolOwner: "cli-runner",
      toolCallId: event.toolCallId,
    });
    emitToolUseStart(event, true, startedAt);
  };
  const emitParsedToolTerminal = (event: {
    toolCallId: string;
    name: string;
    isError: boolean;
    incomplete?: boolean;
  }): boolean => {
    const activeTool = activeParsedTools.get(event.toolCallId);
    activeParsedTools.delete(event.toolCallId);
    const trustedOutcome = params.toolTracking.resolveCliLoopbackTerminalOutcome(event.toolCallId);
    const toolName = activeTool?.toolName ?? event.name;
    const now = Date.now();
    const trustedTerminalReason =
      trustedOutcome &&
      trustedOutcome.outcome !== "blocked" &&
      trustedOutcome.outcome !== "completed" &&
      trustedOutcome.outcome !== "unknown"
        ? trustedOutcome.outcome
        : undefined;
    const runState = params.getRunState();
    const terminalReason =
      trustedTerminalReason ??
      resolveCliToolTerminalReason({
        error: event.incomplete ? runState.error : undefined,
        abortSignal: runParams.abortSignal,
      });
    // Incomplete client/MCP tools inherit the enclosing failed run even when
    // the loopback disconnect is ambiguous. Server-native tools do not.
    const useEnclosingTerminalReason =
      event.incomplete &&
      runState.failed &&
      activeTool !== undefined &&
      activeTool.kind !== "server_tool_use";
    const diagnosticBase = {
      runId: runParams.runId,
      sessionId: runParams.sessionId,
      ...(runParams.sessionKey ? { sessionKey: runParams.sessionKey } : {}),
      ...(runParams.agentId ? { agentId: runParams.agentId } : {}),
      toolName,
      toolSource: resolveCliToolSource(toolName, activeTool?.kind),
      toolOwner: "cli-runner",
      toolCallId: event.toolCallId,
      durationMs: Math.max(0, now - (activeTool?.startedAt ?? now)),
    };
    if (
      (trustedOutcome?.outcome === "unknown" && !useEnclosingTerminalReason) ||
      (event.incomplete && activeTool?.kind === "server_tool_use" && !trustedOutcome)
    ) {
      emitTrustedDiagnosticEvent({
        type: "tool.execution.error",
        ...diagnosticBase,
        errorCategory: "cli_tool_ambiguous",
        errorCode: "tool_outcome_unknown",
      });
      // Unknown or disconnected server-native tools are not completed calls.
      return false;
    }
    const trustedFailure = trustedOutcome !== undefined && trustedOutcome.outcome !== "completed";
    emitTrustedDiagnosticEvent(
      trustedOutcome?.outcome === "blocked"
        ? {
            type: "tool.execution.blocked",
            ...diagnosticBase,
            deniedReason: trustedOutcome.deniedReason,
            reason: "blocked by before-tool policy",
          }
        : trustedFailure || (!trustedOutcome && event.isError)
          ? {
              type: "tool.execution.error",
              ...diagnosticBase,
              errorCategory:
                terminalReason === "cancelled"
                  ? "aborted"
                  : event.incomplete && (!trustedOutcome || useEnclosingTerminalReason)
                    ? "cli_tool_incomplete"
                    : "cli_tool",
              terminalReason,
            }
          : { type: "tool.execution.completed", ...diagnosticBase },
    );
    return true;
  };
  const emitParsedToolResult = (event: CliToolResult) => {
    const completed = emitParsedToolTerminal(event);
    emitToolResult(event, true, completed);
  };
  const emitCliCompaction = (event: CliCompactionDelta) => {
    observedCliActivity = true;
    if (emitLiveEvents) {
      emitAgentEvent({
        runId: runParams.runId,
        stream: "compaction",
        data: {
          ...event,
          backend: context.backendResolved.id,
        },
      });
    }
  };
  const finalizeParsedTools = () => {
    for (const [toolCallId, activeTool] of Array.from(activeParsedTools)) {
      const completed = emitParsedToolTerminal({
        toolCallId,
        name: activeTool.toolName,
        isError: true,
        incomplete: true,
      });
      const startedCall = toolArgsByCallId.get(toolCallId);
      toolArgsByCallId.delete(toolCallId);
      if (!completed) {
        continue;
      }
      dispatchCliAfterToolCall({
        toolCallId,
        toolName: activeTool.toolName,
        startArgs: startedCall?.args ?? {},
        error: "tool execution incomplete",
        startedAt: startedCall?.startedAt ?? activeTool.startedAt,
      });
    }
  };
  const emitCliCommentaryText = (text: string) => {
    if (!emitLiveEvents) {
      return;
    }
    commentaryCounter += 1;
    emitAgentEvent({
      runId: runParams.runId,
      stream: "item",
      data: {
        kind: "preamble",
        itemId: `commentary-${runParams.runId}-${commentaryCounter}`,
        // The JSONL parser flushes a complete pre-tool text segment here.
        // Mark its boundary so channels can safely create their first notification.
        phase: "end",
        title: "commentary",
        status: "running",
        progressText: applyPluginTextReplacements(
          text,
          context.backendResolved.textTransforms?.output,
        ),
      },
    });
  };
  const emitCliAssistantDelta = ({ text, delta }: CliStreamingDelta) => {
    if (text || delta) {
      observedCliActivity = true;
      if (!signaledAssistantOutputStarted) {
        signaledAssistantOutputStarted = true;
        runParams.onExecutionPhase?.({
          phase: "assistant_output_started",
          provider: runParams.provider,
          model: context.modelId,
          backend: context.backendResolved.id,
        });
      }
    }
    if (emitLiveEvents) {
      emitAgentEvent({
        runId: runParams.runId,
        stream: "assistant",
        data: {
          text: applyPluginTextReplacements(text, context.backendResolved.textTransforms?.output),
          delta: applyPluginTextReplacements(delta, context.backendResolved.textTransforms?.output),
        },
      });
    }
  };

  // Emit-always: thinking reaches the event bus and session archive like the
  // embedded reasoning stream; /reasoning and /verbose gate presentation only.
  const emitCliThinkingDelta = ({ text, delta, isReasoningSnapshot }: CliThinkingDelta) => {
    if (text || delta) {
      observedCliActivity = true;
    }
    if (emitLiveEvents) {
      emitAgentEvent({
        runId: runParams.runId,
        stream: "thinking",
        data: { text, delta, ...(isReasoningSnapshot ? { isReasoningSnapshot } : {}) },
      });
    }
  };

  const emitCliThinkingProgress = ({ progressTokens }: CliThinkingProgress) => {
    observedCliActivity = true;
    if (emitLiveEvents) {
      emitAgentEvent({
        runId: runParams.runId,
        stream: "thinking",
        data: { progressTokens },
      });
    }
  };

  return {
    emitLiveEvents,
    emitCliToolUseStart,
    emitCliToolResult,
    emitCliDisplayToolUseStart,
    emitCliDisplayToolResult,
    emitParsedToolUseStart,
    emitParsedToolResult,
    emitCliCompaction,
    finalizeParsedTools,
    emitCliCommentaryText,
    emitCliAssistantDelta,
    emitCliThinkingDelta,
    emitCliThinkingProgress,
    hasObservedCliActivity: () => observedCliActivity,
    activeParsedToolCount: () => activeParsedTools.size,
    getToolSummary,
  };
}

export type CliEventHandlers = ReturnType<typeof createCliEventHandlers>;
