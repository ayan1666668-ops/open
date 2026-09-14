import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection-cli.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import type { GatewayAgentRuntime } from "../../shared/session-types.js";
import { resolveWorkerPlacementCapabilities } from "./placement-capabilities.js";
import type { WorkerPlacementExecutionMode } from "./placement-record.js";

export { resolveWorkerPlacementCapabilities } from "./placement-capabilities.js";

/** Dispatch and projection share CLI precedence and automatic harness selection. */
export function resolveWorkerPlacementSessionRuntime(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  agentId: string;
  sessionKey: string;
  model?: ReturnType<typeof resolveSessionModelRef>;
}): string {
  const selectedModel =
    params.model ?? resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  const sessionRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
    provider: selectedModel.provider,
    entry: params.entry,
    cfg: params.cfg,
  });
  const pinnedHarnessId = resolveSessionPinnedHarnessId(params.entry);
  const locksPersistedHarness =
    pinnedHarnessId !== undefined && pinnedHarnessId === sessionRuntimeOverride;
  const pinnedCliRuntime =
    !locksPersistedHarness &&
    sessionRuntimeOverride &&
    isCliProvider(sessionRuntimeOverride, params.cfg)
      ? sessionRuntimeOverride
      : undefined;
  // When a non-CLI override is active the dispatch path skips CLI aliasing
  // entirely and runs the embedded runtime; the guard must not reject that.
  const cliExecutionProvider =
    pinnedCliRuntime ??
    (sessionRuntimeOverride
      ? undefined
      : resolveCliRuntimeExecutionProvider({
          provider: selectedModel.provider,
          cfg: params.cfg,
          agentId: params.agentId,
          modelId: selectedModel.model,
          authProfileId: params.entry.authProfileOverride,
        }));
  const useCliExecution =
    pinnedCliRuntime !== undefined ||
    (!sessionRuntimeOverride &&
      isCliProvider(cliExecutionProvider ?? selectedModel.provider, params.cfg));
  if (useCliExecution) {
    return cliExecutionProvider ?? selectedModel.provider;
  }
  return resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider: selectedModel.provider,
    modelId: selectedModel.model,
    agentScope: { kind: "prepared", agentId: params.agentId },
    sessionKey: params.sessionKey,
    sessionEntry: params.entry,
  });
}

export function resolveWorkerPlacementExecutionMode(
  runtime: string,
): WorkerPlacementExecutionMode | undefined {
  return resolveWorkerPlacementCapabilities(runtime).executionMode;
}

export function resolveWorkerPlacementSessionRuntimeCapabilities(
  params: Parameters<typeof resolveWorkerPlacementSessionRuntime>[0],
) {
  return resolveWorkerPlacementCapabilities(resolveWorkerPlacementSessionRuntime(params));
}

export function projectWorkerPlacementAgentRuntime(
  runtime: GatewayAgentRuntime,
): GatewayAgentRuntime & {
  cloudPlacementSupported: boolean;
  cloudPlacementExecutionMode?: WorkerPlacementExecutionMode;
  devicePlacement?: NonNullable<GatewayAgentRuntime["devicePlacement"]>;
  devicePlacementSupported: boolean;
} {
  const { source, ...identity } = runtime;
  const { executionMode, devicePlacement } = resolveWorkerPlacementCapabilities(runtime.id);
  return {
    ...identity,
    cloudPlacementSupported: executionMode !== undefined,
    ...(executionMode ? { cloudPlacementExecutionMode: executionMode } : {}),
    ...(devicePlacement ? { devicePlacement } : {}),
    devicePlacementSupported: devicePlacement !== undefined,
    source,
  };
}
