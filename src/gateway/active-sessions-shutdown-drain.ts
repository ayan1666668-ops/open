import { buildSessionEndHookPayload } from "../auto-reply/reply/session-hooks.js";
import { logVerbose } from "../globals.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  forgetActiveSessionForShutdown,
  listActiveSessionsForShutdown,
} from "./active-sessions-shutdown-tracker.js";
import { resolveStableSessionEndTranscript } from "./session-transcript-files.fs.js";

export async function drainActiveSessionsForShutdown(params: {
  reason: "shutdown" | "restart";
  totalTimeoutMs?: number;
}): Promise<{ emittedSessionIds: string[]; timedOut: boolean }> {
  const tracked = listActiveSessionsForShutdown();
  if (tracked.length === 0) {
    return { emittedSessionIds: [], timedOut: false };
  }
  const totalTimeoutMs = Math.max(100, Math.floor(params.totalTimeoutMs ?? 2_000));
  const emittedSessionIds: string[] = [];
  const hookRunner = getGlobalHookRunner();
  let settledEmissions = 0;
  let timedOut = false;
  // Start all emissions before the bounded aggregate so one slow plugin cannot
  // prevent later tracked sessions from receiving session_end.
  const drain = Promise.allSettled(
    tracked.map(async (entry) => {
      // Claim the entry before dispatch: the tracker is process-global while
      // drains are instance-local, so an overlapping drain must not select a
      // session whose hook is already running. Only settlement before the
      // timeout verdict counts as emitted; interrupted sessions stay claimed
      // and discharged per the documented fail-open budget.
      forgetActiveSessionForShutdown(entry.sessionId);
      const record = () => {
        if (!timedOut) {
          emittedSessionIds.push(entry.sessionId);
        }
      };
      try {
        if (!hookRunner?.hasHooks("session_end")) {
          record();
          return;
        }
        const transcript = resolveStableSessionEndTranscript({
          sessionId: entry.sessionId,
          storePath: entry.storePath,
          sessionFile: entry.sessionFile,
          agentId: entry.agentId,
        });
        const payload = buildSessionEndHookPayload({
          sessionId: entry.sessionId,
          sessionKey: entry.sessionKey,
          agentId: entry.agentId,
          reason: params.reason,
          sessionFile: transcript.sessionFile,
          transcriptArchived: transcript.transcriptArchived,
        });
        await hookRunner.runSessionEnd(payload.event, payload.context);
        record();
      } catch (err) {
        logVerbose(`session_end hook failed during shutdown drain: ${String(err)}`);
        // A settled-with-error attempt still discharges this drain's obligation.
        record();
      } finally {
        settledEmissions++;
      }
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), totalTimeoutMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([drain.then(() => "ok" as const), timeout]);
    if (result === "timeout") {
      timedOut = true;
      logVerbose(
        `shutdown session-end drain timed out after ${totalTimeoutMs}ms with ${tracked.length - settledEmissions} session_end handler(s) still pending`,
      );
      return { emittedSessionIds, timedOut: true };
    }
    return { emittedSessionIds, timedOut: false };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
