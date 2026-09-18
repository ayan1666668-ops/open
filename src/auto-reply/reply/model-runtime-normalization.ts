/** Prepared plugin metadata handoff for runtime model normalization. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import {
  findNormalizedProviderKey,
  modelKey,
  type normalizeModelRef,
  normalizeProviderId,
} from "../../agents/model-selection.js";
import { RUNTIME_MODEL_VISIBILITY_NORMALIZATION } from "../../agents/model-visibility-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestMetadataSnapshot,
} from "../../plugins/manifest-contract-eligibility.js";

export function normalizeRuntimeChoiceId(runtime: string | undefined): string {
  const normalized = normalizeLowercaseStringOrEmpty(runtime);
  if (!normalized || normalized === "auto" || normalized === "default") {
    return "openclaw";
  }
  return normalized;
}

export type RuntimeModelNormalization = NonNullable<Parameters<typeof normalizeModelRef>[2]>;

/** Carries the Gateway-owned metadata snapshot through one model-selection run. */
export function resolveRuntimeNormalization(cfg: OpenClawConfig): RuntimeModelNormalization {
  return {
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    manifestPlugins: getCurrentPluginMetadataSnapshot({
      config: cfg,
      allowWorkspaceScopedSnapshot: true,
    }),
  };
}

export function findSelectedCatalogEntry(params: {
  catalog?: readonly ModelCatalogEntry[];
  provider: string;
  model: string;
}): ModelCatalogEntry | undefined {
  const normalizedProvider = normalizeProviderId(params.provider);
  const selectedKey = modelKey(normalizedProvider, params.model);
  // Literal IDs can share a display key; prefer the selected row before alias matching.
  return (
    params.catalog?.find(
      (entry) =>
        normalizeProviderId(entry.provider) === normalizedProvider &&
        entry.id.trim() === params.model.trim(),
    ) ?? params.catalog?.find((entry) => modelKey(entry.provider, entry.id) === selectedKey)
  );
}

/** Provider identity comes from authored routes or prepared/plugin metadata, not model inventory. */
export function isKnownModelSelectionProvider(params: {
  cfg: OpenClawConfig;
  provider: string;
  catalog: readonly ModelCatalogEntry[];
}): boolean {
  const provider = normalizeProviderId(params.provider);
  if (
    findNormalizedProviderKey(params.cfg.models?.providers, provider) ||
    params.catalog.some((entry) => normalizeProviderId(entry.provider) === provider)
  ) {
    return true;
  }
  const snapshot = loadManifestMetadataSnapshot({ config: params.cfg });
  return snapshot.plugins.some(
    (plugin) =>
      plugin.providers.some((id) => normalizeProviderId(id) === provider) &&
      isManifestPluginAvailableForControlPlane({ snapshot, plugin, config: params.cfg }),
  );
}

// Match catalog metadata by literal identity, not a potentially collapsed display key.
function modelCatalogEntryKey(entry: Pick<ModelCatalogEntry, "provider" | "id">): string {
  return JSON.stringify([entry.provider.trim(), entry.id.trim()]);
}

/** Retain prepared-only models while overlaying matching configured model metadata. */
export function mergePreparedConfiguredCatalog(params: {
  configured: ModelCatalogEntry[];
  prepared?: readonly ModelCatalogEntry[];
}): ModelCatalogEntry[] {
  if (!params.prepared?.length) {
    return params.configured;
  }
  const mergedByKey = new Map(
    params.configured.map((entry) => [modelCatalogEntryKey(entry), entry]),
  );
  // Plugin-owned providers need not have authored models.providers rows. Keep
  // their prepared capabilities too; selection applies visibility after this merge.
  for (const entry of params.prepared) {
    const key = modelCatalogEntryKey(entry);
    mergedByKey.set(key, { ...mergedByKey.get(key), ...entry });
  }
  return [...mergedByKey.values()];
}
