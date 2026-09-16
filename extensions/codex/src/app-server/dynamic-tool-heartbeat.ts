import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";

type HeartbeatToolParams = Pick<
  EmbeddedRunAttemptParams,
  "trigger" | "enableHeartbeatTool" | "forceHeartbeatTool"
>;

/** Resolves the host-required heartbeat result tool for both live and catalog builds. */
export function resolveCodexHeartbeatToolEnabled(
  params: HeartbeatToolParams,
  forceHeartbeatTool?: boolean,
): boolean {
  return (
    params.trigger === "heartbeat" ||
    params.enableHeartbeatTool === true ||
    params.forceHeartbeatTool === true ||
    forceHeartbeatTool === true
  );
}
