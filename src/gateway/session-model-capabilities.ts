import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { findModelCatalogEntry, type ModelCatalogEntry } from "../agents/model-catalog.js";
import { findNormalizedProviderValue } from "../agents/model-selection.js";
import { publishedModelCatalogOwnerMatchesAgent } from "../agents/prepared-model-catalog-owner.js";
import type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";

function normalizeGatewayModelCapabilityBaseUrl(value: string | undefined): string | undefined {
  const baseUrl = normalizeOptionalString(value);
  if (!baseUrl) {
    return undefined;
  }
  try {
    const parsed = new URL(baseUrl);
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    return parsed.toString();
  } catch {
    return baseUrl.replace(/\/+$/u, "");
  }
}

export function isGatewayModelExplicitlyConfiguredTextOnly(params: {
  snapshot: GatewayModelCatalogSnapshot;
  provider?: string;
  model: string;
}): boolean {
  if (!params.provider) {
    return false;
  }
  const configuredModel = findNormalizedProviderValue(
    params.snapshot.config.models?.providers,
    params.provider,
  )?.models?.find(
    (model) =>
      normalizeLowercaseStringOrEmpty(model.id) === normalizeLowercaseStringOrEmpty(params.model),
  );
  return configuredModel?.input !== undefined && !configuredModel.input.includes("image");
}

export function resolveGatewayProviderStaticModel(params: {
  snapshot: GatewayModelCatalogSnapshot;
  agentId?: string;
  provider?: string;
  model: string;
  catalogEntry?: ModelCatalogEntry;
}): ModelCatalogEntry | undefined {
  if (
    !params.agentId ||
    !params.provider ||
    !publishedModelCatalogOwnerMatchesAgent(params.snapshot, params.agentId)
  ) {
    return undefined;
  }
  const staticEntry = findModelCatalogEntry(params.snapshot.staticEntries ?? [], {
    provider: params.provider,
    modelId: params.model,
  });
  if (!staticEntry) {
    return undefined;
  }
  if (params.catalogEntry?.api && params.catalogEntry.api !== staticEntry.api) {
    return undefined;
  }
  const catalogBaseUrl = normalizeGatewayModelCapabilityBaseUrl(params.catalogEntry?.baseUrl);
  const staticBaseUrl = normalizeGatewayModelCapabilityBaseUrl(staticEntry.baseUrl);
  if (catalogBaseUrl && catalogBaseUrl !== staticBaseUrl) {
    return undefined;
  }

  if (isGatewayModelExplicitlyConfiguredTextOnly(params)) {
    return undefined;
  }
  const configuredProvider = findNormalizedProviderValue(
    params.snapshot.config.models?.providers,
    params.provider,
  );
  const normalizedModelId = normalizeLowercaseStringOrEmpty(params.model);
  const configuredModel = configuredProvider?.models?.find(
    (model) => normalizeLowercaseStringOrEmpty(model.id) === normalizedModelId,
  );
  const configuredApi = configuredModel?.api ?? configuredProvider?.api;
  if (configuredApi && configuredApi !== staticEntry.api) {
    return undefined;
  }
  const configuredBaseUrl = normalizeGatewayModelCapabilityBaseUrl(
    configuredModel?.baseUrl ?? configuredProvider?.baseUrl,
  );
  if (configuredBaseUrl && configuredBaseUrl !== staticBaseUrl) {
    return undefined;
  }
  return staticEntry;
}
