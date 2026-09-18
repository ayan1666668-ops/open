// Resolves persisted session model metadata without loading Gateway projections.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PublicSessionEntry } from "../model-picker/execution-selection-projection.js";
import {
  getSessionExecutionSelection,
  isModelExecutionSelection,
} from "../model-picker/execution-selection.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  inferUniqueProviderFromConfiguredModels,
  normalizeStoredOverrideModel,
  type ModelManifestNormalizationContext,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "./model-selection.js";

type SessionModelEntry = Partial<SessionEntry>;

/** Released SDK-only reader for public model views; execution uses the canonical core reader. */
export function resolveSessionModelRef(
  cfg: OpenClawConfig,
  entry?:
    | (PublicSessionEntry & Pick<SessionEntry, "executionSelection">)
    | Pick<
        PublicSessionEntry & Pick<SessionEntry, "executionSelection">,
        | "executionSelection"
        | "model"
        | "modelProvider"
        | "modelOverride"
        | "providerOverride"
        | "modelOverrideRouteResolution"
        | "modelOverrideFallbackOriginProvider"
        | "modelOverrideFallbackOriginModel"
      >,
  agentId?: string,
  options?: { allowPluginNormalization?: boolean },
): { provider: string; model: string } {
  if (entry?.executionSelection) {
    return resolveSessionModelRefCore(
      cfg,
      { executionSelection: entry.executionSelection },
      agentId,
      options,
    );
  }
  const hasOrigin = Boolean(
    (entry?.providerOverride?.trim() || entry?.modelOverride?.trim()) &&
    entry?.modelOverrideFallbackOriginProvider?.trim() &&
    entry?.modelOverrideFallbackOriginModel?.trim(),
  );
  const overrideRouteResolution =
    entry?.modelOverrideRouteResolution ?? (hasOrigin ? "resolved" : "raw");
  const normalizedOverride = normalizeStoredOverrideModel({
    providerOverride: entry?.providerOverride,
    modelOverride: entry?.modelOverride,
    routeResolution: overrideRouteResolution,
  });
  if (normalizedOverride.providerOverride && normalizedOverride.modelOverride) {
    return resolvePersistedSelectedModelRef({
      defaultProvider: normalizedOverride.providerOverride,
      overrideProvider: normalizedOverride.providerOverride,
      overrideModel: normalizedOverride.modelOverride,
      overrideRouteResolution,
      allowPluginNormalization: options?.allowPluginNormalization,
    })!;
  }
  const resolved = agentId
    ? resolveDefaultModelForAgent({
        cfg,
        agentId,
        allowPluginNormalization: options?.allowPluginNormalization,
      })
    : resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
        allowPluginNormalization: options?.allowPluginNormalization,
      });
  return (
    resolvePersistedSelectedModelRef({
      defaultProvider: resolved.provider || DEFAULT_PROVIDER,
      runtimeProvider: agentId ? undefined : normalizeOptionalString(entry?.modelProvider),
      runtimeModel: agentId ? undefined : normalizeOptionalString(entry?.model),
      overrideProvider: normalizedOverride.providerOverride,
      overrideModel: normalizedOverride.modelOverride,
      overrideRouteResolution,
      allowPluginNormalization: options?.allowPluginNormalization,
    }) ?? resolved
  );
}

export function resolveSessionModelRefCore(
  cfg: OpenClawConfig,
  entry?: SessionModelEntry,
  agentId?: string,
  options?: ModelManifestNormalizationContext & { allowPluginNormalization?: boolean },
): { provider: string; model: string } {
  const configured = resolveDefaultModelForAgent({
    cfg,
    agentId,
    allowPluginNormalization: options?.allowPluginNormalization,
    manifestPlugins: options?.manifestPlugins,
  });
  const selected = getSessionExecutionSelection(entry);
  if (selected && isModelExecutionSelection(selected)) {
    return { provider: selected.model.provider, model: selected.model.id };
  }
  const requested =
    entry?.executionSelection?.state === "deferred"
      ? entry.executionSelection.request.model
      : undefined;
  if (requested && requested !== "native-managed") {
    return { provider: requested.provider ?? configured.provider, model: requested.id };
  }
  return configured;
}

export function resolveSessionModelIdentityRef(
  cfg: OpenClawConfig,
  entry?: SessionModelEntry,
  agentId?: string,
  fallbackModelRef?: string,
  options?: ModelManifestNormalizationContext & { allowPluginNormalization?: boolean },
): { provider?: string; model: string } {
  const runtimeModel = entry?.model?.trim();
  const runtimeProvider = entry?.modelProvider?.trim();
  if (runtimeModel) {
    if (runtimeProvider) {
      return { provider: runtimeProvider, model: runtimeModel };
    }
    const inferredProvider = inferUniqueProviderFromConfiguredModels({
      cfg,
      model: runtimeModel,
      agentId,
      manifestPlugins: options?.manifestPlugins,
    });
    if (inferredProvider) {
      return { provider: inferredProvider, model: runtimeModel };
    }
    if (runtimeModel.includes("/")) {
      const parsedRuntime = parseModelRef(runtimeModel, DEFAULT_PROVIDER, {
        allowPluginNormalization: options?.allowPluginNormalization,
        manifestPlugins: options?.manifestPlugins,
      });
      if (parsedRuntime) {
        return { provider: parsedRuntime.provider, model: parsedRuntime.model };
      }
      return { model: runtimeModel };
    }
    return { model: runtimeModel };
  }
  const fallbackRef = fallbackModelRef?.trim();
  if (fallbackRef) {
    const parsedFallback = parseModelRef(fallbackRef, DEFAULT_PROVIDER, {
      allowPluginNormalization: options?.allowPluginNormalization,
      manifestPlugins: options?.manifestPlugins,
    });
    if (parsedFallback) {
      return { provider: parsedFallback.provider, model: parsedFallback.model };
    }
    const inferredProvider = inferUniqueProviderFromConfiguredModels({
      cfg,
      model: fallbackRef,
      agentId,
      manifestPlugins: options?.manifestPlugins,
    });
    if (inferredProvider) {
      return { provider: inferredProvider, model: fallbackRef };
    }
    return { model: fallbackRef };
  }
  const resolved = resolveSessionModelRefCore(cfg, entry, agentId, {
    allowPluginNormalization: options?.allowPluginNormalization,
    manifestPlugins: options?.manifestPlugins,
  });
  return { provider: resolved.provider, model: resolved.model };
}
