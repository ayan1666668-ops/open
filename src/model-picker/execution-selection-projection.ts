import { isDeepStrictEqual } from "node:util";
import type { SessionAcpMeta } from "@openclaw/acp-core/types";
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
} from "../agents/agent-runtime-id.js";
import type { AgentPatchedSessionModelFallback } from "../config/sessions/session-model-fallback.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions/types.js";
import { ModelSelectionLockedError } from "../sessions/model-overrides.js";
import {
  isAcpExecutionSelection,
  isModelExecutionSelection,
  type ExecutionSelection,
  type SessionExecutionSelection,
  type DeferredExecutionSelectionRequest,
} from "./execution-selection.js";
import {
  resolveLegacyExecutionIntent,
  sessionExecutionSelectionSchema,
} from "./execution-selection.schema.js";

export const LEGACY_SELECTION_VIEW_FIELDS = [
  "providerOverride",
  "modelOverride",
  "agentRuntimeOverride",
  "modelOverrideSource",
  "modelOverrideRouteResolution",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
] as const;

const LEGACY_FALLBACK_SELECTION_FIELDS = [
  "prevModelOverride",
  "prevProviderOverride",
  "prevModelOverrideSource",
  "prevModelOverrideRouteResolution",
  "prevModelOverrideFallbackOriginProvider",
  "prevModelOverrideFallbackOriginModel",
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
type PublicModelFallback = Omit<AgentPatchedSessionModelFallback, "previous"> & {
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

export function projectLegacyExecutionSelection(
  stored: SessionExecutionSelection | undefined,
): LegacySelectionView {
  if (!stored) {
    return {};
  }
  const model = stored.state === "accepted" ? stored.selection.model : stored.request.model;
  const executor =
    stored.state === "accepted" ? stored.selection.executor : stored.request.executor;
  const runtime =
    executor?.kind === "acp"
      ? undefined
      : (executor?.id ?? (stored.state === "deferred" ? stored.request.runtime : undefined));
  if (stored.legacyRequest) {
    return {
      providerOverride: stored.legacyRequest.provider,
      ...(stored.legacyRequest.source ? { modelOverrideSource: stored.legacyRequest.source } : {}),
      ...(runtime ? { agentRuntimeOverride: runtime } : {}),
    };
  }
  if (stored.state === "accepted" && stored.fallbackPermission === "configured") {
    return runtime ? { agentRuntimeOverride: runtime } : {};
  }
  if (!model || model === "native-managed") {
    return {
      ...(runtime ? { agentRuntimeOverride: runtime } : {}),
      ...(!model &&
      stored.fallbackPermission === "configured" &&
      !(stored.state === "deferred" && stored.request.defaultSelection === "inherit")
        ? { modelOverrideSource: "default" as const }
        : {}),
    };
  }
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
  for (const field of LEGACY_SELECTION_VIEW_FIELDS) {
    Reflect.deleteProperty(view, field);
  }
  Object.assign(view, projectLegacyExecutionSelection(executionSelection));
  const selection =
    executionSelection?.state === "accepted"
      ? executionSelection.selection
      : executionSelection?.previous;
  let fallback: PublicModelFallback | undefined;
  if (modelFallback) {
    const { previous, ...metadata } = modelFallback;
    const legacy = projectLegacyExecutionSelection(previous);
    fallback = {
      ...metadata,
      prevModelOverride: legacy.modelOverride,
      prevProviderOverride: legacy.providerOverride,
      prevModelOverrideSource: legacy.modelOverrideSource,
      prevModelOverrideRouteResolution: legacy.modelOverrideRouteResolution,
      prevModelOverrideFallbackOriginProvider: legacy.modelOverrideFallbackOriginProvider,
      prevModelOverrideFallbackOriginModel: legacy.modelOverrideFallbackOriginModel,
    };
  }
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
    ...(fallback ? { modelFallback: fallback } : {}),
  };
}
/** Released store inputs stage requests at the owner without making a readiness claim. */
export function reconcileSessionExecutionSelectionView(
  current: Partial<InternalSessionEntry> | undefined,
  patch: Partial<PublicSessionEntry> & Pick<SessionEntry, "executionSelection">,
  options: { replace?: boolean } = {},
): Pick<SessionEntry, "executionSelection" | "modelFallback"> {
  const before = current?.executionSelection;
  const projected = projectExecutionSelectionEntry(current ?? {});
  const replace =
    options.replace ||
    (patch.sessionId !== undefined && patch.sessionId !== current?.sessionId) ||
    (patch.lifecycleRevision !== undefined &&
      patch.lifecycleRevision !== current?.lifecycleRevision);
  const next = replace ? patch : { ...projected, ...patch };
  const modelCleared = Object.hasOwn(patch, "modelOverride") && !patch.modelOverride;
  const previous = before?.state === "accepted" ? before.selection : before?.previous;
  const changed = LEGACY_SELECTION_VIEW_FIELDS.some(
    (field) =>
      (replace || Object.hasOwn(patch, field)) &&
      !isDeepStrictEqual(patch[field], projected[field]),
  );
  const acpChanged =
    patch.acp &&
    (patch.acp.backend !== projected.acp?.backend ||
      patch.acp.agent !== projected.acp?.agent ||
      patch.acp.runtimeOptions?.model !== projected.acp?.runtimeOptions?.model);
  const entry: Pick<SessionEntry, "executionSelection" | "modelFallback"> = {};
  if (patch.executionSelection && !isDeepStrictEqual(before, patch.executionSelection)) {
    const proposed = patch.executionSelection;
    entry.executionSelection = sessionExecutionSelectionSchema.parse({
      state: "deferred",
      request:
        proposed.state === "deferred"
          ? proposed.request
          : { model: proposed.selection.model, executor: proposed.selection.executor },
      fallbackPermission: proposed.fallbackPermission,
      ...(proposed.legacyRequest ? { legacyRequest: proposed.legacyRequest } : {}),
      ...(previous ? { previous } : {}),
    });
  } else if (changed || modelCleared || acpChanged) {
    const normalizedRuntime = normalizeOptionalAgentRuntimeId(next.agentRuntimeOverride);
    const runtime = isDefaultAgentRuntimeId(normalizedRuntime) ? undefined : normalizedRuntime;
    const { model, fallbackPermission } = resolveLegacyExecutionIntent({
      model: next.modelOverride,
      provider: next.providerOverride,
      source: next.modelOverrideSource,
      originProvider: next.modelOverrideFallbackOriginProvider,
      originModel: next.modelOverrideFallbackOriginModel,
    });
    const request: DeferredExecutionSelectionRequest =
      acpChanged && patch.acp
        ? {
            executor: { kind: "acp", backend: patch.acp.backend, agent: patch.acp.agent },
            model: patch.acp.runtimeOptions?.model
              ? { id: patch.acp.runtimeOptions.model }
              : "native-managed",
          }
        : {
            ...(!modelCleared && model
              ? { model }
              : {
                  defaultSelection:
                    modelCleared || next.modelOverrideSource === "default"
                      ? ("configured" as const)
                      : ("inherit" as const),
                }),
            ...(runtime ? { runtime } : {}),
            ...(!replace && !Object.hasOwn(patch, "agentRuntimeOverride") && previous
              ? { executor: previous.executor }
              : {}),
          };
    const legacyRequest =
      !acpChanged && !next.modelOverride && next.providerOverride
        ? {
            provider: next.providerOverride,
            ...(next.modelOverrideSource ? { source: next.modelOverrideSource } : {}),
          }
        : undefined;
    if (
      legacyRequest &&
      before?.state === "accepted" &&
      !replace &&
      !modelCleared &&
      !Object.hasOwn(patch, "agentRuntimeOverride")
    ) {
      entry.executionSelection = sessionExecutionSelectionSchema.parse({
        ...before,
        fallbackPermission,
        legacyRequest,
      });
    } else {
      entry.executionSelection = sessionExecutionSelectionSchema.parse({
        state: "deferred",
        request,
        ...(legacyRequest ? { legacyRequest } : {}),
        fallbackPermission,
        ...(previous ? { previous } : {}),
      });
    }
  } else if (before) {
    entry.executionSelection = sessionExecutionSelectionSchema.parse(before);
  }
  if (current?.modelSelectionLocked && !isDeepStrictEqual(before, entry.executionSelection)) {
    throw new ModelSelectionLockedError();
  }
  if (Object.hasOwn(patch, "modelFallback") || (replace && projected.modelFallback)) {
    const fallback = patch.modelFallback;
    if (!fallback) {
      entry.modelFallback = undefined;
    } else if (isDeepStrictEqual(fallback, projected.modelFallback)) {
      entry.modelFallback = current?.modelFallback;
    } else {
      let rollbackSelection = current?.modelFallback?.previous;
      if (
        !rollbackSelection ||
        LEGACY_FALLBACK_SELECTION_FIELDS.some(
          (field) => !isDeepStrictEqual(fallback[field], projected.modelFallback?.[field]),
        )
      ) {
        const previousIntent = resolveLegacyExecutionIntent({
          model: fallback.prevModelOverride,
          provider: fallback.prevProviderOverride,
          source: fallback.prevModelOverrideSource,
          originProvider: fallback.prevModelOverrideFallbackOriginProvider,
          originModel: fallback.prevModelOverrideFallbackOriginModel,
        });
        rollbackSelection = {
          state: "deferred",
          request: previousIntent.model
            ? { model: previousIntent.model }
            : {
                defaultSelection:
                  fallback.prevModelOverrideSource === "default" ? "configured" : "inherit",
              },
          fallbackPermission: previousIntent.fallbackPermission,
          ...(!fallback.prevModelOverride && fallback.prevProviderOverride
            ? {
                legacyRequest: {
                  provider: fallback.prevProviderOverride,
                  ...(fallback.prevModelOverrideSource
                    ? { source: fallback.prevModelOverrideSource }
                    : {}),
                },
              }
            : {}),
        };
      }
      entry.modelFallback = {
        previous: rollbackSelection,
        prevModel: fallback.prevModel,
        prevProvider: fallback.prevProvider,
        prevAuthProfileOverride: fallback.prevAuthProfileOverride,
        prevAuthProfileOverrideSource: fallback.prevAuthProfileOverrideSource,
        prevAuthProfileOverrideCompactionCount: fallback.prevAuthProfileOverrideCompactionCount,
        prevContextWindow: fallback.prevContextWindow,
        prevThinkingLevel: fallback.prevThinkingLevel,
        lastValidatedPatchTs: fallback.lastValidatedPatchTs,
        ts: fallback.ts,
        source: fallback.source,
      };
    }
  } else if (!isDeepStrictEqual(before, entry.executionSelection)) {
    entry.modelFallback = undefined;
  } else if (
    current?.modelFallback &&
    (!patch.sessionId || patch.sessionId === current.sessionId) &&
    (!patch.lifecycleRevision || patch.lifecycleRevision === current.lifecycleRevision)
  ) {
    entry.modelFallback = current.modelFallback;
  }
  return entry;
}
