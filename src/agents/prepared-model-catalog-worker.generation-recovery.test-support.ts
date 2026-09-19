import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadGatewayModelCatalogSnapshot } from "../gateway/server-model-catalog.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  PLUGIN_ID,
  PROVIDER_ID,
  writeFixturePlugin,
} from "./prepared-model-catalog-worker.test-support.js";
import { loadPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  loadPublishedGatewayReplyDispatchRuntime,
  publishPreparedModelRuntimeSnapshot,
  type PreparedModelRuntimeInput,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";

type GenerationRecoveryFixture = {
  root: string;
  agentDir: string;
  workspaceDir: string;
  marker: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
};

export async function expectPublishedOwnerRecoveryAfterGenerationMismatch(
  fixture: GenerationRecoveryFixture,
  armGenerationMismatch: () => void,
): Promise<void> {
  for (const [key, value] of Object.entries(fixture.env)) {
    if (value !== undefined) {
      vi.stubEnv(key, value);
    }
  }
  const healthyAgentDir = path.join(
    path.dirname(path.dirname(fixture.agentDir)),
    "healthy",
    "agent",
  );
  const healthyWorkspaceDir = path.join(fixture.root, "healthy-workspace");
  fs.mkdirSync(healthyAgentDir, { recursive: true });
  fs.mkdirSync(healthyWorkspaceDir, { recursive: true });
  const config = {
    ...fixture.config,
    agents: {
      ...fixture.config.agents,
      list: [
        {
          id: "main",
          default: true,
          agentDir: fixture.agentDir,
          workspace: fixture.workspaceDir,
        },
        {
          id: "healthy",
          agentDir: healthyAgentDir,
          workspace: healthyWorkspaceDir,
        },
      ],
    },
  } satisfies OpenClawConfig;
  const inputs = [
    {
      agentId: "main",
      agentDir: fixture.agentDir,
      inheritedAuthDir: fixture.agentDir,
      workspaceDir: fixture.workspaceDir,
      config,
      allowGatewaySubagentBinding: true,
    },
    {
      agentId: "healthy",
      agentDir: healthyAgentDir,
      inheritedAuthDir: healthyAgentDir,
      workspaceDir: healthyWorkspaceDir,
      config,
      allowGatewaySubagentBinding: true,
    },
  ] satisfies PreparedModelRuntimeInput[];
  const published: PreparedModelRuntimeSnapshot[] = [];
  for (const input of inputs) {
    published.push(
      await publishPreparedModelRuntimeSnapshot(input, {
        provenance: "configured",
        catalogMode: "static",
      }),
    );
  }

  writeFixturePlugin({
    root: fixture.root,
    spinMs: 0,
    pluginVersion: "v2",
  });
  fixture.config.plugins!.entries![PLUGIN_ID] = { enabled: true, config: {} };

  const loadCatalog = async (agentId: string, agentDir: string, workspaceDir: string) =>
    await loadGatewayModelCatalogSnapshot({
      agentId,
      agentDir,
      workspaceDir,
      getConfig: () => config,
      readOnly: false,
      refreshFullCatalog: true,
    });
  const loadMainCatalog = async () =>
    await loadCatalog("main", fixture.agentDir, fixture.workspaceDir);

  const workerStopped = createDeferredCore();
  const releasePoolRecovery = createDeferredCore();
  let restoreTermination: (() => void) | undefined;
  const workerChannel = channel("worker_threads");
  const holdSharedPoolRecovery = (message: unknown) => {
    if (
      restoreTermination ||
      typeof message !== "object" ||
      message === null ||
      !("worker" in message) ||
      !(message.worker instanceof Worker)
    ) {
      return;
    }
    const worker = message.worker;
    const terminate = worker.terminate.bind(worker);
    const spy = vi.spyOn(worker, "terminate").mockImplementation(async () => {
      const code = await terminate();
      workerStopped.resolve();
      await releasePoolRecovery.promise;
      return code;
    });
    restoreTermination = () => spy.mockRestore();
  };
  workerChannel.subscribe(holdSharedPoolRecovery);

  let failedOwner: ReturnType<typeof loadMainCatalog> | undefined;
  let failedAuthOwner: ReturnType<typeof loadPreparedModelRuntimeAuth> | undefined;
  let healthyWaiter: ReturnType<typeof loadCatalog> | undefined;
  try {
    armGenerationMismatch();
    failedOwner = loadMainCatalog();
    void failedOwner.catch(() => undefined);
    // Public catalog reads may return the saved inventory after their bounded foreground wait.
    // Observe native retirement directly so a cold worker cannot make that expected fallback race
    // look like failed recovery coverage.
    await workerStopped.promise;
    const failedCatalog = await failedOwner;
    expect(failedCatalog.authoritative).toBe(false);
    expect(failedCatalog.entries).not.toContainEqual(
      expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v2" }),
    );

    failedAuthOwner = loadPreparedModelRuntimeAuth(published[0]!, {
      providerIds: [PROVIDER_ID],
    });
    void failedAuthOwner.catch(() => undefined);
    let healthySettled = false;
    healthyWaiter = loadCatalog("healthy", healthyAgentDir, healthyWorkspaceDir).finally(() => {
      healthySettled = true;
    });
    void healthyWaiter.catch(() => undefined);
    await nextTurn();
    expect(healthySettled).toBe(false);

    releasePoolRecovery.resolve();
    await expect(failedAuthOwner).rejects.toBeInstanceOf(Error);
    const recovered = await healthyWaiter;
    await vi.waitFor(() => {
      expect(getPreparedModelRuntimeSnapshot(inputs[0]!)).not.toBe(published[0]);
    });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" }),
    ).resolves.toBeUndefined();
    expect(recovered.entries).toContainEqual(
      expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v2" }),
    );
  } finally {
    releasePoolRecovery.resolve();
    await Promise.allSettled([failedOwner, failedAuthOwner, healthyWaiter]);
    restoreTermination?.();
    workerChannel.unsubscribe(holdSharedPoolRecovery);
  }
}
