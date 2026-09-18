import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  readSessionExecutionRepairModel,
  repairSessionExecutionSelection,
} from "../../../model-picker/execution-selection-repair.js";
import { isModelSelectionLocked } from "../../../sessions/model-overrides.js";
import type { ModelRefRepairResolver } from "./retired-model-ref-repair.js";

/** Session selection owns invalidation of context/fallback metadata and profile preservation. */
export function repairRetiredSessionModelRef(
  entry: SessionEntry,
  agentId: string,
  resolve: ModelRefRepairResolver,
  defaultModelRef: string | undefined,
  warnings: string[],
  cfg: OpenClawConfig,
): boolean {
  const model = readSessionExecutionRepairModel(entry);
  if (!model || isModelSelectionLocked(entry)) {
    return false;
  }
  const modelRef = model.provider ? `${model.provider}/${model.id}` : model.id;
  const decision = resolve({
    modelRef,
    agentId,
    authProfileId: entry.authProfileOverride,
    authProfileSource: entry.authProfileOverrideSource,
  });
  if (decision.kind === "unchanged") {
    return false;
  }
  const replacement = splitTrailingAuthProfile(
    decision.kind === "replace" ? decision.modelRef : (defaultModelRef ?? ""),
  ).model;
  if (
    decision.kind === "clear" &&
    replacement === decision.modelRef &&
    entry.authProfileOverride &&
    (entry.authProfileOverrideSource === "user" || entry.authProfileOverrideSource === "user-link")
  ) {
    const warning = `Retained retired ${decision.modelRef} for agent "${agentId}": clearing this session override would still select it with the same pinned account. Choose a supported default or an allowed model override, then rerun openclaw doctor --fix.`;
    if (!warnings.includes(warning)) {
      warnings.push(warning);
    }
    return false;
  }
  const slash = replacement.indexOf("/");
  const repair = repairSessionExecutionSelection({
    entry,
    cfg,
    agentId,
    ...(decision.kind === "replace"
      ? { model: { provider: replacement.slice(0, slash), id: replacement.slice(slash + 1) } }
      : {}),
    reset: decision.kind === "clear",
    preserveAuthProfileOverride:
      decision.kind === "replace" || replacement.slice(0, slash) === decision.provider,
  });
  if (repair.status === "unresolved") {
    const warning = `Session model repair for agent "${agentId}" needs its configured executor. The existing model and pin were retained.`;
    if (!warnings.includes(warning)) {
      warnings.push(warning);
    }
  }
  if (repair.status === "repaired") {
    delete entry.model;
    delete entry.modelProvider;
    delete entry.contextTokens;
    delete entry.contextTokensSource;
    delete entry.contextBudgetStatus;
    delete entry.fallbackNotice;
    return true;
  }
  return false;
}
