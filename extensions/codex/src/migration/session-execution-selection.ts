import type {
  HarnessExecutionSelection,
  NativeManagedExecutionSelection,
} from "openclaw/plugin-sdk/model-session-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Only Doctor reads the retired native model fields; ordinary output is not selection intent. */
export function projectLegacyNativeExecutionSelection(
  value: unknown,
):
  | { kind: "none" }
  | { kind: "unresolved"; reason: string }
  | { kind: "ready"; selection: HarnessExecutionSelection | NativeManagedExecutionSelection } {
  const stored = asOptionalRecord(value);
  const binding = asOptionalRecord(stored?.binding);
  if (stored?.version !== 1 || stored.state !== "active" || binding?.preserveNativeModel !== true)
    return { kind: "none" };
  const model = typeof binding.model === "string" ? binding.model.trim() : "";
  const provider = typeof binding.modelProvider === "string" ? binding.modelProvider.trim() : "";
  const executor = { kind: "harness" as const, id: "codex" };
  if (model && provider)
    return { kind: "ready", selection: { model: { provider, id: model }, executor } };
  if (binding.connectionScope === "supervision")
    return { kind: "ready", selection: { model: "native-managed", executor } };
  return {
    kind: "unresolved",
    reason:
      "The attached session needs its native model and provider before host authentication can resume.",
  };
}

/** Invoke only after the canonical agent-row selection has committed. */
export function retireLegacyNativeModelFields(value: unknown): unknown {
  const stored = asOptionalRecord(value);
  const binding = asOptionalRecord(stored?.binding);
  if (!stored || !binding) return value;
  const { model: _model, modelProvider: _provider, ...lifecycle } = binding;
  return { ...stored, binding: lifecycle };
}
