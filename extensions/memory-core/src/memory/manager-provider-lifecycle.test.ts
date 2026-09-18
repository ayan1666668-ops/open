// Memory Core tests cover manager provider lifecycle availability behavior.
import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { hashText } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory index", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { provider: providerFixture } = fixture;
  const {
    createConfig: createCfg,
    getFreshManager,
    getPersistentManager,
    requireManager,
    trackManager,
  } = fixture;

  it.each([false, true])(
    "drains startup transcript discovery before closing (scan failure: %s)",
    async (failScan) => {
      const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
      await fs.mkdir(sessionsDir, { recursive: true });
      const scanStarted = createDeferred<void>();
      const scanGate = createDeferred<void>();
      const scanFinished = createDeferred<void>();
      const realReaddir = fs.readdir;
      const readdirSpy = vi
        .spyOn(fs, "readdir")
        .mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
          if (path.resolve(String(args[0])) !== sessionsDir) {
            return await realReaddir(...args);
          }
          scanStarted.resolve();
          try {
            await scanGate.promise;
            if (failScan) {
              throw Object.assign(new Error("transcript scan failed"), { code: "EIO" });
            }
            return await realReaddir(...args);
          } finally {
            scanFinished.resolve();
          }
        });
      let closing: Promise<void> | undefined;
      try {
        const manager = await getPersistentManager(
          createCfg({
            provider: "none",
            sources: ["sessions"],
            rememberAcrossConversations: true,
          }),
        );
        await scanStarted.promise;
        let closed = false;
        closing = manager.close().then(() => {
          closed = true;
        });
        await yieldToEventLoop();
        expect(closed).toBe(false);
        scanGate.resolve();
        await closing;
        expect(closed).toBe(true);
      } finally {
        scanGate.resolve();
        await closing;
        await scanFinished.promise;
        await yieldToEventLoop();
        readdirSpy.mockRestore();
      }
    },
  );

  it("caches embedding probe readiness across transient status managers", async () => {
    const cfg = createCfg({});
    const first = requireManager(
      await getMemorySearchManager({ cfg, agentId: "main", purpose: "status" }),
    );
    trackManager(first);

    await expect(first.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });
    expect(providerFixture.embedBatchCalls).toBe(1);
    await first.close();

    const second = requireManager(
      await getMemorySearchManager({ cfg, agentId: "main", purpose: "status" }),
    );
    trackManager(second);

    const cachedBeforeProbe = second.getCachedEmbeddingAvailability?.();
    expect(cachedBeforeProbe?.ok).toBe(true);
    expect(cachedBeforeProbe?.checked).toBe(true);
    expect(cachedBeforeProbe?.cached).toBe(true);
    expect(cachedBeforeProbe?.checkedAtMs).toBeTypeOf("number");
    expect(cachedBeforeProbe?.cacheExpiresAtMs).toBeTypeOf("number");
    if (
      typeof cachedBeforeProbe?.checkedAtMs === "number" &&
      typeof cachedBeforeProbe.cacheExpiresAtMs === "number"
    ) {
      expect(cachedBeforeProbe.cacheExpiresAtMs - cachedBeforeProbe.checkedAtMs).toBe(30_000);
    }
    await expect(second.probeEmbeddingAvailability()).resolves.toStrictEqual({
      ok: true,
      checked: true,
      cached: true,
      checkedAtMs: cachedBeforeProbe?.checkedAtMs,
      cacheExpiresAtMs: cachedBeforeProbe?.cacheExpiresAtMs,
    });
    expect(providerFixture.embedBatchCalls).toBe(1);

    const cached = second.getCachedEmbeddingAvailability?.();
    expect((cached?.cacheExpiresAtMs ?? 0) - (cached?.checkedAtMs ?? 0)).toBe(30_000);
  });

  it("clears cached embedding probe readiness when local embeddings degrade", async () => {
    const cfg = createCfg({});
    const manager = await getPersistentManager(cfg);

    await expect(manager.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });
    expect(manager.getCachedEmbeddingAvailability()?.ok).toBe(true);
    (
      manager as unknown as {
        provider: {
          id: string;
          model: string;
          embed: (text: string) => Promise<number[]>;
          embedBatch: (texts: string[]) => Promise<number[][]>;
          close: () => Promise<void>;
        };
      }
    ).provider = {
      id: "local",
      model: "local-model",
      embed: async () => [1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
      close: async () => {},
    };

    (
      manager as unknown as {
        markLocalEmbeddingProviderDegraded: (err: unknown) => void;
      }
    ).markLocalEmbeddingProviderDegraded(providerFixture.createLocalWorkerExitError());

    expect(manager.getCachedEmbeddingAvailability()).toBeNull();
    await expect(manager.probeEmbeddingAvailability()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Local embeddings degraded"),
    });
  });

  it("waits for degraded provider shutdown before fallback initialization", async () => {
    const cfg = createCfg({ fallback: "fallback-provider" });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    let releaseProviderClose: () => void = () => {};
    providerFixture.providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });
    const fields = manager as unknown as {
      provider: {
        id: string;
        model: string;
        embed: (text: string) => Promise<number[]>;
        embedBatch: (texts: string[]) => Promise<number[][]>;
        close: () => Promise<void>;
      } | null;
      markLocalEmbeddingProviderDegraded: (err: unknown) => void;
      activateFallbackProvider: (reason: string) => Promise<boolean>;
      withTimeout: <T>(promise: Promise<T>, timeoutMs: number, message: string) => Promise<T>;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    fields.provider.id = "local";
    fields.markLocalEmbeddingProviderDegraded(providerFixture.createLocalWorkerExitError());
    await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(1));

    const callsBeforeFallback = providerFixture.providerCalls.length;
    const fallbackPromise = fields.activateFallbackProvider("local worker exited");
    try {
      await Promise.resolve();
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeFallback);
    } finally {
      releaseProviderClose();
      providerFixture.providerCloseGate = null;
      await fallbackPromise;
    }
    expect(
      providerFixture.providerCalls.slice(callsBeforeFallback).map((call) => call.provider),
    ).toEqual(["fallback-provider"]);
  });

  it("retries failed provider retirement before fallback initialization", async () => {
    const cfg = createCfg({ fallback: "fallback-provider" });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });
    providerFixture.providerCloseFailuresRemaining = 1;
    const fields = manager as unknown as {
      activateFallbackProvider: (reason: string) => Promise<boolean>;
    };
    const callsBeforeFallback = providerFixture.providerCalls.length;

    await expect(fields.activateFallbackProvider("provider failed")).rejects.toThrow(
      "provider close failed",
    );
    expect(providerFixture.providerCalls).toHaveLength(callsBeforeFallback);

    await expect(fields.activateFallbackProvider("provider failed")).resolves.toBe(true);
    expect(providerFixture.providerCloseCalls).toBe(2);
    expect(
      providerFixture.providerCalls.slice(callsBeforeFallback).map((call) => call.provider),
    ).toEqual(["fallback-provider"]);
  });

  it("waits for provider shutdown before retry initialization", async () => {
    const cfg = createCfg({ provider: "openai" });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    let releaseProviderClose: () => void = () => {};
    providerFixture.providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });
    (
      manager as unknown as {
        resetProviderInitializationForRetry: () => void;
      }
    ).resetProviderInitializationForRetry();
    await vi.waitFor(() => expect(providerFixture.providerCloseCalls).toBe(1));

    const callsBeforeProbe = providerFixture.providerCalls.length;
    const probePromise = manager.probeEmbeddingAvailability();
    try {
      await Promise.resolve();
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeProbe);
    } finally {
      releaseProviderClose();
      providerFixture.providerCloseGate = null;
      await probePromise;
    }
    expect(
      providerFixture.providerCalls.slice(callsBeforeProbe).map((call) => call.provider),
    ).toEqual(["openai"]);
  });

  it("waits for active provider shutdown before fallback initialization", async () => {
    const cfg = createCfg({
      provider: "openai",
      fallback: "fallback-provider",
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    let releaseProviderClose: () => void = () => {};
    providerFixture.providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });
    const fields = manager as unknown as {
      provider: {
        embed: (text: string) => Promise<number[]>;
        close: () => Promise<void>;
      } | null;
    };
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    const providerCloseStarted = createDeferred<void>();
    const closeProvider = fields.provider.close.bind(fields.provider);
    fields.provider.close = () => {
      const closing = closeProvider();
      providerCloseStarted.resolve();
      return closing;
    };
    fields.provider.embed = async () => {
      throw new Error("embedding provider failed");
    };

    const callsBeforeSearch = providerFixture.providerCalls.length;
    const searchPromise = manager.search("alpha");
    let concurrentSearch: ReturnType<typeof manager.search> = Promise.resolve([]);
    try {
      await Promise.race([providerCloseStarted.promise, searchPromise]);
      expect(providerFixture.providerCloseCalls).toBe(1);
      concurrentSearch = manager.search("zebra");
      let concurrentSettled = false;
      void concurrentSearch.then(
        () => {
          concurrentSettled = true;
        },
        () => {
          concurrentSettled = true;
        },
      );
      await Promise.resolve();
      expect(concurrentSettled).toBe(false);
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeSearch);
    } finally {
      releaseProviderClose();
      providerFixture.providerCloseGate = null;
      await Promise.allSettled([searchPromise, concurrentSearch]);
    }
    expect(
      providerFixture.providerCalls.slice(callsBeforeSearch).map((call) => call.provider),
    ).toEqual(["fallback-provider"]);
    await expect(concurrentSearch).resolves.toBeDefined();
  });

  it("leases the indexing provider generation through chunk publication", async () => {
    const manager = await getFreshManager(
      createCfg({
        provider: "openai",
        fallback: "fallback-provider",
        cacheEnabled: true,
      }),
      "cli",
    );
    trackManager(manager);
    const fields = manager as unknown as {
      provider: {
        id: string;
        model: string;
        embedBatch: (texts: string[]) => Promise<number[][]>;
      } | null;
      providerKey: string;
      computeProviderKey: () => string;
      ensureProviderInitialized: () => Promise<void>;
      markLocalEmbeddingProviderDegraded: (err: unknown) => void;
      activateFallbackProvider: (reason: string) => Promise<boolean>;
      withTimeout: <T>(promise: Promise<T>, timeoutMs: number, message: string) => Promise<T>;
      indexFile: (
        entry: {
          path: string;
          absPath: string;
          mtimeMs: number;
          size: number;
          hash: string;
          content: string;
        },
        options: { source: "memory"; content: string },
      ) => Promise<void>;
      ensureVectorReady: (dimensions?: number) => Promise<boolean>;
      db: {
        prepare: (sql: string) => {
          get: (
            ...params: unknown[]
          ) => { model?: string; provider?: string; provider_key?: string } | undefined;
        };
      };
    };
    await fields.ensureProviderInitialized();
    if (!fields.provider) {
      throw new Error("Expected a test embedding provider");
    }
    const indexedProvider = fields.provider;
    indexedProvider.id = "local";
    fields.providerKey = fields.computeProviderKey();
    const indexedProviderKey = fields.providerKey;
    const firstContent = "# Log\nFirst memory line indexed during provider fallback.";
    const secondContent = "# Log\nSecond memory line indexed during provider fallback.";
    await fs.writeFile(path.join(fixture.paths.memory, "generation-race-first.md"), firstContent);
    await fs.writeFile(path.join(fixture.paths.memory, "generation-race-second.md"), secondContent);

    let releaseFirstEmbedding: () => void = () => {};
    let releaseSecondEmbedding: () => void = () => {};
    let markFirstEmbeddingStarted: () => void = () => {};
    let markSecondEmbeddingStarted: () => void = () => {};
    const firstEmbeddingGate = new Promise<void>((resolve) => {
      releaseFirstEmbedding = resolve;
    });
    const secondEmbeddingGate = new Promise<void>((resolve) => {
      releaseSecondEmbedding = resolve;
    });
    const firstEmbeddingStarted = new Promise<void>((resolve) => {
      markFirstEmbeddingStarted = resolve;
    });
    const secondEmbeddingStarted = new Promise<void>((resolve) => {
      markSecondEmbeddingStarted = resolve;
    });
    // Temporary phase attribution for the hosted readiness failure; remove before landing.
    const startedAt = performance.now();
    const wallStartedAt = Date.now();
    const marks: Record<string, { elapsedMs: number; wallMs: number }> = {};
    const mark = (phase: string) => {
      marks[phase] = {
        elapsedMs: performance.now() - startedAt,
        wallMs: Date.now() - wallStartedAt,
      };
    };
    const workerRecords: Array<Record<string, string | number>> = [];
    let droppedWorkerRecords = 0;
    const workerChannel = channel("openclaw.worker.task");
    const observeWorker = (value: unknown) => {
      if (!value || typeof value !== "object" || !("worker" in value)) {
        return;
      }
      if (
        typeof value.worker !== "string" ||
        !["manager-index.worker.ts", "manager-index.worker.js", "memory-index.worker.js"].includes(
          value.worker,
        )
      ) {
        return;
      }
      if (workerRecords.length === 8) {
        droppedWorkerRecords += 1;
        return;
      }
      const record: Record<string, string | number> = {
        elapsedMs: performance.now() - startedAt,
        wallMs: Date.now() - wallStartedAt,
      };
      for (const key of [
        "queueMs",
        "preparationMs",
        "runMs",
        "pendingTasks",
        "activeTasks",
        "workers",
      ]) {
        const field = Reflect.get(value, key);
        if (typeof field === "number" && Number.isFinite(field)) {
          record[key] = field;
        }
      }
      if ("outcome" in value && (value.outcome === "ok" || value.outcome === "failed")) {
        record.outcome = value.outcome;
      }
      workerRecords.push(record);
    };
    workerChannel.subscribe(observeWorker);
    let failureSnapshot:
      | {
          marks: typeof marks;
          workerRecordCount: number;
          droppedWorkerRecords: number;
          publicationCalls: number;
        }
      | undefined;
    indexedProvider.embedBatch = async (texts) => {
      if (texts.some((text) => text.includes("First"))) {
        mark("first-embedding");
        markFirstEmbeddingStarted();
        await firstEmbeddingGate;
      } else {
        mark("second-embedding");
        markSecondEmbeddingStarted();
        await secondEmbeddingGate;
      }
      return texts.map(() => [1, 0, 0, 0]);
    };
    let releasePublication: () => void = () => {};
    let markPublicationStarted: () => void = () => {};
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const publicationStarted = new Promise<void>((resolve) => {
      markPublicationStarted = resolve;
    });
    const ensureVectorReady = fields.ensureVectorReady.bind(manager);
    let publicationCalls = 0;
    fields.ensureVectorReady = async (dimensions) => {
      publicationCalls += 1;
      if (publicationCalls === 1) {
        return await ensureVectorReady(dimensions);
      }
      mark("publication");
      markPublicationStarted();
      await publicationGate;
      return await ensureVectorReady(dimensions);
    };

    const callsBeforeFallback = providerFixture.providerCalls.length;
    mark("first-index");
    const firstIndexPromise = fields.indexFile(
      {
        path: "memory/generation-race-first.md",
        absPath: path.join(fixture.paths.memory, "generation-race-first.md"),
        mtimeMs: Date.now(),
        size: Buffer.byteLength(firstContent),
        hash: hashText(firstContent),
        content: firstContent,
      },
      { source: "memory", content: firstContent },
    );
    mark("second-index");
    const secondIndexPromise = fields.indexFile(
      {
        path: "memory/generation-race-second.md",
        absPath: path.join(fixture.paths.memory, "generation-race-second.md"),
        mtimeMs: Date.now(),
        size: Buffer.byteLength(secondContent),
        hash: hashText(secondContent),
        content: secondContent,
      },
      { source: "memory", content: secondContent },
    );
    let fallbackPromise: Promise<boolean> | null = null;
    try {
      mark("wait-embeddings");
      await fields.withTimeout(
        Promise.all([firstEmbeddingStarted, secondEmbeddingStarted]),
        5_000,
        "concurrent embeddings did not start",
      );
      fields.markLocalEmbeddingProviderDegraded(providerFixture.createLocalWorkerExitError());
      await vi.waitFor(() => expect(fields.provider).toBeNull());
      fallbackPromise = fields.activateFallbackProvider("local worker exited");
      releaseFirstEmbedding();
      await firstIndexPromise;
      expect(providerFixture.providerCloseCalls).toBe(0);
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeFallback);

      releaseSecondEmbedding();
      mark("wait-publication");
      await fields.withTimeout(publicationStarted, 5_000, "publication did not start");
      expect(providerFixture.providerCloseCalls).toBe(0);
      expect(providerFixture.providerCalls).toHaveLength(callsBeforeFallback);

      releasePublication();
      await secondIndexPromise;
      await expect(fallbackPromise).resolves.toBe(true);
    } catch (error) {
      mark("failure");
      failureSnapshot = {
        marks: { ...marks },
        workerRecordCount: workerRecords.length,
        droppedWorkerRecords,
        publicationCalls,
      };
      throw error;
    } finally {
      releaseFirstEmbedding();
      releaseSecondEmbedding();
      releasePublication();
      const settlements = await Promise.allSettled([
        firstIndexPromise,
        secondIndexPromise,
        ...(fallbackPromise ? [fallbackPromise] : []),
      ]);
      workerChannel.unsubscribe(observeWorker);
      if (failureSnapshot) {
        const summary = {
          atFailure: failureSnapshot,
          afterSettlement: { marks, droppedWorkerRecords, publicationCalls },
          settlements: settlements.map((result) => result.status),
        };
        const report = JSON.stringify({ ...summary, workerRecords });
        console.error(
          "[cpu-provider-readiness]",
          report.length <= 3_900
            ? report
            : JSON.stringify({ ...summary, workerRecordsOmitted: workerRecords.length }),
        );
      }
    }

    expect(
      providerFixture.providerCalls.slice(callsBeforeFallback).map((call) => call.provider),
    ).toEqual(["fallback-provider"]);
    expect(
      fields.db
        .prepare("SELECT model FROM memory_index_chunks WHERE path = ?")
        .get("memory/generation-race-second.md")?.model,
    ).toBe(indexedProvider.model);
    expect(
      fields.db
        .prepare("SELECT provider, model, provider_key FROM memory_embedding_cache LIMIT 1")
        .get(),
    ).toEqual({
      provider: indexedProvider.id,
      model: indexedProvider.model,
      provider_key: indexedProviderKey,
    });
  });
});
