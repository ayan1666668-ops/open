import { isDeepStrictEqual } from "node:util";
import { onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { getActivePluginRegistryVersion } from "../../plugins/runtime.js";
import { getPluginRegistryForContext } from "../../plugins/runtime/gateway-request-scope.js";
import type { PreparedAgentCredentialModes } from "../agent-auth-credential-modes.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agent-scope.js";
import {
  registerRuntimeAuthProfileStoreMutationListener,
  setRuntimeAuthProfileStoreSnapshot,
} from "../auth-profiles/runtime-snapshots.js";
import {
  getRuntimeAuthProfileStoreSnapshot,
  clearRuntimeAuthProfileStoreSnapshot,
} from "../auth-profiles/store.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import type { ModelCatalogSnapshot } from "../model-catalog.types.js";
import * as catalogPublication from "../prepared-model-catalog.js";
import {
  setPreparedModelFullCatalogAuth,
  setPreparedModelRuntimeAuthStore,
} from "../prepared-model-runtime-auth.js";
import { preparedModelRuntimeConfigsMatch } from "../prepared-model-runtime.owner.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.types.js";
import { AuthStorage, ModelRegistry } from "../sessions/index.js";

/** A published catalog and its auth are one test-owned lifecycle generation. */
export function createSessionModelCatalogFixture() {
  const owners = new Map<string, PreparedModelRuntimeSnapshot>();
  let installed = false;
  const authBefore = new Map<string, ReturnType<typeof getRuntimeAuthProfileStoreSnapshot>>();
  function publish(
    params: {
      config: OpenClawConfig;
      agentId: string;
      catalog: ModelCatalogSnapshot;
      runtimeAuthModes?: PreparedAgentCredentialModes;
      plugins?: readonly PluginManifestRecord[];
    } & (
      | { profiles: AuthProfileStore["profiles"]; authStore?: never }
      | { authStore: AuthProfileStore; profiles?: never }
    ),
  ) {
    if (!installed) {
      installed = true;
      const read = vi
        .spyOn(catalogPublication, "getPublishedPreparedModelCatalogOwnerSnapshot")
        .mockImplementation((request = {}) => {
          const owner = owners.get(request.agentId ?? "main");
          return owner &&
            request.config &&
            preparedModelRuntimeConfigsMatch(owner.config, request.config) &&
            (!request.workspaceDir || owner.workspaceDir === request.workspaceDir)
            ? owner
            : undefined;
        });
      const prepare = vi
        .spyOn(catalogPublication, "preparePublishedModelCatalogOwnerSnapshot")
        .mockImplementation(async (request = {}) =>
          catalogPublication.getPublishedPreparedModelCatalogOwnerSnapshot(request),
        );
      onTestFinished(() => {
        owners.clear();
        for (const [agentDir, store] of authBefore) {
          if (store) {
            setRuntimeAuthProfileStoreSnapshot(store, agentDir);
          } else {
            clearRuntimeAuthProfileStoreSnapshot(agentDir);
          }
        }
        authBefore.clear();
        read.mockRestore();
        prepare.mockRestore();
        installed = false;
      });
    }
    const { config, agentId, catalog } = params;
    const configured = structuredClone(config);
    const agentDir = resolveAgentDir(config, agentId);
    const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
    const registry = getPluginRegistryForContext();
    const registryVersion = getActivePluginRegistryVersion();
    const authStore: AuthProfileStore = params.authStore ?? {
      version: 1,
      profiles: params.profiles,
    };
    if (!authBefore.has(agentDir)) {
      authBefore.set(agentDir, getRuntimeAuthProfileStoreSnapshot(agentDir));
    }
    setRuntimeAuthProfileStoreSnapshot(authStore, agentDir);
    let authCurrent = true;
    onTestFinished(
      registerRuntimeAuthProfileStoreMutationListener((event) => {
        if (event.affectsInheritedStores || event.agentDir === agentDir) {
          authCurrent = false;
        }
      }),
    );
    const owner: PreparedModelRuntimeSnapshot = {
      config,
      observationConfig: config,
      agentId,
      agentDir,
      workspaceDir,
      catalogOwner: { agentId, workspaceDir },
      activeProjectKeys: [],
      authModes: params.runtimeAuthModes ?? {},
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [...(params.plugins ?? [])],
      }),
      ...(registry ? { pluginRegistry: registry } : {}),
      isCurrent: () =>
        owners.get(agentId) === owner &&
        isDeepStrictEqual(config, configured) &&
        getPluginRegistryForContext() === registry &&
        getActivePluginRegistryVersion() === registryVersion &&
        authCurrent,
      allowGatewaySubagentBinding: true,
      modelCatalog: catalog,
      readFullModelCatalog: () => catalog,
      configuredRuntimeModels: [],
      findConfiguredRuntimeModel: () => undefined,
      inlineProviderModels: [],
      createStores() {
        const authStorage = AuthStorage.inMemory({});
        return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
      },
    };
    setPreparedModelRuntimeAuthStore(owner, authStore);
    setPreparedModelFullCatalogAuth(catalog, {
      authStore,
      authModes: owner.authModes,
      providerAuthLabels: new Map(),
    });
    owners.set(agentId, owner);
    return { ...catalog, agentId, agentDir, workspaceDir, config, catalogComplete: true };
  }
  return { publish };
}
