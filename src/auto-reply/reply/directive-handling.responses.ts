/** Renders directive responses from the transaction owner's prepared facts. */
import {
  normalizeLowercaseStringOrEmpty,
  type FastMode,
} from "@openclaw/normalization-core/string-coerce";
import {
  formatFastModeCommandOptions,
  formatFastModeCurrentStatus,
  type resolveFastModeState,
} from "../../agents/fast-mode.js";
import { formatThinkingLevels, resolveSupportedThinkingLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { HandleDirectiveOnlyParams } from "./directive-handling.params.js";
import {
  DIRECTIVE_ACK_MESSAGES,
  type IgnoredSessionDirectiveFlag,
  formatDirectiveAck,
  formatElevatedRuntimeHint,
  formatElevatedUnavailableText,
  formatInternalExecPersistenceDeniedText,
  formatInternalVerboseCurrentReplyOnlyText,
  formatInternalVerbosePersistenceDeniedText,
  formatConfiguredDefaultSelectionAck,
  withOptions,
} from "./directive-handling.shared.js";
import type { ThinkLevel } from "./directives.js";

export function resolveDirectiveStatusResponse(
  params: Pick<
    HandleDirectiveOnlyParams,
    | "directives"
    | "currentThinkLevel"
    | "currentVerboseLevel"
    | "currentReasoningLevel"
    | "currentElevatedLevel"
    | "elevatedEnabled"
    | "elevatedAllowed"
    | "elevatedFailures"
    | "sessionKey"
  > & {
    thinkingPolicy: Omit<Parameters<typeof resolveSupportedThinkingLevel>[0], "level">;
    fastModeState: Pick<ReturnType<typeof resolveFastModeState>, "source" | "fastAutoOnSeconds">;
    effectiveFastMode: FastMode;
    currentTraceLevel?: HandleDirectiveOnlyParams["sessionEntry"]["traceLevel"];
    runtimeIsSandboxed: boolean;
    shouldHintDirectRuntime: boolean;
  },
): [ReplyPayload, IgnoredSessionDirectiveFlag] | undefined {
  const {
    directives,
    currentThinkLevel,
    currentVerboseLevel,
    currentReasoningLevel,
    currentElevatedLevel,
    elevatedEnabled,
    elevatedAllowed,
    thinkingPolicy,
    fastModeState,
    effectiveFastMode,
    currentTraceLevel,
    runtimeIsSandboxed,
    shouldHintDirectRuntime,
  } = params;
  const {
    provider: resolvedProvider,
    model: resolvedModel,
    catalog: thinkingCatalog,
    agentRuntime: thinkingRuntime,
  } = thinkingPolicy;
  if (directives.hasThinkDirective && !directives.thinkLevel && !directives.clearThinkLevel) {
    if (!directives.rawThinkLevel) {
      const level = resolveSupportedThinkingLevel({
        ...thinkingPolicy,
        level: currentThinkLevel ?? "off",
      });
      return [
        {
          text: withOptions(
            `Current thinking level: ${level}.`,
            `default, ${formatThinkingLevels(resolvedProvider, resolvedModel, ", ", thinkingCatalog, thinkingRuntime)}`,
          ),
        },
        "hasThinkDirective",
      ];
    }
    return [
      {
        text: `Unrecognized thinking level "${directives.rawThinkLevel}". Valid levels: default, ${formatThinkingLevels(resolvedProvider, resolvedModel, ", ", thinkingCatalog, thinkingRuntime)}.`,
      },
      "hasThinkDirective",
    ];
  }
  if (directives.hasVerboseDirective && !directives.verboseLevel) {
    return [
      {
        text: directives.rawVerboseLevel
          ? `Unrecognized verbose level "${directives.rawVerboseLevel}". Valid levels: off, on, full.`
          : withOptions(`Current verbose level: ${currentVerboseLevel ?? "off"}.`, "on, full, off"),
      },
      "hasVerboseDirective",
    ];
  }
  if (directives.hasTraceDirective && !directives.traceLevel) {
    return [
      {
        text: directives.rawTraceLevel
          ? `Unrecognized trace level "${directives.rawTraceLevel}". Valid levels: off, on, raw.`
          : withOptions(`Current trace level: ${currentTraceLevel ?? "off"}.`, "on, off, raw"),
      },
      "hasTraceDirective",
    ];
  }
  if (
    directives.hasFastDirective &&
    directives.fastMode === undefined &&
    !directives.clearFastMode
  ) {
    const isFastStatus = normalizeLowercaseStringOrEmpty(directives.rawFastMode) === "status";
    if (!directives.rawFastMode || isFastStatus) {
      const statusText = formatFastModeCurrentStatus({
        mode: effectiveFastMode,
        source: fastModeState.source,
        fastAutoOnSeconds: fastModeState.fastAutoOnSeconds,
      });
      return [
        {
          text: isFastStatus
            ? statusText
            : withOptions(
                statusText,
                formatFastModeCommandOptions({
                  fastAutoOnSeconds: fastModeState.fastAutoOnSeconds,
                }),
              ),
        },
        "hasFastDirective",
      ];
    }
    return [
      {
        text: `Unrecognized fast mode "${directives.rawFastMode}". Valid levels: on, off, auto, default, status.`,
      },
      "hasFastDirective",
    ];
  }
  if (directives.hasReasoningDirective && !directives.reasoningLevel) {
    return [
      {
        text: directives.rawReasoningLevel
          ? `Unrecognized reasoning level "${directives.rawReasoningLevel}". Valid levels: on, off, stream.`
          : withOptions(
              `Current reasoning level: ${currentReasoningLevel ?? "off"}.`,
              "on, off, stream",
            ),
      },
      "hasReasoningDirective",
    ];
  }
  if (directives.hasElevatedDirective) {
    if (!directives.elevatedLevel && directives.rawElevatedLevel) {
      return [
        {
          text: `Unrecognized elevated level "${directives.rawElevatedLevel}". Valid levels: off, on, ask, full.`,
        },
        "hasElevatedDirective",
      ];
    }
    if (!elevatedEnabled || !elevatedAllowed) {
      return [
        {
          text: formatElevatedUnavailableText({
            runtimeSandboxed: runtimeIsSandboxed,
            failures: params.elevatedFailures,
            sessionKey: params.sessionKey,
          }),
        },
        "hasElevatedDirective",
      ];
    }
    if (!directives.elevatedLevel) {
      const level = currentElevatedLevel ?? "off";
      return [
        {
          text: [
            withOptions(`Current elevated level: ${level}.`, "on, off, ask, full"),
            shouldHintDirectRuntime ? formatElevatedRuntimeHint() : null,
          ]
            .filter(Boolean)
            .join("\n"),
        },
        "hasElevatedDirective",
      ];
    }
  }
  return undefined;
}

export function buildDirectiveAcknowledgmentParts(
  params: Pick<HandleDirectiveOnlyParams, "directives"> &
    Parameters<typeof formatConfiguredDefaultSelectionAck>[0] & {
      allowPrivilegedPersistence: boolean;
      shouldHintDirectRuntime: boolean;
      modelSelection: boolean;
      modelAcknowledgment?: string;
      profileOverride?: string;
      shouldRemapUnsupportedThinkLevel: boolean;
      remappedUnsupportedThinkLevel?: ThinkLevel;
      nextThinkLevel?: ThinkLevel;
      resolvedProvider?: string;
      resolvedModel: string;
    },
): string[] {
  const {
    directives,
    allowPrivilegedPersistence,
    shouldHintDirectRuntime,
    modelSelection,
    modelAcknowledgment,
    profileOverride,
    configuredDefaultUpdate,
    shouldRemapUnsupportedThinkLevel,
    remappedUnsupportedThinkLevel,
    nextThinkLevel,
    resolvedProvider,
    resolvedModel,
  } = params;
  const parts: string[] = [];
  if (directives.clearThinkLevel) {
    parts.push("Thinking level reset to default.");
  } else if (directives.hasThinkDirective && directives.thinkLevel) {
    parts.push(
      directives.thinkLevel === "off"
        ? "Thinking disabled."
        : `Thinking level set to ${directives.thinkLevel}.`,
    );
  }
  if (directives.clearFastMode) {
    parts.push(formatDirectiveAck("Fast mode reset to default."));
  } else if (directives.hasFastDirective && directives.fastMode !== undefined) {
    parts.push(
      directives.fastMode === "auto"
        ? formatDirectiveAck("Fast mode set to auto.")
        : directives.fastMode
          ? formatDirectiveAck("Fast mode enabled.")
          : formatDirectiveAck("Fast mode disabled."),
    );
  }
  if (directives.hasVerboseDirective && directives.verboseLevel) {
    const message = allowPrivilegedPersistence
      ? DIRECTIVE_ACK_MESSAGES.verbose[directives.verboseLevel]
      : formatInternalVerboseCurrentReplyOnlyText();
    parts.push(formatDirectiveAck(message));
  }
  if (directives.hasTraceDirective && directives.traceLevel) {
    parts.push(formatDirectiveAck(DIRECTIVE_ACK_MESSAGES.trace[directives.traceLevel]));
  }
  if (directives.hasVerboseDirective && directives.verboseLevel && !allowPrivilegedPersistence) {
    parts.push(formatDirectiveAck(formatInternalVerbosePersistenceDeniedText()));
  }
  if (directives.hasReasoningDirective && directives.reasoningLevel) {
    parts.push(formatDirectiveAck(DIRECTIVE_ACK_MESSAGES.reasoning[directives.reasoningLevel]));
  }
  if (directives.hasElevatedDirective && directives.elevatedLevel) {
    parts.push(formatDirectiveAck(DIRECTIVE_ACK_MESSAGES.elevated[directives.elevatedLevel]));
    if (shouldHintDirectRuntime) {
      parts.push(formatElevatedRuntimeHint());
    }
  }
  if (directives.hasExecDirective && directives.hasExecOptions) {
    for (const [label, options] of [
      [
        allowPrivilegedPersistence && "Exec defaults set",
        { host: directives.execHost, node: directives.execNode },
      ],
      [
        "Exec policy for this run only",
        { security: directives.execSecurity, ask: directives.execAsk },
      ],
    ] as const) {
      const execParts = Object.entries(options)
        .filter(([, value]) => Boolean(value))
        .map(([key, value]) => `${key}=${value}`);
      if (execParts.length > 0) {
        const message = label
          ? `${label} (${execParts.join(", ")}).`
          : formatInternalExecPersistenceDeniedText();
        parts.push(formatDirectiveAck(message));
      }
    }
  }
  if (modelSelection) {
    if (modelAcknowledgment) {
      parts.push(modelAcknowledgment);
      const defaultAck = formatConfiguredDefaultSelectionAck({
        configuredDefaultUpdate,
        stickyModelSelectionTarget: params.stickyModelSelectionTarget,
      });
      if (defaultAck) {
        parts.push(defaultAck);
      }
    }
    if (profileOverride) {
      parts.push("Selected account updated.");
    }
  }
  // Report the model change before the thinking remap it triggered: the remap is a
  // consequence of the model switch, so the cause should be announced first.
  if (shouldRemapUnsupportedThinkLevel && remappedUnsupportedThinkLevel) {
    parts.push(
      `Thinking level set to ${remappedUnsupportedThinkLevel} (${nextThinkLevel} not supported for ${resolvedProvider}/${resolvedModel}).`,
    );
  }
  if (directives.hasQueueDirective && directives.queueMode) {
    parts.push(formatDirectiveAck(`Queue mode set to ${directives.queueMode}.`));
  } else if (directives.hasQueueDirective && directives.queueReset) {
    parts.push(formatDirectiveAck("Queue mode reset to default."));
  }
  if (directives.hasQueueDirective && typeof directives.debounceMs === "number") {
    parts.push(formatDirectiveAck(`Queue debounce set to ${directives.debounceMs}ms.`));
  }
  if (directives.hasQueueDirective && typeof directives.cap === "number") {
    parts.push(formatDirectiveAck(`Queue cap set to ${directives.cap}.`));
  }
  if (directives.hasQueueDirective && directives.dropPolicy) {
    parts.push(formatDirectiveAck(`Queue drop set to ${directives.dropPolicy}.`));
  }
  return parts;
}
