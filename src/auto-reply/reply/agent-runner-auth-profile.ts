// Resolves auth profile settings that agent runner forwards to providers.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  resolveProviderIdForAuth,
  type ProviderAuthAliasLookupParams,
} from "../../agents/provider-auth-aliases.js";
import { isModelExecutionSelection } from "../../model-picker/execution-selection.js";
import type { FollowupRun } from "./queue.js";

/** Resolves the auth profile override for a queued follow-up run. */
export function resolveRunAuthProfile(
  run: FollowupRun["run"],
  provider: string,
  params?: { config?: ProviderAuthAliasLookupParams["config"] },
) {
  const selection = run.executionSelection;
  if (!isModelExecutionSelection(selection)) {
    return {};
  }
  const aliasParams = {
    config: params?.config ?? run.config,
    workspaceDir: run.workspaceDir,
  };
  const providerId = normalizeProviderId(provider);
  const primaryProviderId = normalizeProviderId(selection.model.provider);
  const sharesAuthScope =
    (providerId !== "" && providerId === primaryProviderId) ||
    resolveProviderIdForAuth(provider, aliasParams) ===
      resolveProviderIdForAuth(selection.model.provider, aliasParams);
  const authProfileId = sharesAuthScope ? run.authProfileId : undefined;
  return {
    authProfileId,
    authProfileIdSource: authProfileId ? run.authProfileIdSource : undefined,
  };
}
