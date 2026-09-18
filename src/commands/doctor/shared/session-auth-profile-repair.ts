import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir } from "../../../agents/agent-scope.js";
import {
  areOAuthCredentialsEquivalent,
  hasMatchingOAuthIdentity,
} from "../../../agents/auth-profiles/oauth-shared.js";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
  parseLegacyCredentialEntry,
} from "../../../agents/auth-profiles/persisted.js";
import { isLegacyCodexProviderId } from "../../../config/legacy-codex-provider.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { loadJsonFileThroughSymlink } from "../../../infra/json-file.js";
import { resolveLegacyAuthProfilesPath } from "../../doctor-auth-legacy-paths.js";
import { resolveLegacyRuntimeModelProviderAlias } from "./legacy-runtime-model-providers.js";

export function repairSessionAuthProfileReferences(
  entry: SessionEntry,
  profileIdMap: ReadonlyMap<string, string> | undefined,
): boolean {
  let changed = false;
  const replacement =
    typeof entry.authProfileOverride === "string"
      ? profileIdMap?.get(entry.authProfileOverride.trim())
      : undefined;
  if (replacement !== undefined && replacement !== entry.authProfileOverride) {
    entry.authProfileOverride = replacement;
    changed = true;
  }
  const fallback = entry.modelFallback;
  const previousReplacement =
    typeof fallback?.prevAuthProfileOverride === "string"
      ? profileIdMap?.get(fallback.prevAuthProfileOverride.trim())
      : undefined;
  if (
    fallback &&
    previousReplacement !== undefined &&
    previousReplacement !== fallback.prevAuthProfileOverride
  ) {
    fallback.prevAuthProfileOverride = previousReplacement;
    changed = true;
  }
  return changed;
}
export function resolveVerifiedSessionAuthProfileIdMap(params: {
  agentId: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  authProfileIdMap: ReadonlyMap<string, string> | undefined;
}): ReadonlyMap<string, string> | undefined {
  if (!params.authProfileIdMap || params.authProfileIdMap.size === 0) {
    return params.authProfileIdMap;
  }
  const agentDir = resolveAgentDir(params.cfg, params.agentId, params.env);
  const localProfiles = loadPersistedAuthProfileStore(agentDir)?.profiles ?? {};
  const mainProfiles = loadPersistedSharedAuthProfileStore(params.env)?.profiles ?? {};
  const localLegacyAuthPath = resolveLegacyAuthProfilesPath(agentDir);
  const localLegacySourceExists = fs.existsSync(localLegacyAuthPath);
  const localLegacySource = localLegacySourceExists
    ? loadJsonFileThroughSymlink(localLegacyAuthPath)
    : null;
  const localLegacyProfiles =
    isRecord(localLegacySource) && isRecord(localLegacySource.profiles)
      ? localLegacySource.profiles
      : undefined;

  return new Map(
    [...params.authProfileIdMap].filter(([legacyProfileId, canonicalProfileId]) => {
      const separator = legacyProfileId.indexOf(":");
      if (separator < 0) {
        return false;
      }
      const legacyProvider = legacyProfileId.slice(0, separator);
      const provider =
        isLegacyCodexProviderId(legacyProvider) || legacyProfileId === "openai:codex-cli"
          ? "openai"
          : resolveLegacyRuntimeModelProviderAlias(legacyProvider)?.provider;
      if (!provider) {
        return false;
      }
      const localCredential = localProfiles[canonicalProfileId];
      if (localCredential) {
        return normalizeString(localCredential.provider) === provider;
      }
      // A failed local import still owns its account. Never replace it with a
      // same-named main credential; inheritance is safe only without that source.
      const inheritedCredential = mainProfiles[canonicalProfileId];
      if (localLegacySourceExists) {
        if (!localLegacyProfiles) {
          return false;
        }
        const legacyCredential = localLegacyProfiles[legacyProfileId];
        if (legacyCredential !== undefined) {
          if (!isRecord(legacyCredential)) {
            return false;
          }
          const canonicalLegacyCredential = parseLegacyCredentialEntry(
            { ...legacyCredential, provider },
            provider,
          );
          // A retained mixed-sidecar source still contains successful entries.
          // Permit deduped main inheritance only when exact account identity matches.
          return (
            canonicalLegacyCredential?.type === "oauth" &&
            inheritedCredential?.type === "oauth" &&
            inheritedCredential.provider === provider &&
            (hasMatchingOAuthIdentity(canonicalLegacyCredential, inheritedCredential) ||
              areOAuthCredentialsEquivalent(canonicalLegacyCredential, inheritedCredential))
          );
        }
      }
      return normalizeString(inheritedCredential?.provider) === provider;
    }),
  );
}
