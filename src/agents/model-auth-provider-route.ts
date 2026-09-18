import { normalizeProviderIdForAuth } from "@openclaw/model-catalog-core/provider-id";
import {
  findConfiguredProviderModel,
  projectModelProviderConfig,
  resolveMergedModelProviderConfig,
} from "../config/model-provider-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createProviderModelCatalogIdNormalizer } from "../plugins/provider-model-routes.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
  resolveProviderIdForAuth,
  type ProviderAuthAliasLookupParams,
} from "./provider-auth-aliases.js";

type ModelProviderAuthConfigParams = ProviderAuthAliasLookupParams & {
  provider: string;
  modelId?: string;
  modelBaseUrl?: unknown;
};

export function resolveModelProviderAuthConfig(
  params: ModelProviderAuthConfigParams & { config: OpenClawConfig },
): OpenClawConfig;
export function resolveModelProviderAuthConfig(
  params: ModelProviderAuthConfigParams,
): OpenClawConfig | undefined;
/** Endpoint-conditioned aliases follow the selected model before any auth state mutation. */
export function resolveModelProviderAuthConfig(
  params: ModelProviderAuthConfigParams,
): OpenClawConfig | undefined {
  const modelBaseUrl =
    params.modelBaseUrl ??
    (params.modelId
      ? findConfiguredProviderModel(
          resolveMergedModelProviderConfig(params.config, params.provider),
          params.provider,
          params.modelId,
          createProviderModelCatalogIdNormalizer(params.provider, params.metadataSnapshot),
        )?.baseUrl?.trim()
      : undefined);
  if (typeof modelBaseUrl !== "string" || !modelBaseUrl) {
    return params.config;
  }
  const config = projectModelProviderConfig(params.config, params.provider, {
    baseUrl: modelBaseUrl,
  });
  return resolveProviderIdForAuth(params.provider, params) ===
    resolveProviderIdForAuth(params.provider, { ...params, config })
    ? params.config
    : config;
}

export function normalizeModelIdForProvider(provider: string, modelId: string): string | undefined {
  const trimmed = splitTrailingAuthProfile(modelId).model.trim();
  if (!trimmed) {
    return undefined;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return trimmed;
  }
  return normalizeProviderIdForAuth(trimmed.slice(0, slash)) === provider
    ? trimmed.slice(slash + 1).trim() || undefined
    : undefined;
}
