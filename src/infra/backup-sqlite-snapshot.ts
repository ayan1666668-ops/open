// Snapshots every SQLite database owned by the frozen backup resource inventory.
import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { BackupResourceInventory } from "../commands/backup-resource-inventory.js";
import { isPathWithin } from "../commands/cleanup-utils.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import { embedSessionColdArchivesInSnapshot } from "../config/sessions/session-cold-storage-backup.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { assertOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-maintenance.js";
import { readOpenClawAgentDatabaseRegistryRows } from "../state/openclaw-agent-db-registry-listing.js";
import { assertOpenClawStateDatabaseOwner } from "../state/openclaw-state-db-maintenance.js";
import { resolveOpenClawRegisteredAgentDatabasePath } from "../state/openclaw-state-db.paths.js";
import {
  sanitizeOpenClawGlobalStateSnapshot,
  sanitizeOpenClawStateLeaseRows,
} from "../state/openclaw-state-snapshot-sanitizer.js";
import {
  captureBackupSqliteSourceGroup,
  planBackupSqliteSourceGroups,
} from "./backup-sqlite-source-groups.js";
import { isTransientSqliteBackupPath } from "./backup-volatile-filter.js";
import { hasErrnoCode } from "./errno.js";
import { collectErrorGraphCandidates, formatErrorMessage } from "./errors.js";
import { sameFileIdentity } from "./fs-safe-advanced.js";
import {
  isAppleDoubleMetadataFile,
  resolveSqliteDatabaseFilePaths,
  SQLITE_SIDECAR_SUFFIXES,
} from "./sqlite-files.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import {
  createLegacyAuditDatabaseWitness,
  LegacyAuditBackupStateChangedError,
  rewriteLegacyAuditBackupCheckpoints,
  type LegacyAuditBackupSnapshot,
} from "./state-migrations.audit-backup.js";
import { assertNotUpdateCapturePath } from "./update-capture-paths.js";

type SqliteBackupAsset = {
  sourcePath: string;
  archiveSourcePath: string;
  skippedSourcePaths: Set<string>;
};

function findLegacyAuditBackupStateChange(
  error: unknown,
): LegacyAuditBackupStateChangedError | undefined {
  return collectErrorGraphCandidates(error, (candidate) =>
    candidate instanceof Error ? [candidate.cause] : [],
  ).find(
    (candidate): candidate is LegacyAuditBackupStateChangedError =>
      candidate instanceof LegacyAuditBackupStateChangedError,
  );
}

type CanonicalSqliteSource = {
  archiveSourcePath: string;
  identity: Stats;
  sourcePath: string;
} & ({ role: "global" } | { role: "agent"; agentId: string });

function resolveSqliteBackupDatabasePath(sourcePath: string): string | undefined {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    if (sourcePath.endsWith(suffix)) {
      const databasePath = sourcePath.slice(0, -suffix.length);
      return databasePath.endsWith(".sqlite") ? databasePath : undefined;
    }
  }
  return sourcePath.endsWith(".sqlite") ? sourcePath : undefined;
}

export function classifyBackupSqliteSource(
  sourcePath: string,
  inventory: BackupResourceInventory,
): "excluded" | "sqlite" | "opaque" | undefined {
  const resolvedSourcePath = path.resolve(sourcePath);
  const transient = isTransientSqliteBackupPath(resolvedSourcePath);
  const databasePath = resolveSqliteBackupDatabasePath(resolvedSourcePath);
  if (!transient && !databasePath) {
    return undefined;
  }
  const withinOwnedRoot =
    isPathWithin(resolvedSourcePath, inventory.stateDir) ||
    inventory.agentRoots.some(({ sourcePath: agentRoot }) =>
      isPathWithin(resolvedSourcePath, agentRoot),
    );
  if (!withinOwnedRoot || inventory.isPackageContent(resolvedSourcePath)) {
    return undefined;
  }
  if (transient || !inventory.isIncluded(resolvedSourcePath)) {
    return "excluded";
  }
  if (isAppleDoubleMetadataFile(resolvedSourcePath)) {
    return "excluded";
  }
  return databasePath && inventory.resolveSqliteOwner(databasePath) ? "sqlite" : "opaque";
}

async function discoverBackupSqliteSources(params: {
  inventory: BackupResourceInventory;
}): Promise<{ snapshotPaths: string[]; discoveredSourcePaths: Set<string> }> {
  const snapshotPaths = new Set<string>();
  const discoveredSourcePaths = new Set<string>();
  const visitedDirectories = new Set<string>();
  const gatewayLockDir = resolveGatewayLockDir(params.inventory.stateDir);

  async function visit(directoryPath: string): Promise<void> {
    const resolvedDirectoryPath = path.resolve(directoryPath);
    if (visitedDirectories.has(resolvedDirectoryPath)) {
      return;
    }
    visitedDirectories.add(resolvedDirectoryPath);

    let entries: Dirent[];
    try {
      entries = await fs.readdir(resolvedDirectoryPath, { withFileTypes: true });
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(resolvedDirectoryPath, entry.name);
      if (isPathWithin(entryPath, gatewayLockDir) || params.inventory.isVolatile(entryPath)) {
        continue;
      }
      if (entry.isDirectory()) {
        if (
          params.inventory.isTraversable(entryPath) &&
          !params.inventory.isPackageContent(entryPath)
        ) {
          await visit(entryPath);
        }
        continue;
      }
      // Exclusions win before symlink/stat handling; protected declarations
      // are already resolved by the inventory's include-over-exclude policy.
      if (!params.inventory.isIncluded(entryPath)) {
        continue;
      }
      if (
        (!entry.isFile() && !entry.isSymbolicLink()) ||
        classifyBackupSqliteSource(entryPath, params.inventory) !== "sqlite"
      ) {
        continue;
      }
      discoveredSourcePaths.add(entryPath);
      if (entry.name.endsWith(".sqlite")) {
        snapshotPaths.add(entryPath);
      }
    }
  }

  await visit(params.inventory.stateDir);
  for (const { sourcePath } of params.inventory.agentRoots) {
    await visit(sourcePath);
  }

  for (const database of params.inventory.coreDatabases) {
    if (database.identity && params.inventory.isIncluded(database.sourcePath)) {
      snapshotPaths.add(database.sourcePath);
      discoveredSourcePaths.add(database.sourcePath);
    }
  }

  return {
    snapshotPaths: [...snapshotPaths].toSorted((left, right) => left.localeCompare(right)),
    discoveredSourcePaths,
  };
}

export async function createBackupSqliteSnapshotPlan(params: {
  inventory: BackupResourceInventory;
  tempDir: string;
  legacyAuditSnapshots: readonly LegacyAuditBackupSnapshot[];
  legacyAuditDatabaseWitness?: string;
}): Promise<{ snapshots: SqliteBackupAsset[]; discoveredSourcePaths: Set<string> }> {
  // Discovery finishes before staging so overlapping roots cannot discover snapshots.
  const discovery = await discoverBackupSqliteSources({ inventory: params.inventory });
  const sources: Array<{
    archiveSourcePath: string;
    identity: Stats;
    canonicalSource: CanonicalSqliteSource | undefined;
  }> = [];
  for (const archiveSourcePath of discovery.snapshotPaths) {
    const identity = await fs.stat(archiveSourcePath);
    const owner = params.inventory.resolveSqliteOwner(archiveSourcePath, identity);
    if (!owner) {
      throw new Error(`SQLite ownership changed after discovery: ${archiveSourcePath}`);
    }
    let canonicalSource: CanonicalSqliteSource | undefined;
    if (owner.role !== "plugin") {
      if (!owner.identity || !sameFileIdentity(owner.identity, identity)) {
        throw new Error(`Canonical SQLite path changed after discovery: ${archiveSourcePath}`);
      }
      canonicalSource = {
        ...owner,
        archiveSourcePath: owner.sourcePath,
        sourcePath: await fs.realpath(owner.sourcePath),
        identity: owner.identity,
      };
    }
    sources.push({ archiveSourcePath, identity, canonicalSource });
  }
  const genericGroups = await planBackupSqliteSourceGroups(
    sources
      .filter((source) => !source.canonicalSource)
      .map((source) => ({ path: source.archiveSourcePath, identity: source.identity })),
  );
  const capturedSnapshots = new Map<string, string>();
  const snapshots: SqliteBackupAsset[] = [];
  for (const { archiveSourcePath, canonicalSource } of sources) {
    if (
      canonicalSource &&
      !sameFileIdentity(canonicalSource.identity, await fs.stat(archiveSourcePath))
    ) {
      throw new Error(`Canonical SQLite path changed after discovery: ${archiveSourcePath}`);
    }
    const genericGroup = genericGroups.get(archiveSourcePath);
    const sourceDatabasePath =
      canonicalSource?.sourcePath ?? genericGroup?.sourcePath ?? archiveSourcePath;
    assertNotUpdateCapturePath(archiveSourcePath, params.inventory.stateDir);
    assertNotUpdateCapturePath(sourceDatabasePath, params.inventory.stateDir);
    const sourcePath = path.join(params.tempDir, `openclaw-state-db-${snapshots.length}.sqlite`);
    try {
      const capture = () =>
        createVerifiedSqliteSnapshot({
          sourcePath: sourceDatabasePath,
          targetPath: sourcePath,
          requireNonEmptySource: Boolean(canonicalSource),
          validate:
            canonicalSource?.role === "global"
              ? (database, pathname) => assertOpenClawStateDatabaseOwner(database, { pathname })
              : canonicalSource?.role === "agent"
                ? (database, pathname) =>
                    assertOpenClawAgentDatabaseOwner(database, {
                      agentId: canonicalSource.agentId,
                      pathname,
                    })
                : undefined,
          transform: async (database) => {
            if (canonicalSource?.role === "global") {
              const registeredAgents = params.inventory.coreDatabases.filter(
                (owner) => owner.role === "agent",
              );
              const expectedOwners = new Map(
                registeredAgents.map((owner) => [path.resolve(owner.sourcePath), owner.agentId]),
              );
              const capturedAgents = readOpenClawAgentDatabaseRegistryRows(
                database,
                canonicalSource.archiveSourcePath,
              );
              if (
                capturedAgents.length !== registeredAgents.length ||
                capturedAgents.some(
                  (row) =>
                    expectedOwners.get(
                      path.resolve(
                        resolveOpenClawRegisteredAgentDatabasePath(
                          canonicalSource.archiveSourcePath,
                          row.path,
                        ),
                      ),
                    ) !== normalizeAgentId(row.agent_id),
                )
              ) {
                throw new Error(
                  "Agent database registry changed during backup; retry with a stable registry.",
                );
              }
              if (
                params.legacyAuditDatabaseWitness !== undefined &&
                createLegacyAuditDatabaseWitness(database) !== params.legacyAuditDatabaseWitness
              ) {
                throw new LegacyAuditBackupStateChangedError(
                  "Legacy audit database rows changed during SQLite backup",
                );
              }
              sanitizeOpenClawGlobalStateSnapshot(database);
              rewriteLegacyAuditBackupCheckpoints(database, params.legacyAuditSnapshots);
            } else if (canonicalSource?.role === "agent") {
              sanitizeOpenClawStateLeaseRows(database);
            }
            await embedSessionColdArchivesInSnapshot({
              database,
              sourceStorePath:
                canonicalSource?.archiveSourcePath ?? genericGroup?.sourcePath ?? archiveSourcePath,
            });
          },
        });
      const captureOwner = canonicalSource?.archiveSourcePath ?? sourceDatabasePath;
      const capturedPath = capturedSnapshots.get(captureOwner);
      if (capturedPath) {
        // Each archive name needs its own staged path; the remap owner keys by
        // staged path. Copy only the already verified, compacted private image.
        await fs.copyFile(capturedPath, sourcePath, fs.constants.COPYFILE_EXCL);
      } else if (genericGroup) {
        await captureBackupSqliteSourceGroup(genericGroup, capture);
      } else {
        await capture();
      }
      capturedSnapshots.set(captureOwner, sourcePath);
    } catch (error) {
      const stateChange = findLegacyAuditBackupStateChange(error);
      if (stateChange) {
        throw stateChange;
      }
      throw new Error(
        `SQLite database cannot be compacted safely for backup: ${archiveSourcePath}. ${formatErrorMessage(error)}. The source must pass full integrity checks, online SQLite backup, and offline compaction with its required SQLite capabilities; a direct file copy was refused because it can retain deleted data.`,
        { cause: error },
      );
    }
    snapshots.push({
      sourcePath,
      archiveSourcePath,
      skippedSourcePaths: new Set(
        [archiveSourcePath, sourceDatabasePath].flatMap((databasePath) =>
          resolveSqliteDatabaseFilePaths(databasePath).map((pathname) => path.resolve(pathname)),
        ),
      ),
    });
  }
  return { snapshots, discoveredSourcePaths: discovery.discoveredSourcePaths };
}
