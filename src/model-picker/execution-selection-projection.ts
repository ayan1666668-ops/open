import type { SessionAcpMeta } from "@openclaw/acp-core/types";
import type { AgentPatchedSessionModelFallback } from "../config/sessions/session-model-fallback.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  isAcpExecutionSelection,
  isModelExecutionSelection,
  type ExecutionSelection,
  type SessionExecutionSelection,
} from "./execution-selection.js";

export const LEGACY_SELECTION_VIEW_FIELDS = [
  "providerOverride",
  "modelOverride",
  "agentRuntimeOverride",
  "modelOverrideSource",
  "modelOverrideRouteResolution",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
] as const;

export type LegacySelectionView = {
  providerOverride?: string;
  modelOverride?: string;
  agentRuntimeOverride?: string;
  modelOverrideSource?: "auto" | "user" | "default";
  modelOverrideRouteResolution?: "resolved";
  modelOverrideFallbackOriginProvider?: string;
  modelOverrideFallbackOriginModel?: string;
};
export type PublicModelFallback = Omit<AgentPatchedSessionModelFallback, "previous"> & {
  prevModel: string;
  prevProvider: string;
  prevModelOverride?: string;
  prevProviderOverride?: string;
  prevModelOverrideSource?: "auto" | "user" | "default";
  prevModelOverrideRouteResolution?: "resolved";
  prevModelOverrideFallbackOriginProvider?: string;
  prevModelOverrideFallbackOriginModel?: string;
};
export type PublicSessionEntry = LegacySelectionView &
  Omit<SessionEntry, "executionSelection" | "acp" | "modelFallback"> & {
    acp?: SessionAcpMeta;
    modelFallback?: PublicModelFallback;
  };

/** Released response fields are views of the accepted pair, never stored selectors. */
export function executionSelectionModelOverrideProjection(
  selection: ExecutionSelection | undefined,
): {
  providerOverride?: string;
  modelOverride?: string;
} {
  return selection && isModelExecutionSelection(selection)
    ? { providerOverride: selection.model.provider, modelOverride: selection.model.id }
    : {};
}

export function executionSelectionWireSourceProjection(
  entry: Pick<SessionEntry, "executionSelection"> | undefined,
): {
  modelOverrideSource: "auto" | "user" | null;
} {
  return {
    modelOverrideSource: entry?.executionSelection
      ? entry.executionSelection.fallbackPermission === "explicit"
        ? "user"
        : "auto"
      : null,
  };
}

export function projectLegacyExecutionSelection(
  stored: SessionExecutionSelection | undefined,
): LegacySelectionView {
  if (!stored) return {};
  const model = stored.state === "accepted" ? stored.selection.model : stored.request.model;
  const executor =
    stored.state === "accepted" ? stored.selection.executor : stored.request.executor;
  const runtime =
    executor?.kind === "acp"
      ? undefined
      : (executor?.id ?? (stored.state === "deferred" ? stored.request.runtime : undefined));
  if (!model || model === "native-managed") return runtime ? { agentRuntimeOverride: runtime } : {};
  const provider =
    stored.state === "accepted"
      ? isModelExecutionSelection(stored.selection)
        ? stored.selection.model.provider
        : undefined
      : stored.request.model && stored.request.model !== "native-managed"
        ? stored.request.model.provider
        : undefined;
  const automatic = stored.fallbackPermission === "configured";
  return {
    providerOverride: provider,
    modelOverride: model.id,
    agentRuntimeOverride: runtime,
    modelOverrideSource: automatic ? "auto" : "user",
    modelOverrideRouteResolution: "resolved",
    ...(automatic
      ? {
          modelOverrideFallbackOriginProvider: provider,
          modelOverrideFallbackOriginModel: model.id,
        }
      : {}),
  };
}

export function projectExecutionSelectionEntry(
  entry: Partial<SessionEntry>,
): Partial<PublicSessionEntry> {
  const { executionSelection, acp, modelFallback, ...view } = entry;
  const legacyView: typeof view & LegacySelectionView = view;
  for (const field of LEGACY_SELECTION_VIEW_FIELDS) delete legacyView[field];
  Object.assign(view, projectLegacyExecutionSelection(executionSelection));
  const selection =
    executionSelection?.state === "accepted"
      ? executionSelection.selection
      : executionSelection?.previous;
  const fallback = modelFallback
    ? projectLegacyExecutionSelection(modelFallback.previous)
    : undefined;
  return {
    ...view,
    ...(acp && selection && isAcpExecutionSelection(selection)
      ? {
          acp: {
            ...acp,
            backend: selection.executor.backend,
            agent: selection.executor.agent,
            runtimeOptions: {
              ...acp.runtimeOptions,
              ...(selection.model === "native-managed" ? {} : { model: selection.model.id }),
            },
          },
        }
      : {}),
    ...(modelFallback && fallback?.modelOverride && fallback.providerOverride
      ? {
          modelFallback: {
            prevModel: fallback.modelOverride,
            prevProvider: fallback.providerOverride,
            prevModelOverride: fallback.modelOverride,
            prevProviderOverride: fallback.providerOverride,
            prevModelOverrideSource: fallback.modelOverrideSource,
            prevModelOverrideRouteResolution: fallback.modelOverrideRouteResolution,
            prevModelOverrideFallbackOriginProvider: fallback.modelOverrideFallbackOriginProvider,
            prevModelOverrideFallbackOriginModel: fallback.modelOverrideFallbackOriginModel,
            prevAuthProfileOverride: modelFallback.prevAuthProfileOverride,
            prevAuthProfileOverrideSource: modelFallback.prevAuthProfileOverrideSource,
            prevAuthProfileOverrideCompactionCount:
              modelFallback.prevAuthProfileOverrideCompactionCount,
            prevContextWindow: modelFallback.prevContextWindow,
            prevThinkingLevel: modelFallback.prevThinkingLevel,
            lastValidatedPatchTs: modelFallback.lastValidatedPatchTs,
            ts: modelFallback.ts,
            source: modelFallback.source,
          },
        }
      : {}),
  };
}
