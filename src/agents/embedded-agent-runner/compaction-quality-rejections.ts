import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";

const NOTICE_THRESHOLD = 3;
const MAX_TRACKED_SESSIONS = 1024;
type RejectionStreak = { count: number; reasonCodes: string[]; notified: boolean };

// SessionManager instances are reopened between attempts. Use the resolved storage
// identity instead; this bounded diagnostic state intentionally resets on restart.
const streaks = new Map<string, RejectionStreak>();

function sessionIdentity(target: SessionTranscriptRuntimeTarget): string {
  return JSON.stringify([target.storePath, target.agentId, target.sessionKey, target.sessionId]);
}

export function clearCompactionQualityRejections(target: SessionTranscriptRuntimeTarget): void {
  streaks.delete(sessionIdentity(target));
}

export function recordCompactionQualityRejection(
  target: SessionTranscriptRuntimeTarget,
  reasonCodes: string[],
  modelSelectionLocked = false,
): { notice?: string; notify: boolean; log?: boolean; acknowledgeNotice?: () => void } {
  const key = sessionIdentity(target);
  const previous = streaks.get(key);
  const count = Math.min((previous?.count ?? 0) + 1, NOTICE_THRESHOLD);
  const codes = [...new Set([...(previous?.reasonCodes ?? []), ...reasonCodes])];
  const streak = previous ?? { count: 0, reasonCodes: [], notified: false };
  const crossedThreshold = streak.count < NOTICE_THRESHOLD && count === NOTICE_THRESHOLD;
  streak.count = count;
  streak.reasonCodes = codes;
  streaks.delete(key);
  streaks.set(key, streak);
  if (streaks.size > MAX_TRACKED_SESSIONS) {
    const oldest = streaks.keys().next().value;
    if (oldest !== undefined) {
      streaks.delete(oldest);
    }
  }
  if (count < NOTICE_THRESHOLD) {
    return { notify: false };
  }
  return {
    notify: !streak.notified,
    log: crossedThreshold,
    acknowledgeNotice: () => {
      if (streaks.get(key) === streak) {
        streak.notified = true;
      }
    },
    notice:
      "Compaction repeatedly failed quality checks; conversation history is preserved. " +
      `Reasons: ${codes.join(", ")}. ` +
      (modelSelectionLocked
        ? "Retry with /compact."
        : "Retry with /compact, or configure agents.defaults.compaction.model to use another " +
          "summarization model and retry."),
  };
}
