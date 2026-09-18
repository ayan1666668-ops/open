import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolvePersistedSessionStoreOwner } from "../config/sessions/session-store-owner.js";
import { normalizePersistedSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import { listConfiguredSessionStoreAgentIds } from "../config/sessions/targets.js";
import type { SessionScope } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectRelevantDoctorPluginIds,
  listPluginDoctorSessionStoreAgentIds,
} from "../plugins/doctor-contract-registry.js";
import {
  LEGACY_IMPLICIT_AGENT_ID as DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  normalizeMainKey,
} from "../routing/session-key.js";
import { readDeferredPluginMigrations } from "./deferred-plugin-migrations.js";
import { preserveDeferredPluginSessionSource } from "./deferred-plugin-session-sources.js";
import { readFileWindowFullySync } from "./file-read.js";
import { expandHomePrefix } from "./home-dir.js";
import {
  existsDir,
  migrationFileExists,
  parseSessionStoreJson5,
  safeReadDir,
  type SessionEntryLike,
} from "./state-migrations.fs.js";
import { saveLegacySessionStore } from "./state-migrations.legacy-session-store.js";
import {
  canonicalizeSessionKeyForAgent,
  isAmbiguousSharedStoreKey,
  isLegacyDefaultMainAliasKey,
  resolveCanonicalAgentSessionOwner,
} from "./state-migrations.session-keys.js";
import {
  resolveSessionStoreAliasPlan,
  sessionStorePathsMatch,
} from "./state-migrations.session-store-paths.js";
import {
  isLegacyGroupKey,
  isSurfaceGroupKey,
  type PreparedLegacySessionSurfaces,
} from "./state-migrations.session-surfaces.js";
import type { MigrationMessages, SessionStoreAliasPlan } from "./state-migrations.types.js";

export {
  isAmbiguousSharedStoreKey,
  isLegacyDefaultMainAliasKey,
} from "./state-migrations.session-keys.js";

export function pickLatestLegacyDirectEntry(
  store: Record<string, SessionEntryLike>,
  legacySessionSurfaces: PreparedLegacySessionSurfaces["surfaces"] = [],
): SessionEntryLike | null {
  let best: SessionEntryLike | null = null;
  let bestUpdated = -1;
  for (const [key, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const normalized = key.trim();
    if (!normalized) {
      continue;
    }
    const normalizedLower = normalizeLowercaseStringOrEmpty(normalized);
    if (normalizedLower === "global") {
      continue;
    }
    if (normalizedLower.startsWith("agent:")) {
      continue;
    }
    if (normalizedLower.startsWith("subagent:")) {
      continue;
    }
    if (isLegacyGroupKey(normalized, legacySessionSurfaces) || isSurfaceGroupKey(normalized)) {
      continue;
    }
    const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
    if (updatedAt > bestUpdated) {
      bestUpdated = updatedAt;
      best = entry;
    }
  }
  return best;
}

export function normalizeSessionEntry(
  entry: SessionEntryLike,
  sessionKey?: string,
): SessionEntry | null {
  const { room, ...entryWithoutRoom } = entry;
  const shaped = normalizePersistedSessionEntryShape(entryWithoutRoom, { sessionKey });
  if (!shaped) {
    return null;
  }
  const normalized = { ...shaped };
  if (typeof normalized.sessionId === "string") {
    normalized.updatedAt =
      typeof normalized.updatedAt === "number" && Number.isFinite(normalized.updatedAt)
        ? normalized.updatedAt
        : Date.now();
  }
  if (typeof normalized.groupChannel !== "string" && typeof room === "string") {
    normalized.groupChannel = room;
  }
  return normalized;
}

function resolveUpdatedAt(entry: SessionEntryLike): number {
  return typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
    ? entry.updatedAt
    : 0;
}

export function selectNewerSessionEntry(params: {
  existing: SessionEntryLike | undefined;
  incoming: SessionEntryLike;
  preferIncomingOnTie?: boolean;
}): SessionEntryLike {
  if (!params.existing) {
    return params.incoming;
  }
  const existingUpdated = resolveUpdatedAt(params.existing);
  const incomingUpdated = resolveUpdatedAt(params.incoming);
  if (incomingUpdated > existingUpdated) {
    return params.incoming;
  }
  if (incomingUpdated < existingUpdated) {
    return params.existing;
  }
  return params.preferIncomingOnTie ? params.incoming : params.existing;
}

export function canonicalizeSessionStore(params: {
  store: Record<string, SessionEntryLike>;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  skipCrossAgentRemap?: boolean;
  preserveCanonicalAgentOwner?: boolean;
  preserveAmbiguousKeys?: boolean;
  preserveForeignMainAliases?: boolean;
  legacySessionSurfaces?: PreparedLegacySessionSurfaces["surfaces"];
}): { store: Record<string, SessionEntryLike>; legacyKeys: string[] } {
  const canonical = Object.create(null) as Record<string, SessionEntryLike>;
  const meta = new Map<string, { isCanonical: boolean; updatedAt: number }>();
  const legacyKeys: string[] = [];

  for (const [key, entry] of Object.entries(params.store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const canonicalKey = canonicalizeSessionKeyForAgent({
      key,
      agentId: params.agentId,
      mainKey: params.mainKey,
      scope: params.scope,
      skipCrossAgentRemap: params.skipCrossAgentRemap,
      preserveCanonicalAgentOwner: params.preserveCanonicalAgentOwner,
      preserveAmbiguousKeys: params.preserveAmbiguousKeys,
      preserveForeignMainAliases: params.preserveForeignMainAliases,
      legacySessionSurfaces: params.legacySessionSurfaces,
    });
    const isCanonical = canonicalKey === key;
    if (!isCanonical) {
      legacyKeys.push(key);
    }
    const existing = canonical[canonicalKey];
    if (!existing) {
      canonical[canonicalKey] = entry;
      meta.set(canonicalKey, { isCanonical, updatedAt: resolveUpdatedAt(entry) });
      continue;
    }

    const existingMeta = meta.get(canonicalKey);
    const incomingUpdated = resolveUpdatedAt(entry);
    const existingUpdated = existingMeta?.updatedAt ?? resolveUpdatedAt(existing);
    if (incomingUpdated > existingUpdated) {
      canonical[canonicalKey] = entry;
      meta.set(canonicalKey, { isCanonical, updatedAt: incomingUpdated });
      continue;
    }
    if (incomingUpdated < existingUpdated) {
      continue;
    }
    if (existingMeta?.isCanonical && !isCanonical) {
      continue;
    }
    if (!existingMeta?.isCanonical && isCanonical) {
      canonical[canonicalKey] = entry;
      meta.set(canonicalKey, { isCanonical, updatedAt: incomingUpdated });
      continue;
    }
  }

  return { store: canonical, legacyKeys };
}

export function aliasedSessionStoreMigrationWarning(params: {
  count: number;
  storePath: string;
}): string {
  return `Deferred migration of ${params.count} ambiguous session key(s) in aliased store ${params.storePath}; remove filesystem aliases or configure one canonical session.store path, then rerun openclaw doctor --fix`;
}

export function unresolvedSessionStoreIdentityWarning(subject: string, storePath: string): string {
  return `Deferred ${subject} for ${storePath}; filesystem identity could not be established for every configured store path. Restore path access or configure one canonical session.store path, then rerun openclaw doctor --fix`;
}

export function distinctSessionStoreAliasWarning(subject: string, storePath: string): string {
  return `Deferred ${subject} in aliased store ${storePath}; atomic replacement cannot update distinct filesystem aliases as one operation. Remove filesystem aliases or configure one canonical session.store path, then rerun openclaw doctor --fix`;
}

export function resolveStaleLegacySessionFile(params: {
  entry: unknown;
  legacyDir: string;
  targetDir: string;
}): string | undefined {
  if (!params.entry || typeof params.entry !== "object" || Array.isArray(params.entry)) {
    return undefined;
  }
  const entry = params.entry as SessionEntryLike;
  const rawSessionFile = entry.sessionFile;
  if (typeof rawSessionFile !== "string") {
    return undefined;
  }
  const legacySessionFile = path.isAbsolute(rawSessionFile)
    ? path.resolve(rawSessionFile)
    : path.resolve(params.legacyDir, rawSessionFile);
  const relative = path.relative(path.resolve(params.legacyDir), legacySessionFile);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    migrationFileExists(legacySessionFile)
  ) {
    return undefined;
  }
  const legacyBackupHasTranscript = safeReadDir(path.dirname(params.legacyDir)).some(
    (dirent) =>
      dirent.isDirectory() &&
      dirent.name.startsWith(`${path.basename(params.legacyDir)}.legacy-`) &&
      migrationFileExists(
        path.join(path.dirname(params.legacyDir), dirent.name, path.basename(legacySessionFile)),
      ),
  );
  if (legacyBackupHasTranscript) {
    return undefined;
  }
  const parsed = path.parse(path.basename(legacySessionFile));
  const hasCollisionRename = safeReadDir(params.targetDir).some(
    (dirent) =>
      dirent.isFile() &&
      dirent.name.startsWith(`${parsed.name}.legacy-`) &&
      dirent.name.endsWith(parsed.ext),
  );
  if (hasCollisionRename) {
    return undefined;
  }
  const targetSessionFile = path.join(params.targetDir, path.basename(legacySessionFile));
  if (!migrationFileExists(targetSessionFile) || typeof entry.sessionId !== "string") {
    return undefined;
  }
  const readFirstLine = () => {
    const fd = fs.openSync(targetSessionFile, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const bytesRead = readFileWindowFullySync(fd, buffer, 0);
      if (bytesRead <= 0) {
        return undefined;
      }
      const chunk = buffer.subarray(0, bytesRead).toString("utf8");
      const newline = chunk.indexOf("\n");
      return newline >= 0 ? chunk.slice(0, newline) : chunk;
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    const firstLine = readFirstLine();
    const header = firstLine ? (JSON.parse(firstLine) as unknown) : undefined;
    if (!header || typeof header !== "object" || Array.isArray(header)) {
      return undefined;
    }
    if ((header as { type?: unknown }).type === "session") {
      return (header as { id?: unknown }).id === entry.sessionId ? targetSessionFile : undefined;
    }
    const canonicalFileName =
      path.basename(entry.sessionId) === entry.sessionId ? `${entry.sessionId}.jsonl` : undefined;
    return canonicalFileName === path.basename(targetSessionFile) ? targetSessionFile : undefined;
  } catch {
    return undefined;
  }
}

function sessionStoreMayNeedCanonicalization(params: {
  store: Record<string, SessionEntryLike>;
  storeAgentIds: Iterable<string>;
  mainKey: string;
  scope?: SessionScope;
  preserveForeignMainAliases?: boolean;
}): boolean {
  const storeAgentIds = new Set([...params.storeAgentIds].map((id) => normalizeAgentId(id)));
  const hasNonMainAgent = [...storeAgentIds].some((id) => id !== DEFAULT_AGENT_ID);
  for (const key of Object.keys(params.store)) {
    const rawKey = key.trim();
    if (rawKey !== key) {
      return true;
    }
    if (!rawKey) {
      continue;
    }
    const lowerKey = normalizeLowercaseStringOrEmpty(rawKey);
    if (lowerKey !== rawKey) {
      return true;
    }
    if (lowerKey === "global" || lowerKey === "unknown") {
      continue;
    }
    if (
      params.preserveForeignMainAliases &&
      isLegacyDefaultMainAliasKey(lowerKey, params.mainKey)
    ) {
      return true;
    }
    if (lowerKey === DEFAULT_MAIN_KEY || lowerKey === params.mainKey) {
      return true;
    }
    if (lowerKey.startsWith("subagent:")) {
      return true;
    }
    if (lowerKey.startsWith("group:") || lowerKey.startsWith("channel:")) {
      return true;
    }
    if (!lowerKey.startsWith("agent:")) {
      return true;
    }
    const rowOwner = resolveCanonicalAgentSessionOwner(rawKey);
    if (!rowOwner) {
      return true;
    }
    const agentMainAlias = `agent:${rowOwner}:${DEFAULT_MAIN_KEY}`;
    const agentMainKey = `agent:${rowOwner}:${params.mainKey}`;
    if (
      lowerKey === agentMainAlias &&
      (params.mainKey !== DEFAULT_MAIN_KEY || params.scope === "global")
    ) {
      return true;
    }
    if (lowerKey === agentMainKey && params.scope === "global") {
      return true;
    }
    if (
      lowerKey === `agent:${DEFAULT_AGENT_ID}:${DEFAULT_MAIN_KEY}` &&
      (params.mainKey !== DEFAULT_MAIN_KEY || hasNonMainAgent || params.scope === "global")
    ) {
      return true;
    }
    if (
      lowerKey === `agent:${DEFAULT_AGENT_ID}:${params.mainKey}` &&
      hasNonMainAgent &&
      !storeAgentIds.has(DEFAULT_AGENT_ID)
    ) {
      return true;
    }
  }
  return false;
}

export function listLegacySessionKeys(params: {
  store: Record<string, SessionEntryLike>;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  preserveAmbiguousKeys?: boolean;
  preserveForeignMainAliases?: boolean;
  legacySessionSurfaces?: PreparedLegacySessionSurfaces["surfaces"];
}): string[] {
  const legacy: string[] = [];
  for (const key of Object.keys(params.store)) {
    const canonical = canonicalizeSessionKeyForAgent({
      key,
      agentId: params.agentId,
      mainKey: params.mainKey,
      scope: params.scope,
      skipCrossAgentRemap: params.preserveAmbiguousKeys,
      preserveCanonicalAgentOwner: params.preserveAmbiguousKeys,
      preserveAmbiguousKeys: params.preserveAmbiguousKeys,
      preserveForeignMainAliases: params.preserveForeignMainAliases,
      legacySessionSurfaces: params.legacySessionSurfaces,
    });
    if (canonical !== key) {
      legacy.push(key);
    }
  }
  return legacy;
}

export function removeDirIfEmpty(dir: string) {
  if (!existsDir(dir) || safeReadDir(dir).length > 0) {
    return;
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    // ignore
  }
}

export async function migrateOrphanedSessionKeys(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  additionalAgentIds?: readonly string[];
  legacySessionSurfaces: PreparedLegacySessionSurfaces | (() => PreparedLegacySessionSurfaces);
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const recoverableWarnings: string[] = [];
  const env = params.env ?? process.env;
  let preparedLegacySessionSurfaces: PreparedLegacySessionSurfaces | undefined;
  const resolveLegacySessionSurfaces = () =>
    (preparedLegacySessionSurfaces ??=
      typeof params.legacySessionSurfaces === "function"
        ? params.legacySessionSurfaces()
        : params.legacySessionSurfaces);
  const stateDir = resolveStateDir(env);
  const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
  const scope = params.cfg.session?.scope as SessionScope | undefined;
  const storeConfig = params.cfg.session?.store;
  const persistedStoreOwner = resolvePersistedSessionStoreOwner(params.cfg);
  const pendingPluginMigrations = readDeferredPluginMigrations({ env });
  const persistedStoreAgentId =
    persistedStoreOwner.kind === "configured" ? persistedStoreOwner.agentId : undefined;
  const persistedStorePath =
    persistedStoreAgentId && storeConfig
      ? resolveStorePathFromTemplate(storeConfig, persistedStoreAgentId, env)
      : undefined;
  const pluginAgentIds =
    params.additionalAgentIds ??
    listPluginDoctorSessionStoreAgentIds({
      config: params.cfg,
      env,
      pluginIds: collectRelevantDoctorPluginIds(params.cfg),
    });
  const pluginAgentIdSet = new Set(pluginAgentIds.map((id) => normalizeAgentId(id)));

  // Fixed session.store paths can be shared by several agent owners.
  const storeMap = new Map<string, Set<string>>();
  const storeAliasCandidates = new Map<string, Set<string>>();
  const addToStoreMap = (p: string, id: string) => {
    try {
      // Exact SQLite locators are canonical databases, never legacy JSON sources.
      if (p.endsWith(".sqlite") || !fs.statSync(p, { throwIfNoEntry: false })?.isFile()) {
        return;
      }
    } catch {
      // Inaccessible paths must stay in their fail-closed alias group.
    }
    // A fixed-store owner is durable migration provenance. Keep other configured
    // agents from making that store's unscoped rows look ambiguous.
    const ownerId =
      persistedStoreAgentId && persistedStorePath && sessionStorePathsMatch(p, persistedStorePath)
        ? persistedStoreAgentId
        : id;
    // Existing aliases are one ownership surface. Group them before any atomic
    // rewrite can replace one pathname and hide their original identity.
    const storePath =
      [...storeMap.keys()].find((candidate) => sessionStorePathsMatch(candidate, p)) ?? p;
    const aliasCandidates = storeAliasCandidates.get(storePath) ?? new Set([storePath]);
    aliasCandidates.add(p);
    storeAliasCandidates.set(storePath, aliasCandidates);
    storeMap.set(storePath, (storeMap.get(storePath) ?? new Set<string>()).add(ownerId));
  };
  // Configured ownership includes normal agents plus ACP runtime/default hints.
  for (const configuredAgentId of listConfiguredSessionStoreAgentIds(params.cfg)) {
    const id = normalizeAgentId(configuredAgentId);
    const p = storeConfig
      ? resolveStorePathFromTemplate(storeConfig, id, env)
      : path.join(stateDir, "agents", id, "sessions", "sessions.json");
    addToStoreMap(p, id);
  }
  // Plugins can route core sessions to agents that are not declared in
  // agents.list. A templated path proves ownership for those stores too.
  for (const pluginAgentId of pluginAgentIds) {
    const id = normalizeAgentId(pluginAgentId);
    const p = storeConfig
      ? resolveStorePathFromTemplate(storeConfig, id, env)
      : path.join(stateDir, "agents", id, "sessions", "sessions.json");
    addToStoreMap(p, id);
  }
  // Agent directories present on disk.
  // This only covers the standard state-dir layout so we can still pick up
  // orphaned stores left behind by older configs. Active custom-template paths
  // are already covered by the configured-agents loop above.
  const agentsDir = path.join(stateDir, "agents");
  if (existsDir(agentsDir)) {
    for (const dirEntry of safeReadDir(agentsDir)) {
      if (dirEntry.isDirectory()) {
        const diskAgentId = normalizeAgentId(dirEntry.name);
        if (diskAgentId) {
          const diskPath = path.join(agentsDir, diskAgentId, "sessions", "sessions.json");
          addToStoreMap(diskPath, diskAgentId);
        }
      }
    }
  }

  for (const [mappedStorePath, storeAgentIds] of storeMap) {
    if (
      [...storeAgentIds].some((agentId) =>
        preserveDeferredPluginSessionSource({
          cfg: params.cfg,
          env,
          target: { agentId, storePath: mappedStorePath },
          pending: pendingPluginMigrations,
        }),
      )
    ) {
      continue;
    }
    const storePaths = storeAliasCandidates.get(mappedStorePath) ?? new Set([mappedStorePath]);
    // An unknown relationship may have grouped a readable store behind an
    // inaccessible pathname. Read from a usable alias so the group still gets
    // the unresolved-identity warning before any rewrite is attempted.
    const storePath = [...storePaths].find((candidate) => migrationFileExists(candidate));
    if (!storePath) {
      continue;
    }
    const pluginForeignMainAliasRisk = [...storeAgentIds].some(
      (id) => pluginAgentIdSet.has(id) && id !== DEFAULT_AGENT_ID,
    );
    let parsed: ReturnType<typeof parseSessionStoreJson5>;
    try {
      parsed = parseSessionStoreJson5(fs.readFileSync(storePath, "utf-8"));
    } catch (err) {
      warnings.push(`Could not read ${storePath}: ${String(err)}`);
      continue;
    }
    if (
      !parsed.ok ||
      !sessionStoreMayNeedCanonicalization({
        store: parsed.store,
        storeAgentIds,
        mainKey,
        scope,
        preserveForeignMainAliases: pluginForeignMainAliasRisk,
      })
    ) {
      continue;
    }
    const legacySessionSurfaces = resolveLegacySessionSurfaces();
    if (legacySessionSurfaces.failures.length > 0) {
      return {
        changes,
        warnings: [...warnings, ...recoverableWarnings, ...legacySessionSurfaces.failures],
      };
    }
    // A physical store can have several owners. Canonicalize valid scoped rows
    // within their declared owner on every pass so iteration order cannot move
    // one agent's history into another namespace.
    let working = parsed.store;
    let totalLegacy = 0;
    const storeAliases = resolveSessionStoreAliasPlan(storePath, storePaths);
    const hasDistinctAliases = storeAliases.hasDistinctAliases;
    const preserveAmbiguousKeys = storeAgentIds.size > 1;
    const preservedAmbiguousKeyCount = Object.keys(working).filter(
      (key) =>
        (preserveAmbiguousKeys && isAmbiguousSharedStoreKey(key, mainKey, scope)) ||
        (pluginForeignMainAliasRisk && isLegacyDefaultMainAliasKey(key, mainKey)),
    ).length;
    if (storeAliases.hasUnresolvedIdentity) {
      warnings.push(unresolvedSessionStoreIdentityWarning("session key migration", storePath));
      continue;
    }
    if (hasDistinctAliases && preservedAmbiguousKeyCount > 0) {
      warnings.push(
        aliasedSessionStoreMigrationWarning({
          count: preservedAmbiguousKeyCount,
          storePath,
        }),
      );
      continue;
    }
    if (storeAliases.hasFinalSymlink) {
      warnings.push(
        `Deferred session key migration in final-component symlink store ${storePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
      );
      continue;
    }
    if (hasDistinctAliases) {
      warnings.push(distinctSessionStoreAliasWarning("session key migration", storePath));
      continue;
    }
    for (const storeAgentId of storeAgentIds) {
      const { store: canonicalized, legacyKeys } = canonicalizeSessionStore({
        store: working,
        agentId: storeAgentId,
        mainKey,
        scope,
        skipCrossAgentRemap: preserveAmbiguousKeys,
        preserveCanonicalAgentOwner: true,
        preserveAmbiguousKeys,
        preserveForeignMainAliases: pluginForeignMainAliasRisk,
        legacySessionSurfaces: legacySessionSurfaces.surfaces,
      });
      working = canonicalized;
      // Each pass only counts keys it changed from the current working store, so
      // once a key is canonicalized it is not counted again by later agent passes.
      totalLegacy += legacyKeys.length;
    }
    if (preservedAmbiguousKeyCount > 0) {
      recoverableWarnings.push(
        `Preserved ${preservedAmbiguousKeyCount} ambiguous session key(s) in potentially shared store ${storePath}`,
      );
    }
    if (totalLegacy === 0) {
      continue;
    }
    const normalized = Object.create(null) as Record<string, SessionEntry>;
    for (const [key, entry] of Object.entries(working)) {
      const ne = normalizeSessionEntry(entry, key);
      if (ne) {
        normalized[key] = ne;
      }
    }
    try {
      await saveSessionStoreStrict(storePath, normalized);
      changes.push(`Canonicalized ${totalLegacy} orphaned session key(s) in ${storePath}`);
    } catch (err) {
      warnings.push(`Failed to write canonicalized store ${storePath}: ${String(err)}`);
    }
  }

  return {
    changes,
    warnings: [...warnings, ...recoverableWarnings],
    ...(warnings.length === 0 && recoverableWarnings.length > 0
      ? { warningDisposition: "recoverable" as const }
      : {}),
  };
}

function resolveStorePathFromTemplate(
  template: string,
  agentId: string,
  env?: NodeJS.ProcessEnv,
): string {
  const expand = (s: string) =>
    s.startsWith("~") ? expandHomePrefix(s, { env: env ?? process.env, homedir: os.homedir }) : s;
  if (template.includes("{agentId}")) {
    return path.resolve(expand(template.replaceAll("{agentId}", agentId)));
  }
  return path.resolve(expand(template));
}

export function mergeSessionStoreAliasPlans(
  left: SessionStoreAliasPlan | undefined,
  right: SessionStoreAliasPlan,
): SessionStoreAliasPlan {
  if (!left) {
    return right;
  }
  return {
    hasDistinctAliases: left.hasDistinctAliases || right.hasDistinctAliases,
    hasFinalSymlink: left.hasFinalSymlink || right.hasFinalSymlink,
    hasUnresolvedIdentity: left.hasUnresolvedIdentity || right.hasUnresolvedIdentity,
  };
}

export async function saveSessionStoreStrict(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  await saveLegacySessionStore(storePath, store, {
    requireWriteSuccess: true,
    skipMaintenance: true,
  });
}

export type SessionStoreOwnership = {
  preserveAmbiguousKeys: boolean;
  preserveForeignMainAliases: boolean;
  targetStoreAliases: SessionStoreAliasPlan;
};

export function resolveSessionStoreOwnership(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  targetAgentId: string;
  pluginSessionStoreAgentIds: readonly string[];
}): SessionStoreOwnership {
  const targetStorePath = path.join(
    params.stateDir,
    "agents",
    params.targetAgentId,
    "sessions",
    "sessions.json",
  );
  const configuredStore = params.cfg.session?.store;
  const resolveAgentStorePath = (agentId: string) =>
    configuredStore
      ? resolveStorePathFromTemplate(configuredStore, agentId, params.env)
      : path.join(params.stateDir, "agents", agentId, "sessions", "sessions.json");
  const preserveForeignMainAliases = params.pluginSessionStoreAgentIds.some((pluginAgentId) => {
    const id = normalizeAgentId(pluginAgentId);
    if (id === DEFAULT_AGENT_ID) {
      return false;
    }
    return sessionStorePathsMatch(resolveAgentStorePath(id), targetStorePath);
  });
  const candidateAgentIds = new Set([
    ...listConfiguredSessionStoreAgentIds(params.cfg).map((id) => normalizeAgentId(id)),
    ...params.pluginSessionStoreAgentIds.map((id) => normalizeAgentId(id)),
  ]);
  const configuredOwnerStorePaths = [...candidateAgentIds].map(resolveAgentStorePath);
  const targetStoreOwnerCount = configuredOwnerStorePaths.filter((storePath) =>
    sessionStorePathsMatch(storePath, targetStorePath),
  ).length;
  const preserveAmbiguousKeys = targetStoreOwnerCount > 1;
  const candidateStorePaths = [...configuredOwnerStorePaths];
  const agentsDir = path.join(params.stateDir, "agents");
  for (const entry of safeReadDir(agentsDir)) {
    if (entry.isDirectory()) {
      candidateStorePaths.push(path.join(agentsDir, entry.name, "sessions", "sessions.json"));
    }
  }
  const targetStoreAliases = resolveSessionStoreAliasPlan(targetStorePath, candidateStorePaths);
  return { preserveAmbiguousKeys, preserveForeignMainAliases, targetStoreAliases };
}
