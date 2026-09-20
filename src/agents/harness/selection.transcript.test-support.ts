import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";

export function createTranscriptAnchor(
  entryId: string,
  rawSeq: number,
  activeMessagePosition: number,
): TranscriptEntryAnchor {
  return {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    storePath: "/tmp/openclaw-agent.sqlite",
    generation: "generation-1",
    entryId,
    effectiveParentId: rawSeq === 1 ? null : "user-1",
    rawSeq,
    activeMessagePosition,
  };
}

export function createTranscriptRecorder(
  admission: ReturnType<typeof createTranscriptAnchor> & {
    logicalTurnId: string;
    role: "user";
  },
): UserTurnTranscriptRecorder {
  const message = { role: "user" as const, content: "hello", timestamp: 1 };
  return {
    message,
    resolveMessage: async () => message,
    getAdmissionReceipt: () => admission,
    markRuntimePersistencePending: () => {},
    markRuntimePersisted: () => {},
    markBlocked: () => {},
    hasPersisted: () => true,
    isBlocked: () => false,
    hasRuntimePersistencePending: () => false,
    waitForRuntimePersistence: async () => {},
    persistApproved: async () => undefined,
    persistBlocked: async () => undefined,
    persistFallback: async () => undefined,
  };
}
