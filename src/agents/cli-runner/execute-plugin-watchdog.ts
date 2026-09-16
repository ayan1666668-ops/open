import { BLOCKED_TOOL_CALL_ABORT_FLOOR_MS } from "../../logging/diagnostic-run-activity.js";
import type { FailoverError } from "../failover-error.js";
import { cliBackendLog } from "./log.js";
import * as noOutputPolicy from "./no-output-timeout-policy.js";

// A host suspend freezes the whole process: pending timer ticks then overshoot
// their schedule far beyond any event-loop hiccup. The gateway host-thaw
// recovery already detects those freezes for channels and health; the CLI
// watchdog must not mistake frozen wall time for CLI silence, so it ticks at
// most every second and credits overshoots past the suspend threshold back to
// both the no-output budget and the overall run budget. Only the frozen span
// overlapping the current quiet interval is credited: output consumed after
// wake already restarted the budget at the post-wake time, so re-crediting
// the whole span would extend the fresh budget by the suspend duration twice.
const HOST_SUSPEND_TICK_THRESHOLD_MS = 45_000;
const WATCHDOG_TICK_MS = 1_000;

export type CliPluginWatchdog = {
  /** Record fresh CLI output and restart the no-output budget from now. */
  noteOutput: () => void;
  /** Recompute the no-output deadline; arms the ticker on first use. */
  reset: (delayMs?: number) => void;
  dispose: () => void;
};

export function createCliPluginWatchdog(params: {
  provider: string;
  model: string;
  sessionId: string;
  lane: string | undefined;
  overallTimeoutMs: number | undefined;
  noOutputTimeoutMs: number | undefined;
  useResume: boolean;
  getActiveAskUserDeadline?: () => number | undefined;
  activeToolCount: () => number;
  backgroundTaskCount: () => number;
  hasObservedActivity: () => boolean;
  hasReplayUnsafeActivity: () => boolean;
  onNoOutputTimeout: (error: FailoverError) => void;
  onOverallTimeout: () => void;
}): CliPluginWatchdog {
  const noOutputTimeoutMs = params.noOutputTimeoutMs;
  const overallTimeoutMs = params.overallTimeoutMs;
  let lastOutputAtMs = Date.now();
  let noOutputDeadlineMs = 0;
  let overallActiveRemainingMs = overallTimeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastTickAtMs = Date.now();
  let lastScheduledDelayMs = WATCHDOG_TICK_MS;

  const scheduleTick = () => {
    const nextDelayMs = Math.min(
      noOutputTimeoutMs === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, noOutputDeadlineMs - Date.now()),
      overallActiveRemainingMs ?? Number.POSITIVE_INFINITY,
      WATCHDOG_TICK_MS,
    );
    lastTickAtMs = Date.now();
    lastScheduledDelayMs = Math.max(1, nextDelayMs);
    timer = setTimeout(tick, lastScheduledDelayMs);
  };

  const tick = () => {
    timer = undefined;
    const nowMs = Date.now();
    const elapsedMs = Math.max(0, nowMs - lastTickAtMs);
    lastTickAtMs = nowMs;
    const suspendedMs =
      elapsedMs >= HOST_SUSPEND_TICK_THRESHOLD_MS
        ? Math.max(0, elapsedMs - lastScheduledDelayMs)
        : 0;
    if (suspendedMs > 0) {
      // Frozen process time is not CLI silence and must not drain either
      // budget; shift the quiet baseline and deadline by the frozen span that
      // actually overlaps the quiet interval. Output consumed after wake set
      // lastOutputAtMs to the post-wake time already, so a whole-span shift
      // here would double-credit the suspend and defer genuine-stall recovery.
      const frozenStartMs = nowMs - suspendedMs;
      const creditedMs = Math.max(0, nowMs - Math.max(lastOutputAtMs, frozenStartMs));
      lastOutputAtMs += creditedMs;
      noOutputDeadlineMs += creditedMs;
      cliBackendLog.info(
        `cli watchdog credited host-suspend time: provider=${params.provider} model=${params.model} suspendedMs=${Math.round(suspendedMs)} creditedMs=${Math.round(creditedMs)}`,
      );
    }
    const activeElapsedMs = elapsedMs - suspendedMs;
    if (overallActiveRemainingMs !== undefined) {
      overallActiveRemainingMs -= activeElapsedMs;
      if (overallActiveRemainingMs <= 0) {
        params.onOverallTimeout();
        return;
      }
    }
    if (noOutputTimeoutMs !== undefined && nowMs >= noOutputDeadlineMs) {
      const quietDurationMs = nowMs - lastOutputAtMs;
      const askUserDeadline = params.getActiveAskUserDeadline?.();
      const decision = noOutputPolicy.resolveCliNoOutputTimeoutDecision({
        context: {
          provider: params.provider,
          model: params.model,
          sessionId: params.sessionId,
          lane: params.lane,
        },
        timeoutMs: noOutputTimeoutMs,
        quietDurationMs,
        cliTimeout: {
          mode: "no-output",
          timeoutSeconds: Math.round(quietDurationMs / 1000),
          observedActivity: params.hasObservedActivity(),
          activeToolCount: params.activeToolCount(),
          backgroundTaskCount: params.backgroundTaskCount(),
        },
        hasOutputText: false,
        useResume: params.useResume,
        hasReplayUnsafeActivity: params.hasReplayUnsafeActivity(),
        allowResumeControlOnlyRetry: true,
        outstandingWorkGraceMs:
          askUserDeadline === undefined
            ? BLOCKED_TOOL_CALL_ABORT_FLOOR_MS
            : Math.max(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS, askUserDeadline - lastOutputAtMs),
      });
      if (decision.deferMs !== undefined) {
        noOutputDeadlineMs = nowMs + decision.deferMs;
      } else {
        params.onNoOutputTimeout(decision.error);
        return;
      }
    }
    if (noOutputTimeoutMs === undefined && overallTimeoutMs === undefined) {
      return;
    }
    scheduleTick();
  };

  const recomputeNoOutputDeadline = (delayMs?: number) => {
    if (noOutputTimeoutMs === undefined) {
      return;
    }
    const activeAskUserDeadline = params.getActiveAskUserDeadline?.();
    const baselineDeadline = lastOutputAtMs + noOutputTimeoutMs;
    const effectiveDelayMs =
      delayMs ??
      Math.max(
        0,
        (activeAskUserDeadline === undefined
          ? baselineDeadline
          : Math.max(baselineDeadline, activeAskUserDeadline)) - Date.now(),
      );
    noOutputDeadlineMs = Date.now() + effectiveDelayMs;
  };

  return {
    noteOutput: () => {
      lastOutputAtMs = Date.now();
      recomputeNoOutputDeadline();
      if (timer === undefined) {
        scheduleTick();
      }
    },
    reset: (delayMs?: number) => {
      recomputeNoOutputDeadline(delayMs);
      if (timer === undefined) {
        scheduleTick();
      }
    },
    dispose: () => {
      clearTimeout(timer);
    },
  };
}
