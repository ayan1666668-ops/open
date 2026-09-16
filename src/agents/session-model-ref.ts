// Resolves persisted session model metadata without loading Gateway projections.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { decodeSessionExecutionSelection } from "../model-picker/execution-selection-codec.js";
import { executionSelectionCodecMetadata } from "../model-picker/execution-selection-state.js";
import { isAcpExecutionSelection } from "../model-picker/execution-selection.js";
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

/** Keep prepared host metadata outside the published session-model resolver contract. */
export function resolveSessionModelRef(
  cfg: OpenClawConfig,
  entry?: SessionModelEntry,
  agentId?: string,
  options?: { allowPluginNormalization?: boolean },
): { provider: string; model: string } {
  return resolveSessionModelRefCore(cfg, entry, agentId, {
    allowPluginNormalization: options?.allowPluginNormalization,
  });
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
  const decoded = decodeSessionExecutionSelection(
    entry,
    executionSelectionCodecMetadata(cfg, configured.provider),
  );
  if (decoded.kind === "initialized" && !isAcpExecutionSelection(decoded.selection)) {
    return { provider: decoded.selection.model.provider, model: decoded.selection.model.id };
  }
  if (decoded.kind === "uninitialized" && decoded.model) {
    return { provider: decoded.model.provider ?? configured.provider, model: decoded.model.id };
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
