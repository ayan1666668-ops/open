import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import {
  isModelExecutionSelection,
  type ExecutionSelection,
  type PreparedSessionExecutionSelection,
} from "./execution-selection.js";

export function selectionDisplayNames(
  selection: ExecutionSelection,
  catalog: readonly ModelCatalogEntry[],
) {
  const registry = getPluginRegistryForContext();
  const model = isModelExecutionSelection(selection)
    ? (catalog.find(
        (entry) => entry.id === selection.model.id && entry.provider === selection.model.provider,
      )?.name ?? "the selected model")
    : selection.model === "native-managed"
      ? "the app's default model"
      : "the selected model";
  const executor = selection.executor;
  const cliOwner =
    executor.kind === "cli"
      ? registry?.cliBackends.find(({ backend }) => backend.id === executor.id)?.pluginId
      : undefined;
  const app =
    executor.kind === "acp"
      ? "the selected app"
      : executor.id === "openclaw"
        ? "OpenClaw"
        : (registry?.agentHarnesses.find(({ harness }) => harness.id === executor.id)?.harness
            .label ??
          registry?.plugins.find((plugin) => plugin.id === cliOwner)?.name ??
          "the selected app");
  return { model, app };
}

export function formatExecutionSelectionAcknowledgment(params: {
  selection: ExecutionSelection;
  before?: ExecutionSelection;
  reason: Extract<PreparedSessionExecutionSelection, { status: "ready" }>["reason"];
  catalog: readonly ModelCatalogEntry[];
}): string {
  const { model, app } = selectionDisplayNames(params.selection, params.catalog);
  if (params.reason === "reset") {
    return `Using the configured default: ${model} in ${app}.`;
  }
  if (params.reason === "unsupported" && params.before) {
    return `Now using ${model} in ${app}; ${selectionDisplayNames(params.before, params.catalog).app} cannot run it.`;
  }
  if (params.reason === "explicit") {
    return `Now using ${model} in ${app}.`;
  }
  return `Model changed to ${model}. Still using ${app}.`;
}
