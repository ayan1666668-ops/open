import { createHash } from "node:crypto";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildNativeHookRelayCommandPlan,
  type NativeHookRelayCommandPlan,
} from "openclaw/plugin-sdk/native-hook-relay-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexNativeProcessAuthority } from "./native-process-authority.js";

export const CODEX_NATIVE_PROCESS_ADMISSION_TOOLS = ["exec"] as const;

export type CodexNativeHookRelayCommandParams = {
  options:
    | {
        enabled?: boolean;
        ttlMs?: number;
        gatewayTimeoutMs?: number;
      }
    | undefined;
  generation?: string;
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  config: EmbeddedRunAttemptParams["config"];
  loopDetectionPreToolUseRelay: boolean;
  nativeProcessAuthority?: {
    owner: CodexNativeProcessAuthority;
    client: () => CodexAppServerClient;
  };
};

export function buildCodexNativeHookRelayCommandInputs(params: CodexNativeHookRelayCommandParams) {
  return {
    provider: "codex" as const,
    relayId: buildCodexNativeHookRelayId(params),
    generation: params.generation,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    config: params.config,
    preToolUseLoopDetection: params.loopDetectionPreToolUseRelay,
    // Planning must advertise the same required matcher that activation owns.
    executionAdmissionToolNames: params.nativeProcessAuthority
      ? CODEX_NATIVE_PROCESS_ADMISSION_TOOLS
      : undefined,
    command: {
      // Preparing and registering a relay must keep the same priority and deadline.
      // Niced callbacks leave CPU available for the active reply turn.
      nice: 10,
      timeoutMs: params.options?.gatewayTimeoutMs,
    },
  };
}

/** Prepare the same command inputs that activation registers, without live callbacks. */
export function buildCodexNativeHookRelayCommandPlan(
  params: CodexNativeHookRelayCommandParams & { generation: string },
): NativeHookRelayCommandPlan {
  return buildNativeHookRelayCommandPlan({
    ...buildCodexNativeHookRelayCommandInputs(params),
    generation: params.generation,
  });
}

/** Builds a stable relay id scoped to the agent and session identity. */
export function buildCodexNativeHookRelayId(params: {
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
}): string {
  const hash = createHash("sha256");
  hash.update("openclaw:codex:native-hook-relay:v1");
  hash.update("\0");
  hash.update(params.agentId?.trim() || "");
  hash.update("\0");
  hash.update(params.sessionKey?.trim() || params.sessionId);
  return `codex-${hash.digest("hex").slice(0, 40)}`;
}
