/** Resolves and applies explicit runtime selections attached to `/model`. */
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
} from "../../agents/agent-runtime-id.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import {
  resolveCompatibleAgentRuntimeForProvider,
  resolveSessionRuntimeOverrideForProvider,
} from "../../agents/session-runtime-compat.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type ModelRuntimeDirectiveResolution =
  | { kind: "unchanged" }
  | { kind: "clear" }
  | { kind: "set"; runtime: string }
  | { kind: "invalid"; runtime: string; errorText: string };

/** Validates a requested runtime against the provider selected by the same directive. */
export function resolveModelRuntimeDirective(params: {
  rawRuntime?: string;
  provider: string;
  cfg: OpenClawConfig;
  sessionEntry?: Pick<SessionEntry, "agentRuntimeOverride">;
}): ModelRuntimeDirectiveResolution {
  const rawRuntime = params.rawRuntime?.trim();
  if (!rawRuntime) {
    return { kind: "unchanged" };
  }

  const runtime = normalizeOptionalAgentRuntimeId(rawRuntime);
  if (isDefaultAgentRuntimeId(runtime)) {
    return { kind: "clear" };
  }

  const provider = normalizeProviderId(params.provider);
  const compatibleRuntime = resolveCompatibleAgentRuntimeForProvider({
    provider,
    runtime,
    cfg: params.cfg,
  });
  if (compatibleRuntime) {
    return { kind: "set", runtime: compatibleRuntime };
  }

  return {
    kind: "invalid",
    runtime: rawRuntime,
    errorText: `Runtime "${rawRuntime}" is not supported for ${provider || params.provider}.`,
  };
}
