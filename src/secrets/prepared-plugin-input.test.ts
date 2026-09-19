import { afterEach, describe, expect, it } from "vitest";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
} from "../agents/auth-profiles/runtime-snapshots.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getPreparedPluginSecretInput } from "./prepared-plugin-input.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshotState,
  type PreparedSecretsRuntimeSnapshot,
} from "./runtime-state.js";

const pluginId = "prepared-secret-owner";
const secretRef = { source: "env", provider: "default", id: "PREPARED_PLUGIN_KEY" } as const;

function configWithSecret(value: unknown): OpenClawConfig {
  return {
    plugins: {
      entries: {
        [pluginId]: {
          enabled: true,
          config: { apiKey: value },
        },
      },
    },
  } as OpenClawConfig;
}

function snapshot(value: string): PreparedSecretsRuntimeSnapshot {
  const sourceConfig = configWithSecret(secretRef);
  const config = configWithSecret(value);
  return {
    sourceConfig,
    config,
    authStores: [],
    authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
    authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
    warnings: [],
    webTools: {
      search: { providerSource: "none", diagnostics: [] },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    },
  };
}

function activate(value: string): void {
  activateSecretsRuntimeSnapshotState({
    snapshot: snapshot(value),
    refreshContext: {
      env: {},
      explicitAgentDirs: null,
      includeConfigRefs: true,
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    },
    refreshHandler: null,
  });
}

function createOwnedInstance(): PluginInstance {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: pluginId,
    source: "/synthetic/prepared-secret-owner.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  registry.plugins.push(record);
  return new PluginInstance(pluginId, { record, registry });
}

afterEach(() => {
  clearSecretsRuntimeSnapshotState();
});

describe("prepared plugin secret input authority", () => {
  it("allows an admitted instance to read the prepared credential", async () => {
    activate("old-key");
    const instance = createOwnedInstance();
    try {
      expect(instance.run(() => getPreparedPluginSecretInput(pluginId, "apiKey"))).toMatchObject({
        value: "old-key",
      });
    } finally {
      await instance.dispose();
    }
  });

  it("rejects a retired callback while a replacement instance reads its credential", async () => {
    activate("old-key");
    const instance = createOwnedInstance();
    let replacement: PluginInstance | undefined;
    const started = createDeferredCore<void>();
    const release = createDeferredCore<void>();
    try {
      const delayed = instance.run(async () => {
        started.resolve();
        await release.promise;
        return getPreparedPluginSecretInput(pluginId, "apiKey");
      });
      await started.promise;

      const disposal = instance.dispose();
      replacement = createOwnedInstance();
      activate("replacement-key");
      expect(replacement.run(() => getPreparedPluginSecretInput(pluginId, "apiKey"))).toMatchObject(
        { value: "replacement-key" },
      );
      release.resolve();

      const stale = await delayed;
      expect(stale.value).toBeUndefined();
      await expect(disposal).resolves.toEqual({ errors: [] });
    } finally {
      release.resolve();
      await instance.dispose();
      await replacement?.dispose();
    }
  });
});
