import type {
  EmbeddedRunAttemptParamsV2,
  NativeHookRelayEvent,
  registerNativeHookRelay,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { registerNativeHookRelayForBundledRuntime } from "openclaw/plugin-sdk/native-hook-relay-runtime";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import {
  CODEX_NATIVE_HOOK_RELAY_EVENTS,
  type CodexNativePreToolUseFailure,
} from "./native-hook-relay.js";

const CODEX_SIDE_NATIVE_HOOK_RELAY_MIN_TTL_MS = 30 * 60_000;
const CODEX_SIDE_NATIVE_HOOK_RELAY_TTL_GRACE_MS = 5 * 60_000;
const CODEX_SIDE_NATIVE_HOOK_RELAY_STARTUP_REQUEST_COUNT = 3;
const CODEX_SIDE_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS =
  CODEX_NATIVE_HOOK_RELAY_EVENTS.filter((event) => event !== "permission_request");
export function resolveCodexSideNativeHookRelayEvents(params: {
  configuredEvents?: readonly NativeHookRelayEvent[];
  approvalPolicy: CodexAppServerRuntimeOptions["approvalPolicy"];
}): readonly NativeHookRelayEvent[] {
  if (params.configuredEvents?.length) {
    return params.configuredEvents;
  }
  return params.approvalPolicy === "never"
    ? CODEX_NATIVE_HOOK_RELAY_EVENTS
    : CODEX_SIDE_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS;
}

export function registerCodexSideNativeHookRelay(params: {
  options: {
    enabled?: boolean;
    ttlMs?: number;
    gatewayTimeoutMs?: number;
  };
  events: readonly NativeHookRelayEvent[];
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  config: EmbeddedRunAttemptParamsV2["config"];
  autoApproveMcpTools: boolean;
  projectedMcpServers: Parameters<typeof registerNativeHookRelay>[0]["projectedMcpServers"];
  runId: string;
  channelId?: string;
  requestTimeoutMs: number;
  completionTimeoutMs: number;
  loopDetectionPreToolUseRelay: boolean;
  signal: AbortSignal;
  hostCapabilities: EmbeddedRunAttemptParamsV2["hostCapabilities"];
  assertCurrent: () => void;
  onPreToolUseFailure: (failure: CodexNativePreToolUseFailure) => void;
}): ReturnType<typeof registerNativeHookRelayForBundledRuntime> | undefined {
  if (params.options.enabled === false) {
    return undefined;
  }
  return registerNativeHookRelayForBundledRuntime({
    provider: "codex",
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.config ? { config: params.config } : {}),
    autoApproveMcpTools: params.autoApproveMcpTools,
    projectedMcpServers: params.projectedMcpServers,
    runId: params.runId,
    ...(params.channelId ? { channelId: params.channelId } : {}),
    allowedEvents: params.events,
    preToolUseLoopDetection: params.loopDetectionPreToolUseRelay,
    ttlMs: resolveCodexSideNativeHookRelayTtlMs({
      explicitTtlMs: params.options.ttlMs,
      requestTimeoutMs: params.requestTimeoutMs,
      completionTimeoutMs: params.completionTimeoutMs,
    }),
    signal: params.signal,
    runBeforeToolCall: params.hostCapabilities.runBeforeToolCall,
    assertActive: params.assertCurrent,
    onPreToolUseFailure: params.onPreToolUseFailure,
    command: {
      timeoutMs: params.options.gatewayTimeoutMs,
    },
  });
}

function resolveCodexSideNativeHookRelayTtlMs(params: {
  explicitTtlMs: number | undefined;
  requestTimeoutMs: number;
  completionTimeoutMs: number;
}): number {
  if (params.explicitTtlMs !== undefined) {
    return params.explicitTtlMs;
  }
  const relayBudgetMs =
    params.requestTimeoutMs * CODEX_SIDE_NATIVE_HOOK_RELAY_STARTUP_REQUEST_COUNT +
    params.completionTimeoutMs +
    CODEX_SIDE_NATIVE_HOOK_RELAY_TTL_GRACE_MS;
  return Math.max(CODEX_SIDE_NATIVE_HOOK_RELAY_MIN_TTL_MS, Math.floor(relayBudgetMs));
}
