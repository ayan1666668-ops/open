import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { EnvironmentSummary } from "../../../packages/gateway-protocol/src/index.js";
import {
  resolveAmbientOwnerAgentId,
  resolveEffectiveAgentDir,
} from "../../agents/agent-scope-config.js";
import { getPreparedRuntimeAuthProfileStoreSnapshot } from "../../agents/auth-profiles/store.js";
import { resolveLegacyInheritedAuthAgentId } from "../../agents/legacy-inherited-auth-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasConfiguredSecretInput } from "../../config/types.secrets.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  resolveSessionPlacementDisabledReason,
  type SessionPlacementPreflight,
} from "./device-placement-eligibility.js";
import { resolveWorkerPlacementCapabilities } from "./placement-capabilities.js";
import { isPortableRootContainedSymlink } from "./workspace-actual-manifest.js";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";

/** Bound preflight walks so environments.list stays picker-responsive. */
const MAX_SYMLINK_PREFLIGHT_ENTRIES = 4_096;
const GIT_CHECK_IGNORE_TIMEOUT_MS = 1_500;

function isOpenAiAuthProvider(provider: string | undefined): boolean {
  const normalized = provider?.trim().toLowerCase() ?? "";
  return (
    normalized === "openai" ||
    normalized === "openai-codex" ||
    normalized.startsWith("openai/") ||
    normalized.startsWith("openai-")
  );
}

function configHasPreparedOpenAiAuth(config: OpenClawConfig, authProfileId?: string): boolean {
  const profiles = config.auth?.profiles;
  if (!profiles || typeof profiles !== "object") {
    return false;
  }
  if (authProfileId) {
    return isOpenAiAuthProvider(profiles[authProfileId]?.provider);
  }
  return Object.values(profiles).some((profile) => isOpenAiAuthProvider(profile?.provider));
}

/**
 * Prepared API-key routes (`models.providers.*.apiKey`) are accepted by the
 * Codex auth-bridge without an auth profile. Empty profile snapshots must not
 * hard-disable those destinations.
 */
function configHasPreparedOpenAiApiKeyRoute(config: OpenClawConfig): boolean {
  const providers = config.models?.providers;
  if (!providers || typeof providers !== "object") {
    return false;
  }
  for (const [providerId, entry] of Object.entries(providers)) {
    if (!isOpenAiAuthProvider(providerId)) {
      continue;
    }
    if (hasConfiguredSecretInput(entry?.apiKey, config.secrets?.defaults)) {
      return true;
    }
  }
  return false;
}

function storeHasPreparedOpenAiAuth(
  agentDir: string | undefined,
  inheritedAuthDir: string | undefined,
  authProfileId?: string,
): boolean | undefined {
  const store = getPreparedRuntimeAuthProfileStoreSnapshot(agentDir, inheritedAuthDir);
  if (!store) {
    return undefined;
  }
  if (authProfileId) {
    const profile = store.profiles[authProfileId];
    return profile ? isOpenAiAuthProvider(profile.provider) : false;
  }
  return Object.values(store.profiles).some((profile) => isOpenAiAuthProvider(profile.provider));
}

/** Reads Codex appServer.homeScope without importing the Codex extension. */
export function resolveCodexAppServerHomeScopeFromConfig(
  config: OpenClawConfig,
): "agent" | "user" | undefined {
  const entries = config.plugins?.entries;
  if (!isRecord(entries) || !isRecord(entries.codex)) {
    return undefined;
  }
  const pluginConfig = isRecord(entries.codex.config) ? entries.codex.config : undefined;
  const appServer = isRecord(pluginConfig?.appServer) ? pluginConfig.appServer : undefined;
  return appServer?.homeScope === "user" || appServer?.homeScope === "agent"
    ? appServer.homeScope
    : undefined;
}

/**
 * Remote-exec placement requires prepared OpenAI auth in an agent-scoped home.
 * Native Codex homeScope="user" and ambient credentials are never accepted.
 * Eligibility follows the selected session agent / auth profile when provided.
 */
export function resolveMissingPreparedAuthForPlacement(params: {
  config: OpenClawConfig;
  runtimeId?: string;
  agentId?: string;
  authProfileId?: string;
}): boolean {
  const runtimeId = params.runtimeId?.trim();
  if (!runtimeId) {
    return false;
  }
  const { executionMode } = resolveWorkerPlacementCapabilities(runtimeId);
  if (executionMode !== "remote-exec") {
    return false;
  }
  if (resolveCodexAppServerHomeScopeFromConfig(params.config) === "user") {
    return true;
  }
  const authProfileId = params.authProfileId?.trim() || undefined;
  const agentId = normalizeAgentId(
    params.agentId?.trim() || resolveAmbientOwnerAgentId(params.config),
  );
  const agentDir = resolveEffectiveAgentDir(params.config, agentId);
  const inheritedAuthDir = resolveEffectiveAgentDir(
    params.config,
    resolveLegacyInheritedAuthAgentId(params.config),
  );
  const storeReady = storeHasPreparedOpenAiAuth(agentDir, inheritedAuthDir, authProfileId);
  if (storeReady === true) {
    return false;
  }
  // A requested profile must resolve from the profile store / config profiles.
  // Do not substitute models.providers when Move Session / New Session pinned one.
  if (authProfileId) {
    if (storeReady === false) {
      return true;
    }
    return !configHasPreparedOpenAiAuth(params.config, authProfileId);
  }
  // Empty / absent profile snapshot: auth-bridge still accepts prepared
  // api-key routes with resolvedApiKey and no auth profile.
  if (configHasPreparedOpenAiApiKeyRoute(params.config)) {
    return false;
  }
  if (storeReady === false) {
    return true;
  }
  return !configHasPreparedOpenAiAuth(params.config);
}

/**
 * True when transfer inventory would consider this relative path (symlink check
 * applies only after derived / Git-ignored exclusions).
 */
export async function isTransferEligibleSymlinkPath(
  root: string,
  relative: string,
): Promise<boolean> {
  if (!relative || relative.startsWith("..") || isDerivedWorkspacePath(relative)) {
    return false;
  }
  let gitDir: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    gitDir = await fs.lstat(path.join(root, ".git"));
  } catch {
    return true;
  }
  if (!gitDir.isDirectory() && !gitDir.isFile()) {
    return true;
  }
  // Match transfer owner probeWorkspaceGitMode: unborn repos (git init, no HEAD)
  // sync in plain mode and do not apply Git exclusions.
  try {
    const head = await runCommandWithTimeout(
      ["git", "-C", root, "rev-parse", "--verify", "--quiet", "HEAD"],
      { timeoutMs: GIT_CHECK_IGNORE_TIMEOUT_MS },
    );
    if (head.code !== 0) {
      return true;
    }
  } catch {
    return true;
  }
  try {
    const result = await runCommandWithTimeout(
      ["git", "-C", root, "check-ignore", "-q", "--", relative],
      { timeoutMs: GIT_CHECK_IGNORE_TIMEOUT_MS },
    );
    // Exit 0 => ignored (not transferred unless .worktreeinclude selects it;
    // false-disable avoidance prefers omitting the hard block; dispatch stays
    // authoritative for include-list edge cases).
    if (result.code === 0) {
      return false;
    }
  } catch {
    // Missing git or check failure: keep the portable-symlink guard.
  }
  return true;
}

/**
 * Early-exit walk: true when any *transfer-eligible* workspace symlink is
 * absolute or escapes the root. Caps visited entries so picker catalog reads
 * stay bounded. Skips derived paths (node_modules, caches) and Git-ignored
 * paths the inventory owner would never sync when transfer uses Git mode.
 */
export async function workspaceHasEscapingSymlinks(workspacePath: string): Promise<boolean> {
  const root = path.resolve(workspacePath.trim());
  if (!root) {
    return false;
  }
  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch {
    return false;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return false;
  }

  const queue: string[] = [root];
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > MAX_SYMLINK_PREFLIGHT_ENTRIES) {
        return false;
      }
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (!relative || relative.startsWith("..")) {
        continue;
      }
      // Match transfer inventory: derived caches / node_modules never sync.
      if (isDerivedWorkspacePath(relative) || entry.name === ".git") {
        continue;
      }
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await fs.readlink(absolute);
        } catch {
          continue;
        }
        if (!isPortableRootContainedSymlink(root, relative, target)) {
          if (await isTransferEligibleSymlinkPath(root, relative)) {
            return true;
          }
        }
        continue;
      }
      if (entry.isDirectory()) {
        queue.push(absolute);
      }
    }
  }
  return false;
}

/** Resolves session placement preflight flags for environments.list. */
export async function resolveSessionPlacementPreflight(params: {
  config: OpenClawConfig;
  runtimeId?: string;
  workspacePath?: string;
  agentId?: string;
  authProfileId?: string;
}): Promise<SessionPlacementPreflight> {
  const missingPreparedAuth = resolveMissingPreparedAuthForPlacement({
    config: params.config,
    runtimeId: params.runtimeId,
    agentId: params.agentId,
    authProfileId: params.authProfileId,
  });
  const workspacePath = params.workspacePath?.trim();
  const escaping =
    workspacePath && workspacePath.length > 0
      ? await workspaceHasEscapingSymlinks(workspacePath)
      : false;
  return {
    ...(escaping ? { workspaceHasEscapingSymlinks: true } : {}),
    ...(missingPreparedAuth ? { missingPreparedAuth: true } : {}),
  };
}

/** Stamps session-scoped disabledReason onto paired-device list rows. */
export function applySessionPlacementDisabledReasonToNodes(
  environments: EnvironmentSummary[],
  sessionDisabledReason: string | undefined,
): EnvironmentSummary[] {
  if (!sessionDisabledReason) {
    return environments;
  }
  return environments.map((environment) =>
    environment.type === "node"
      ? { ...environment, disabledReason: sessionDisabledReason }
      : environment,
  );
}

export async function resolveEnvironmentsListSessionPlacement(params: {
  config: OpenClawConfig;
  runtimeId?: string;
  workspacePath?: string;
  agentId?: string;
  authProfileId?: string;
}) {
  const sessionPlacement = await resolveSessionPlacementPreflight(params);
  const sessionDisabledReason = resolveSessionPlacementDisabledReason(sessionPlacement);
  const hasSessionPlacement =
    sessionPlacement.workspaceHasEscapingSymlinks === true ||
    sessionPlacement.missingPreparedAuth === true;
  return {
    sessionPlacement,
    sessionDisabledReason,
    hasSessionPlacement,
  };
}
