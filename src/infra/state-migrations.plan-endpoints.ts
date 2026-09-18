import path from "node:path";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  listConfiguredSessionStoreAgentIds,
  resolveAllAgentSessionStoreCandidateTargetsSync,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectRelevantDoctorPluginIds,
  type PluginDoctorStateMigrationInventory,
} from "../plugins/doctor-contract-registry.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { isPathInside } from "./path-guards.js";
import type { PreparedLegacyStateMigrationStep } from "./state-migrations.plan.js";
import type { LegacyStateMigrationEndpoint } from "./state-migrations.types.js";

export function uniqueMigrationEndpoints(
  endpoints: readonly LegacyStateMigrationEndpoint[],
): LegacyStateMigrationEndpoint[] {
  const seen = new Set<string>();
  return endpoints.filter((endpoint) => {
    const key =
      endpoint.kind === "owner" ? `owner\0${endpoint.id}` : `${endpoint.kind}\0${endpoint.path}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function listMigrationEndpointsOutsideRoot(
  endpoints: readonly LegacyStateMigrationEndpoint[],
  root: string,
): LegacyStateMigrationEndpoint[] {
  const resolvedRoot = path.resolve(root);
  const identityRoot = resolveIdentityPathViaExistingAncestorSync(resolvedRoot);
  return uniqueMigrationEndpoints(
    endpoints.filter((endpoint) => {
      if (endpoint.kind === "owner") {
        return false;
      }
      const resolvedPath = path.resolve(endpoint.path);
      const identityPath = resolveIdentityPathViaExistingAncestorSync(resolvedPath);
      return (
        (resolvedPath !== resolvedRoot && !isPathInside(resolvedRoot, resolvedPath)) ||
        (identityPath !== identityRoot && !isPathInside(identityRoot, identityPath))
      );
    }),
  );
}

export function createSessionTargetOutsideSnapshotRefusal(
  endpoints: readonly LegacyStateMigrationEndpoint[],
): NonNullable<PreparedLegacyStateMigrationStep["refusal"]> {
  return {
    code: "session-target-outside-snapshot",
    message: `Configured session migration endpoints are outside the copied state root and require a separately bound snapshot: ${endpoints
      .map((endpoint) => (endpoint.kind === "owner" ? endpoint.id : path.resolve(endpoint.path)))
      .toSorted()
      .join(", ")}`,
  };
}

export function createDeferredPluginSessionStoreRefusal(
  endpoints: readonly LegacyStateMigrationEndpoint[],
): PreparedLegacyStateMigrationStep["refusal"] | undefined {
  return endpoints.length > 0
    ? {
        code: "plugin-planning-deferred",
        message: "Plugin session migrations will be checked with the update.",
      }
    : undefined;
}

export function createDeferredPluginSessionStoreEndpoints(
  config: OpenClawConfig,
  inventory: PluginDoctorStateMigrationInventory,
): LegacyStateMigrationEndpoint[] {
  const knownPluginIds = new Set(inventory.knownPluginIds);
  const sessionStoreOwnerPluginIds = new Set(inventory.sessionStoreOwnerPluginIds);
  return collectRelevantDoctorPluginIds(config)
    .filter((pluginId) => !knownPluginIds.has(pluginId) || sessionStoreOwnerPluginIds.has(pluginId))
    .map((pluginId) => ({
      kind: "owner",
      id: `plugin:${pluginId}:session-store`,
    }));
}

export function createPluginMigrationPreparationRefusal(params: {
  inventory: PluginDoctorStateMigrationInventory;
  deferredSessionStoreEndpoints: readonly LegacyStateMigrationEndpoint[];
}): PreparedLegacyStateMigrationStep["refusal"] | undefined {
  if (
    params.deferredSessionStoreEndpoints.length === 0 &&
    params.inventory.unresolvedPluginIds.length === 0
  ) {
    return undefined;
  }
  return {
    code: "plugin-planning-deferred",
    message:
      "Plugin migration preparation requires plugin and session-store descriptors for the new version.",
  };
}

export function resolveConfiguredSessionStoreEndpoints(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): LegacyStateMigrationEndpoint[] {
  return uniqueMigrationEndpoints(
    [
      ...new Set([
        ...listConfiguredSessionStoreAgentIds(config),
        resolveSessionStoreCompatibilityAgentId(config),
      ]),
    ].map((agentId) => ({
      kind: "path" as const,
      path: resolveSessionStorePathCore(config.session?.store, { agentId, env }),
    })),
  );
}

export function bindAgentDatabaseTargetsToStateRoot(
  targets: readonly { agentId: string; path: string }[],
  stateDir: string,
): {
  targets: Array<{ agentId: string; path: string }>;
  outsideEndpoints: LegacyStateMigrationEndpoint[];
  refusal?: PreparedLegacyStateMigrationStep["refusal"];
} {
  const outsideEndpoints = listMigrationEndpointsOutsideRoot(
    targets.map(({ path: databasePath }) => ({
      kind: "sqlite" as const,
      path: databasePath,
    })),
    stateDir,
  );
  const outsidePaths = new Set(
    outsideEndpoints.flatMap((endpoint) =>
      endpoint.kind === "owner" ? [] : [path.resolve(endpoint.path)],
    ),
  );
  if (outsidePaths.size === 0) {
    return { targets: [...targets], outsideEndpoints: [] };
  }
  return {
    targets: targets.filter((target) => !outsidePaths.has(path.resolve(target.path))),
    outsideEndpoints,
    refusal: createSessionTargetOutsideSnapshotRefusal(outsideEndpoints),
  };
}

export function createConfigMigrationSources(
  configPath: string,
  includedPaths: readonly string[],
): LegacyStateMigrationEndpoint[] {
  return uniqueMigrationEndpoints(
    [configPath, ...includedPaths].map((inputPath) => ({
      kind: "path" as const,
      path: path.resolve(inputPath),
    })),
  );
}

export function inspectOrphanSessionStoreEndpoints(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  pluginSessionStoreAgentIds: readonly string[];
  registeredDatabases?: readonly { agentId: string; path: string }[];
}): { endpoints: LegacyStateMigrationEndpoint[]; warnings: string[] } {
  try {
    const paths = resolveAllAgentSessionStoreCandidateTargetsSync(params.config, {
      env: params.env,
      registeredDatabases: params.registeredDatabases,
    }).map((target) => target.storePath);
    for (const agentId of params.pluginSessionStoreAgentIds) {
      paths.push(
        resolveSessionStorePathCore(params.config.session?.store, {
          agentId,
          env: params.env,
        }),
      );
    }
    return {
      endpoints: uniqueMigrationEndpoints(
        paths
          .filter((storePath) => !storePath.endsWith(".sqlite"))
          .map((storePath) => ({ kind: "path" as const, path: storePath })),
      ),
      warnings: [],
    };
  } catch (error) {
    return {
      endpoints: [{ kind: "owner", id: "core:session-store-targets" }],
      warnings: [`Could not inspect session migration targets: ${String(error)}`],
    };
  }
}
