import type { CliSessionBinding, SessionEntry } from "../config/sessions.js";
import { getCliSessionBinding } from "../config/sessions/cli-session-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getSessionExecutionSelection } from "../model-picker/execution-selection.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "./agent-runtime-id.js";
import { isCliRuntimeAliasForProvider } from "./model-runtime-aliases.js";

/** The accepted executor owns selection; producer history and native handles do not select it. */
export function resolvePersistedSessionRuntimeId(
  entry?: Partial<SessionEntry>,
): string | undefined {
  const selection = getSessionExecutionSelection(entry);
  return selection && selection.executor.kind !== "acp" ? selection.executor.id : undefined;
}

/** Native transcript handles follow the accepted executor, never a compatible historical binding. */
export function resolveManualCompactionCliTarget(params: {
  provider?: string | null;
  entry?: Partial<SessionEntry>;
  cfg?: OpenClawConfig;
}): { agentHarnessId?: string; cliSessionBinding?: CliSessionBinding; cliSessionId?: string } {
  const runtime = resolvePersistedSessionRuntimeId(params.entry);
  if (!runtime) return {};
  const binding = getCliSessionBinding(params.entry, runtime);
  return { agentHarnessId: runtime, cliSessionBinding: binding, cliSessionId: binding?.sessionId };
}

/** Stateless compatibility for picker alternatives and isolated utility completions. */
export function resolveCompatibleAgentRuntimeForProvider(params: {
  provider?: string | null;
  runtime?: string | null;
  cfg?: OpenClawConfig;
}): string | undefined {
  const runtime = normalizeOptionalAgentRuntimeId(params.runtime);
  if (!runtime || isDefaultAgentRuntimeId(runtime)) return undefined;
  if (runtime === "openclaw") return runtime;
  const provider = params.provider?.trim().toLowerCase() ?? "";
  if (runtime === "codex" && (provider === "codex" || provider === "openai")) return runtime;
  return isCliRuntimeAliasForProvider({ provider, runtime, cfg: params.cfg }) ? runtime : undefined;
}
