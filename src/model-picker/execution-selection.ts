/** A prepared model and its executor are one accepted session choice. */
export type HarnessExecutionSelection = {
  model: { provider: string; id: string };
  executor: { kind: "harness"; id: string };
};

export type CliExecutionSelection = {
  model: { provider: string; id: string };
  executor: { kind: "cli"; id: string };
};

export type NativeManagedExecutionSelection = {
  model: "native-managed";
  executor: { kind: "harness"; id: string };
};

export type AcpExecutionSelection = {
  model: { id: string } | "native-managed";
  executor: { kind: "acp"; backend: string; agent: string };
};

export type ModelExecutionSelection = HarnessExecutionSelection | CliExecutionSelection;
export type ExecutionSelection =
  | ModelExecutionSelection
  | NativeManagedExecutionSelection
  | AcpExecutionSelection;
export type ExecutionFallbackPermission = "configured" | "explicit";

export const SESSION_EXECUTION_SELECTION_TRANSACTION_FIELDS = [
  "executionSelection",
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
] as const;

/** Deferred requests preserve imported or legacy SDK intent without claiming an executor. */
export type DeferredExecutionSelectionRequest = {
  model?: { provider?: string; id: string } | "native-managed";
  runtime?: string;
  executor?: ExecutionSelection["executor"];
};

export type SessionExecutionSelection =
  | {
      state: "accepted";
      selection: ExecutionSelection;
      fallbackPermission: ExecutionFallbackPermission;
    }
  | {
      state: "deferred";
      request: DeferredExecutionSelectionRequest;
      fallbackPermission: ExecutionFallbackPermission;
      previous?: ExecutionSelection;
    };

export function isAcpExecutionSelection(
  selection: ExecutionSelection,
): selection is AcpExecutionSelection {
  return selection.executor.kind === "acp";
}

export function isModelExecutionSelection(
  selection: ExecutionSelection,
): selection is ModelExecutionSelection {
  return selection.executor.kind !== "acp" && selection.model !== "native-managed";
}
