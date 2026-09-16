import type { PluginDiagnostic } from "./manifest-types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { PLUGIN_AVAILABILITY_POLICY } from "./runtime-degraded-state.js";

export const CONFIGURED_PLUGIN_PATH_UNAVAILABLE = "configured-plugin-path-unavailable";

export function unavailablePluginPathDiagnostic(
  source: string,
  origin: PluginOrigin,
): PluginDiagnostic {
  return origin === "config"
    ? {
        level: "warn",
        code: CONFIGURED_PLUGIN_PATH_UNAVAILABLE,
        configDisposition: "preserve",
        source,
        message: `Configured plugin load path is unavailable: ${source}. Uninspected plugin configuration is preserved. Restore access to the path, then run \`${PLUGIN_AVAILABILITY_POLICY.repairCommand}\`.`,
      }
    : { level: "error", source, message: `plugin path not found: ${source}` };
}

/** Consumers consult discovery's disposition without reclassifying availability. */
export function findUninspectedPluginDiagnostic(diagnostics: readonly PluginDiagnostic[]) {
  return diagnostics.find((diagnostic) => diagnostic.configDisposition === "preserve");
}

/** Project the recorded fact onto a config surface whose owner could not be inspected. */
export function pluginDiagnosticToConfigWarning(diagnostic: PluginDiagnostic, path: string) {
  return { path, message: diagnostic.message, code: diagnostic.code, source: diagnostic.source };
}

/** Missing metadata cannot prove that authored plugin configuration is stale. */
export function hasIncompletePluginDiscovery(diagnostics: readonly PluginDiagnostic[]): boolean {
  return diagnostics.some(
    (diagnostic) => diagnostic.level === "error" || diagnostic.configDisposition === "preserve",
  );
}
