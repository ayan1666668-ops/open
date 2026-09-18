/** Parses runtime intent; the selection owner evaluates executor compatibility. */
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
} from "../../agents/agent-runtime-id.js";

export function resolveModelRuntimeDirective(
  rawRuntime?: string,
): { kind: "unchanged" } | { kind: "clear" } | { kind: "set"; runtime: string } {
  if (!rawRuntime?.trim()) {
    return { kind: "unchanged" };
  }
  const runtime = normalizeOptionalAgentRuntimeId(rawRuntime);
  return runtime && !isDefaultAgentRuntimeId(runtime)
    ? { kind: "set", runtime }
    : { kind: "clear" };
}
