import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import {
  readSessionExecutionSelection,
  type ExecutionSelectionCodecMetadata,
} from "./execution-selection-codec.js";
import type { ExecutionSelection } from "./execution-selection.js";

/** Identity comes from prepared registration metadata, never login or executable readiness. */
export function executionSelectionCodecMetadata(
  cfg?: OpenClawConfig,
  defaultProvider?: string,
): ExecutionSelectionCodecMetadata {
  const registry = getPluginRegistryForContext();
  const metadata = getCurrentPluginMetadataSnapshot({
    config: cfg,
    allowSynchronousPolicyRead: false,
    allowWorkspaceScopedSnapshot: true,
  });
  return {
    defaultProvider,
    classifyExecutor(id) {
      if (id === "openclaw") {
        return "harness";
      }
      const harness =
        registry?.agentHarnesses.some((entry) => entry.harness.id === id) ||
        metadata?.plugins.some((plugin) => plugin.activation?.onAgentHarnesses?.includes(id));
      const cli =
        registry?.cliBackends.some((entry) => entry.backend.id === id) ||
        metadata?.owners.cliBackends.has(id);
      // A colliding or foreign id cannot recover an accepted executor.
      return harness && !cli ? "harness" : cli && !harness ? "cli" : undefined;
    },
  };
}

export function getSessionExecutionSelection(
  entry: Partial<SessionEntry> | undefined,
  cfg?: OpenClawConfig,
): ExecutionSelection | undefined {
  return readSessionExecutionSelection(entry, executionSelectionCodecMetadata(cfg));
}
