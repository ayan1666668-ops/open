import { assistantStreamPartOccurrence } from "./chat-progress.ts";
import type { BuildChatItemsProps } from "./chat-thread-build.ts";
import { visibleAssistantStreamParts } from "./stream-reconciliation.ts";

/** Rendering uses the same raw source boundaries as retirement, before sanitizing display text. */
export function prepareChatStreamProjection(props: BuildChatItemsProps) {
  const state = {
    sessionKey: props.sessionKey,
    chatRunId: props.runId,
    chatRunLifecycleGeneration: props.runLifecycleGeneration,
    chatStream: props.stream,
    chatStreamStartedAt: props.streamStartedAt,
    chatStreamSegments: props.streamSegments,
    chatQueue: props.queue,
    chatToolMessages: props.toolMessages,
  };
  const parts = visibleAssistantStreamParts(state, { isHiddenStreamText: () => false });
  const current = parts.find((part) => part.source === "current");
  return {
    parts,
    currentKey: current && assistantStreamPartOccurrence(state, current),
    segmentKeys: new Map(
      parts.flatMap((part) =>
        part.segmentIndex === undefined
          ? []
          : [
              [
                props.streamSegments[part.segmentIndex],
                assistantStreamPartOccurrence(state, part),
              ] as const,
            ],
      ),
    ),
  };
}
