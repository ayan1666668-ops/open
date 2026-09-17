type FindTranscriptEvent =
  typeof import("../../../config/sessions/session-accessor.js").findTranscriptEvent;

type AssistantMessage = {
  role: "assistant";
  content: string;
  stopReason: "stop";
  __openclaw: { runId: string };
};

/** Serve canonical run-bound answers and recent chat from the same retained test history. */
export function createLifecycleRetryTranscriptFixture(
  resolveRunId: (sessionKey: string) => string | undefined,
) {
  const messagesBySessionKey = new Map<string, AssistantMessage[]>();
  const readHistory = (sessionKey: string) => messagesBySessionKey.get(sessionKey) ?? [];
  const findTranscriptEvent: FindTranscriptEvent = async ({ sessionKey }, matches) => {
    if (!sessionKey) {
      throw new Error("Lifecycle transcript fixture requires a session key");
    }
    const event = readHistory(sessionKey)
      .map((message) => ({ type: "message", message }))
      .findLast(matches);
    return event ? { event } : undefined;
  };

  function setAssistantOutput(sessionKey: string, text: string, runId?: string) {
    const sourceRunId = runId ?? resolveRunId(sessionKey);
    if (!sourceRunId) {
      throw new Error(`No registered run for assistant output in ${sessionKey}`);
    }
    messagesBySessionKey.set(sessionKey, [
      ...readHistory(sessionKey),
      {
        role: "assistant",
        content: text,
        stopReason: "stop",
        __openclaw: { runId: sourceRunId },
      },
    ]);
  }

  return {
    clear: () => messagesBySessionKey.clear(),
    readHistory,
    findTranscriptEvent,
    setAssistantOutput,
  };
}
