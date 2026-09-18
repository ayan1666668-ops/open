import type {
  ExecutionFallbackPermission,
  ModelExecutionSelection,
} from "../model-picker/execution-selection.js";

export function acceptedModelSelection(
  provider: string,
  id: string,
  options: {
    executor?: ModelExecutionSelection["executor"];
    fallbackPermission?: ExecutionFallbackPermission;
  } = {},
): {
  state: "accepted";
  selection: ModelExecutionSelection;
  fallbackPermission: ExecutionFallbackPermission;
} {
  return {
    state: "accepted",
    selection: {
      model: { provider, id },
      executor: options.executor ? { ...options.executor } : { kind: "harness", id: "openclaw" },
    },
    fallbackPermission: options.fallbackPermission ?? "explicit",
  };
}
