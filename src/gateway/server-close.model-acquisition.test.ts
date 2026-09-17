import { getEventListeners } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { getPreparedModelCatalogWorkerPoolSnapshot } from "../agents/prepared-model-catalog-worker.js";
import { registerPreparedModelRuntimePublicationListener } from "../agents/prepared-model-runtime.js";
import { registerPreparedModelRuntimeClose } from "../agents/prepared-model-runtime.lifecycle.js";
import { getPreparedModelRuntimeStartupStatus } from "../agents/prepared-model-runtime.startup-status.js";
import { GATEWAY_SHUTDOWN_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { publishConfiguredModelRuntimeSnapshots } from "./server-startup-model-runtime.js";

it.each(["static catalog", "synthetic auth"] as const)(
  "Gateway shutdown cancels and joins degraded %s acquisition",
  async (phase) => {
    const fixture = await createGatewayMetadataCloseFixture("degraded-model-close");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const closingEntered = createDeferredCore();
    const workers: Worker[] = [];
    const timers = new Set<ReturnType<typeof setInterval>>();
    let acquisitionSignal: AbortSignal | undefined;
    let acquisitions = 0;
    let joined = false;
    let completePublications = 0;
    const bridgeKey = `__degraded_model_close_${path.basename(fixture.state.root)}`;
    const acquire = async (signal: AbortSignal | undefined) => {
      if (++acquisitions !== 2) {
        return;
      }
      acquisitionSignal = signal;
      const worker = new Worker("setInterval(() => {}, 1000)", { eval: true });
      workers.push(worker);
      const timer = setInterval(() => {}, 1000);
      timers.add(timer);
      const cancel = () => release.resolve();
      signal?.addEventListener("abort", cancel, { once: true });
      entered.resolve();
      try {
        await release.promise;
      } finally {
        signal?.removeEventListener("abort", cancel);
        clearInterval(timer);
        timers.delete(timer);
        await worker.terminate();
        joined = true;
      }
      // A cooperative hook may return after abort; the host must still reject its stale facts.
    };
    Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: acquire });
    const provider = fixture.pluginId;
    await fs.writeFile(
      path.join(fixture.rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: provider,
        providers: [provider],
        providerCatalogEntry: "./catalog.cjs",
        configSchema: { type: "object", properties: {} },
      }),
    );
    await fs.writeFile(
      path.join(fixture.rootDir, "catalog.cjs"),
      `module.exports = { id: ${JSON.stringify(provider)}, label: "Acquisition fixture", auth: [],
        staticCatalog: { async run(ctx) {
          ${phase === "static catalog" ? `await globalThis[${JSON.stringify(bridgeKey)}](ctx.signal);` : ""}
          return { provider: { api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
            models: [{ id: "model", name: "Fixture", reasoning: false, input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] } };
        } },
        ${phase === "synthetic auth" ? `async prepareSyntheticAuth(ctx) { await globalThis[${JSON.stringify(bridgeKey)}](ctx.signal); return { apiKey: "synthetic-fixture-key" }; },` : ""}
      };`,
    );
    fixture.config.agents = {
      defaults: { workspace: fixture.state.workspaceDir, model: `${provider}/model` },
      entries: {
        main: { default: true, workspace: fixture.state.workspaceDir },
        late: { workspace: fixture.state.path("late-workspace") },
      },
    };
    const unsubscribe = registerPreparedModelRuntimePublicationListener(({ phase: event }) => {
      if (event === "published" && getPreparedModelRuntimeStartupStatus()?.degraded === false) {
        completePublications++;
      }
    });
    const unregisterClose = registerPreparedModelRuntimeClose(async () => {
      closingEntered.resolve();
    });
    let closing: Promise<void> | undefined;
    let publication: Promise<void> | undefined;
    try {
      const port = await fixture.reservePort();
      const server = await fixture.start(port);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      publication = publishConfiguredModelRuntimeSnapshots({ cfg: fixture.config });
      await Promise.race([
        entered.promise,
        publication.then(() => {
          throw new Error("Startup bypassed held provider acquisition");
        }),
      ]);
      await vi.advanceTimersByTimeAsync(120_000);
      await publication;
      expect(getPreparedModelRuntimeStartupStatus()).toMatchObject({
        degraded: true,
        pendingAgents: ["late"],
      });
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
      const startedAt = performance.now();
      closing = server.close({ reason: "degraded acquisition fixture" });
      await closingEntered.promise;
      await nextTurn();
      expect(acquisitionSignal?.aborted).toBe(true);
      await closing;
      expect(performance.now() - startedAt).toBeLessThan(GATEWAY_SHUTDOWN_TIMEOUT_MS);
      expect(joined).toBe(true);
      expect(timers.size).toBe(0);
      expect(workers.every((worker) => worker.threadId === -1)).toBe(true);
      expect(getEventListeners(acquisitionSignal!, "abort")).toHaveLength(0);
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        workers: 0,
        activeTasks: 0,
        pendingTasks: 0,
      });
      expect(completePublications).toBe(0);
      expect(getPreparedModelRuntimeStartupStatus()?.degraded).not.toBe(false);
      await expect(fetch(`http://127.0.0.1:${port}/readyz`)).rejects.toThrow();
    } finally {
      vi.useRealTimers();
      release.resolve();
      await Promise.allSettled([publication, closing]);
      await Promise.all(
        workers.filter((worker) => worker.threadId !== -1).map((worker) => worker.terminate()),
      );
      for (const timer of timers) clearInterval(timer);
      unregisterClose();
      unsubscribe();
      await fixture.cleanup();
      Reflect.deleteProperty(globalThis, bridgeKey);
    }
  },
);
