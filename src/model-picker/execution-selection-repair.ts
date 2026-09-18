import { isDeepStrictEqual } from "node:util";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { commitStoredSessionExecutionSelection } from "./apply-session-model-selection.js";
import { isModelExecutionSelection, type ModelExecutionSelection } from "./execution-selection.js";

export function readSessionExecutionRepairModel(
  entry: Partial<SessionEntry>,
): { provider?: string; id: string } | undefined {
  const fact = entry.executionSelection;
  if (!fact) {
    return undefined;
  }
  if (fact.state === "accepted") {
    return isModelExecutionSelection(fact.selection) ? fact.selection.model : undefined;
  }
  return fact.request.model === "native-managed" ? undefined : fact.request.model;
}

export function readSessionExecutionRepairRef(entry: Partial<SessionEntry>): {
  provider?: string;
  model?: string;
  runtime?: string;
} {
  const model = readSessionExecutionRepairModel(entry);
  const fact = entry.executionSelection;
  const executor = fact?.state === "accepted" ? fact.selection.executor : fact?.request.executor;
  return {
    provider: model?.provider,
    model: model?.id,
    runtime:
      executor && executor.kind !== "acp"
        ? executor.id
        : fact?.state === "deferred"
          ? fact.request.runtime
          : undefined,
  };
}

export function admitAutomaticProviderlessModelRepair(
  entry: Partial<SessionEntry>,
): string | undefined {
  const fact = entry.executionSelection;
  const model = readSessionExecutionRepairModel(entry);
  return fact?.state === "deferred" &&
    fact.fallbackPermission === "configured" &&
    model &&
    !model.provider
    ? model.id
    : undefined;
}

/** Doctor stages corrected intent; the selection owner checks readiness before the next turn. */
export function repairSessionExecutionSelection(params: {
  entry: SessionEntry;
  cfg?: OpenClawConfig;
  agentId?: string;
  model?: ModelExecutionSelection["model"];
  executor?: ModelExecutionSelection["executor"];
  runtimeMigration?: (id: string) => ModelExecutionSelection["executor"] | undefined;
  reset?: boolean;
  preserveAuthProfileOverride?: boolean;
}): { status: "unchanged" | "unresolved" | "repaired" } {
  const fact = params.entry.executionSelection;
  const priorExecutor =
    fact?.state === "accepted" ? fact.selection.executor : fact?.request.executor;
  if (params.entry.modelSelectionLocked || params.entry.acp || priorExecutor?.kind === "acp") {
    return { status: "unchanged" };
  }
  const configured =
    params.cfg && params.agentId
      ? resolveDefaultModelForAgent({
          cfg: params.cfg,
          agentId: params.agentId,
          allowPluginNormalization: false,
        })
      : undefined;
  const currentModel = readSessionExecutionRepairModel(params.entry);
  const model =
    params.model ??
    (!params.reset ? currentModel : undefined) ??
    (configured ? { provider: configured.provider, id: configured.model } : undefined);
  if (!model) {
    return { status: "unresolved" };
  }
  const runtime =
    priorExecutor?.id ?? (fact?.state === "deferred" ? fact.request.runtime : undefined);
  const executor = runtime
    ? (params.runtimeMigration?.(runtime) ?? priorExecutor)
    : params.executor;
  const before = { ...params.entry };
  commitStoredSessionExecutionSelection(params.entry, {
    state: "deferred",
    request: {
      ...(params.reset && !params.model ? { defaultSelection: "configured" } : { model }),
      ...(executor ? { executor } : runtime ? { runtime } : {}),
    },
    fallbackPermission: params.reset ? "configured" : (fact?.fallbackPermission ?? "configured"),
    ...(!params.reset && fact?.legacyRequest ? { legacyRequest: fact.legacyRequest } : {}),
    ...(fact?.state === "accepted"
      ? { previous: fact.selection }
      : fact?.previous
        ? { previous: fact.previous }
        : {}),
  });
  if (params.preserveAuthProfileOverride === false) {
    delete params.entry.authProfileOverride;
    delete params.entry.authProfileOverrideSource;
    delete params.entry.authProfileOverrideCompactionCount;
  }
  if (isDeepStrictEqual(before, params.entry)) {
    return { status: "unchanged" };
  }
  params.entry.updatedAt = Date.now();
  return { status: "repaired" };
}
