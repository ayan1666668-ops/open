/** Offline Doctor target discovery and legacy-source admission. */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isPrimarySessionTranscriptFileName } from "../config/sessions/artifacts.js";
import {
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreCandidateTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
  resolveConfiguredAgentDatabaseTargets,
  resolveSessionStoreTargets,
  type SessionStoreTarget as ResolvedSessionStoreTarget,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createAgentDatabaseDeletionClassifier } from "../state/agent-deletion-discovery.js";
import { readAgentDatabaseDeletionSnapshot } from "../state/agent-deletion-journal.read.js";
import type { HistoricalArchiveSources } from "./doctor-session-sqlite-discovery.js";
import { canonicalMigrationFilePath } from "./doctor-session-sqlite-migration-run.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";
import type { DoctorSessionSqliteMode } from "./doctor-session-sqlite-types.js";

type SessionStoreTarget = ResolvedSessionStoreTarget & { sqlitePath?: string };

export function resolveDoctorSessionSqliteTargets(params: {
  allAgents?: boolean;
  agent?: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode: DoctorSessionSqliteMode;
  store?: string;
}): SessionStoreTarget[] {
  const snapshot = readAgentDatabaseDeletionSnapshot(params.env);
  const classifyDeletion =
    snapshot &&
    snapshot.retainedDeletions !== "unavailable" &&
    snapshot.retainedDeletions.length > 0
      ? createAgentDatabaseDeletionClassifier({
          ...snapshot,
          env: params.env,
          configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(params.cfg, {
            env: params.env,
          }),
        })
      : undefined;
  // Omit only recorded retained deletions; unknown history keeps its normal diagnostics.
  const admit = (targets: SessionStoreTarget[]) =>
    classifyDeletion
      ? targets.filter(
          (target) =>
            !classifyDeletion(target.storePath, target.agentId) &&
            !classifyDeletion(resolveTargetSqlitePath(target, params.env), target.agentId),
        )
      : targets;
  if (params.store) {
    return admit(
      resolveSessionStoreTargets(params.cfg, { store: params.store }, { env: params.env }),
    );
  }
  const discoversHistory =
    params.mode === "dry-run" || params.mode === "import" || params.mode === "validate";
  if (
    params.mode === "restore" ||
    params.mode === "recover" ||
    (discoversHistory && params.agent)
  ) {
    const candidates = resolveAllAgentSessionStoreCandidateTargetsSync(params.cfg, {
      env: params.env,
    });
    if (!params.agent) {
      return admit(candidates);
    }
    const requestedAgentId = normalizeAgentId(params.agent);
    return admit(
      candidates.filter((target) => normalizeAgentId(target.agentId) === requestedAgentId),
    );
  }
  if (params.agent) {
    return admit(
      resolveAgentSessionStoreTargetsSync(params.cfg, params.agent, { env: params.env }),
    );
  }
  if (params.allAgents) {
    // Discovery must admit validated directories even before either registry exists.
    const targets = discoversHistory
      ? resolveAllAgentSessionStoreCandidateTargetsSync(params.cfg, { env: params.env })
      : resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env });
    if (!discoversHistory) {
      return admit(targets);
    }
    const legacyStorePath = path.join(resolveStateDir(params.env), "sessions", "sessions.json");
    if (!fs.existsSync(legacyStorePath)) {
      return admit(targets);
    }
    const legacyTargets = resolveSessionStoreTargets(
      params.cfg,
      { allAgents: true },
      { env: params.env },
    ).map((target) => ({
      agentId: target.agentId,
      sqlitePath: resolveTargetSqlitePath(target),
      storePath: legacyStorePath,
    }));
    return admit([...legacyTargets, ...targets]);
  }
  return admit(resolveSessionStoreTargets(params.cfg, {}, { env: params.env }));
}

export function filterLegacySessionStoreTargets(
  targets: SessionStoreTarget[],
  mode: DoctorSessionSqliteMode,
  historicalArchives: HistoricalArchiveSources,
  settledStores: ReadonlySet<string>,
): SessionStoreTarget[] {
  if (mode === "inspect" || mode === "compact" || mode === "restore" || mode === "recover") {
    return targets;
  }
  return targets.filter(
    (target) =>
      !target.storePath.endsWith(".sqlite") &&
      (settledStores.has(target.storePath) ||
        fs.existsSync(target.storePath) ||
        (historicalArchives.get(canonicalMigrationFilePath(target.storePath))?.transcripts.length ??
          0) > 0 ||
        (fs.existsSync(path.dirname(target.storePath)) &&
          fs.readdirSync(path.dirname(target.storePath)).some(isPrimarySessionTranscriptFileName))),
  );
}
