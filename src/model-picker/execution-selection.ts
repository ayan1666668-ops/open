/** The accepted model and its execution owner are one indivisible session fact. */
export type HarnessExecutionSelection = {
  model: { provider: string; id: string };
  executor: { kind: "harness"; id: string };
};

export type CliExecutionSelection = {
  model: { provider: string; id: string };
  executor: { kind: "cli"; id: string };
};

export type AcpExecutionSelection = {
  model: { id: string } | null;
  executor: { kind: "acp"; backend: string; agent: string };
};

export type ModelExecutionSelection = HarnessExecutionSelection | CliExecutionSelection;
export type ExecutionSelection = ModelExecutionSelection | AcpExecutionSelection;

export function isAcpExecutionSelection(
  selection: ExecutionSelection,
): selection is AcpExecutionSelection {
  return selection.executor.kind === "acp";
}
