import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection-cli.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import type { GatewayAgentRuntime } from "../../shared/session-types.js";
import { resolveSessionSelectedModelRef } from "../session-utils-model-selection.js";
import {
  createGatewaySessionEntryReader,
  resolveGatewaySessionStoreTargetWithStore,
} from "../session-utils-store-lookup.js";
import { resolveWorkerPlacementCapabilities } from "./placement-capabilities.js";
import type { WorkerPlacementExecutionMode } from "./placement-record.js";

export { resolveWorkerPlacementCapabilities } from "./placement-capabilities.js";

/** Dispatch and projection share CLI precedence and automatic harness selection. */
export function resolveWorkerPlacementSessionRuntime(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  agentId: string;
  sessionKey: string;
}): string {
  const selectedModel = resolveSessionSelectedModelRef({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    source: {
      entry: params.entry,
      loadSessionEntry: (key) => {
        const target = resolveGatewaySessionStoreTargetWithStore({
          cfg: params.cfg,
          agentId: params.agentId,
          key: params.sessionKey,
          clone: false,
          readOnly: true,
          exactRead: true,
        });
        return createGatewaySessionEntryReader({ ...target, cfg: params.cfg })(key);
      },
    },
  });
  return resolveWorkerPlacementModelRuntime({
    ...params,
    provider: selectedModel.provider,
    model: selectedModel.model,
  });
}

/** Resolve the placement runtime from the selected facts shared by reads and admission. */
export function resolveWorkerPlacementModelRuntime(
  params: Parameters<typeof resolveWorkerPlacementSessionRuntime>[0] & {
    provider: string;
    model: string;
  },
): string {
  const sessionRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
    provider: params.provider,
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
          provider: params.provider,
          cfg: params.cfg,
          agentId: params.agentId,
          modelId: params.model,
          authProfileId: params.entry.authProfileOverride,
        }));
  const useCliExecution =
    pinnedCliRuntime !== undefined ||
    (!sessionRuntimeOverride && isCliProvider(cliExecutionProvider ?? params.provider, params.cfg));
  if (useCliExecution) {
    return cliExecutionProvider ?? params.provider;
  }
  return resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.model,
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
