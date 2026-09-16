// Resolves auth profile settings that agent runner forwards to providers.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  resolveProviderIdForAuth,
  type ProviderAuthAliasLookupParams,
} from "../../agents/provider-auth-aliases.js";
import type { FollowupRun } from "./queue.js";

/** Keeps an auth profile only when the current provider shares the primary auth scope. */
export function resolveProviderScopedAuthProfile(params: {
  provider: string;
  primaryProvider: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  config?: ProviderAuthAliasLookupParams["config"];
  workspaceDir?: ProviderAuthAliasLookupParams["workspaceDir"];
}): { authProfileId?: string; authProfileIdSource?: "auto" | "user" } {
  const aliasParams = { config: params.config, workspaceDir: params.workspaceDir };
  const providerId = normalizeProviderId(params.provider);
  const primaryProviderId = normalizeProviderId(params.primaryProvider);
  const sharesAuthScope =
    (providerId !== "" && providerId === primaryProviderId) ||
    resolveProviderIdForAuth(params.provider, aliasParams) ===
      resolveProviderIdForAuth(params.primaryProvider, aliasParams);
  const authProfileId = sharesAuthScope ? params.authProfileId : undefined;
  return {
    authProfileId,
    authProfileIdSource: authProfileId ? params.authProfileIdSource : undefined,
  };
}

/** Resolves the auth profile override for a queued follow-up run. */
export function resolveRunAuthProfile(
  run: FollowupRun["run"],
  provider: string,
  params?: { config?: ProviderAuthAliasLookupParams["config"] },
) {
  return resolveProviderScopedAuthProfile({
    provider,
    primaryProvider: run.executionSelection.model.provider,
    authProfileId: run.authProfileId,
    authProfileIdSource: run.authProfileIdSource,
    config: params?.config ?? run.config,
    workspaceDir: run.workspaceDir,
  });
}
