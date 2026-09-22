import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ProjectRecent } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayStoredSessionTargets } from "../../config/sessions/combined-store-gateway.js";
import { sessionCreatorProfileId } from "../../config/sessions/session-entry-provenance.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { ProjectRegistryRecord } from "../../projects/project-registry.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";

function folderDisplayName(folder: string): string {
  const trimmed = folder.replace(/[\\/]+$/u, "");
  return trimmed.split(/[\\/]/u).at(-1) || folder;
}

function indexPathProjects(projects: readonly ProjectRegistryRecord[]) {
  const byPath = new Map<string, ProjectRegistryRecord>();
  const byAgent = new Map<string | undefined, ProjectRegistryRecord>();
  for (const project of projects) {
    // The registry emits one workspace per unique configured agent.
    if (project.source === "workspace") {
      byAgent.set(project.agentId, project);
    }
    const previous = byPath.get(project.repoRoot);
    if (
      !previous ||
      (Number(project.source === "workspace") - Number(previous.source === "workspace") ||
        project.id.localeCompare(previous.id)) < 0
    ) {
      byPath.set(project.repoRoot, project);
    }
  }
  return { byPath, byAgent };
}

export function listProjectRecents(
  store: Record<string, SessionEntry>,
  targetsBySessionKey: GatewayStoredSessionTargets,
  profileIds: ReadonlySet<string>,
  projects: readonly ProjectRegistryRecord[],
): ProjectRecent[] {
  const candidates = Object.entries(store)
    .filter(
      ([, entry]) =>
        Boolean(sessionCreatorProfileId(entry.createdActor)) &&
        Boolean(entry.createdActor?.id && profileIds.has(entry.createdActor.id)),
    )
    .toSorted(
      ([leftKey, left], [rightKey, right]) =>
        (right.updatedAt ?? 0) - (left.updatedAt ?? 0) || leftKey.localeCompare(rightKey),
    );
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const seen = new Set<string>();
  const recents: ProjectRecent[] = [];
  let pathProjects: ReturnType<typeof indexPathProjects> | undefined;
  for (const [sessionKey, entry] of candidates) {
    const owner = expectDefined(targetsBySessionKey.get(sessionKey), "recent session owner");
    if (entry.repositoryWorkspaceId) {
      const repository = getSessionRepositoryWorkspaceStore().get(entry.repositoryWorkspaceId);
      if (
        !repository ||
        repository.sessionKey !== sessionKey ||
        repository.agentId !== owner.agentId ||
        seen.has(repository.url)
      ) {
        continue;
      }
      seen.add(repository.url);
      recents.push({
        kind: "repository",
        url: repository.url,
        displayName: path.posix.basename(repository.url, ".git"),
      });
      if (recents.length === 8) {
        break;
      }
      continue;
    }
    const projectId = normalizeOptionalString(entry.projectId);
    const explicitProject = projectId ? projectsById.get(projectId) : undefined;
    const worktreeRoot = normalizeOptionalString(entry.worktree?.repoRoot);
    const spawnedCwd = normalizeOptionalString(entry.spawnedCwd);
    const execCwd = normalizeOptionalString(entry.execCwd);
    const folder = worktreeRoot ?? spawnedCwd ?? execCwd;
    let project = explicitProject;
    if (!project && folder) {
      const indexed = (pathProjects ??= indexPathProjects(projects));
      const workspace = indexed.byAgent.get(owner.agentId);
      project = workspace?.repoRoot === folder ? workspace : indexed.byPath.get(folder);
    }
    const key = project
      ? `project:${project.id}`
      : folder
        ? `folder:${normalizeOptionalString(entry.execNode) ?? ""}\0${folder}`
        : undefined;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    recents.push(
      project
        ? { kind: "project", projectId: project.id, displayName: project.displayName }
        : {
            kind: "folder",
            folder: folder!,
            displayName: folderDisplayName(folder!),
            ...(normalizeOptionalString(entry.execNode)
              ? { execNode: normalizeOptionalString(entry.execNode) }
              : {}),
          },
    );
    if (recents.length === 8) {
      break;
    }
  }
  return recents;
}
