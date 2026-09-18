// Config reload observation tests: the reloader publishes the source config each
// completed transaction read, which runtime-config health compares with the live runtime.
import chokidar from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildRuntimeConfigHealth } from "../commands/health-runtime-config.js";
import type { ConfigFileSnapshot, ConfigWriteNotification } from "../config/config.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { getConfigReloadObservation } from "./config-reload-observed.js";
import { startGatewayConfigReloader } from "./config-reload.js";

const configAuditMocks = vi.hoisted(() => ({
  append: vi.fn(),
  readSnapshot: vi.fn(),
  readLatestSnapshot: vi.fn(),
  upsertSnapshot: vi.fn(),
}));

vi.mock("../config/io.audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.audit.js")>()),
  appendConfigAuditRecordSync: configAuditMocks.append,
}));

vi.mock("../config/config-journal-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config-journal-snapshot.js")>()),
  readConfigSnapshotAuditRecord: configAuditMocks.readSnapshot,
  readLatestConfigSnapshotAuditRecord: configAuditMocks.readLatestSnapshot,
  upsertConfigSnapshotAuditRecord: configAuditMocks.upsertSnapshot,
}));

const DRIFT_MESSAGE =
  "Live gateway runtime config differs from the latest completed reload observation for model/provider/auth paths; restart is required or pending.";

type WatcherHandler = (value?: unknown) => void;

function makeSnapshot(partial: Partial<ConfigFileSnapshot> = {}): ConfigFileSnapshot {
  const config = partial.config ?? {};
  const sourceConfig = (partial.sourceConfig ?? config) as ConfigFileSnapshot["sourceConfig"];
  return {
    path: "/tmp/openclaw.json",
    includedPaths: [],
    exists: true,
    raw: JSON.stringify(sourceConfig),
    parsed: sourceConfig,
    sourceConfig,
    resolved: sourceConfig,
    valid: true,
    runtimeConfig: partial.runtimeConfig ?? config,
    config,
    issues: [],
    warnings: [],
    legacyIssues: [],
    ...partial,
  };
}

function createReloaderHarness(
  readSnapshot: () => Promise<ConfigFileSnapshot>,
  initialConfig: OpenClawConfig,
) {
  const handlers = new Map<string, WatcherHandler[]>();
  const watcher = {
    options: { usePolling: false },
    on(event: string, handler: WatcherHandler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return this;
    },
    emit(event: string) {
      for (const handler of handlers.get(event) ?? []) {
        handler(event === "change" ? "/tmp/openclaw.json" : undefined);
      }
    },
    close: vi.fn(async () => {}),
  };
  vi.spyOn(chokidar, "watch").mockReturnValue(watcher as unknown as never);
  let writeListener: ((event: ConfigWriteNotification) => void) | null = null;
  const onRestart = vi.fn();
  const reloader = startGatewayConfigReloader({
    testDebounceMs: 0,
    initialConfig,
    initialSnapshotRawHash: hashConfigRaw(JSON.stringify(initialConfig)),
    initialAuthoredConfig: initialConfig,
    initialSnapshotValid: true,
    initialSnapshotIssues: [],
    readSnapshot,
    initialPluginInstallRecords: {},
    readPluginInstallRecords: async () => ({}),
    subscribeToWrites: (listener) => {
      writeListener = listener;
      return () => {
        writeListener = null;
      };
    },
    onNoopConfigCommit: async () => {},
    onHotReload: async () => "applied" as const,
    onRestart,
    log: createInfoWarnErrorLogger(),
    watchPath: "/tmp/openclaw.json",
  });
  return {
    watcher,
    reloader,
    onRestart,
    emitWrite: (event: ConfigWriteNotification) => writeListener?.(event),
  };
}

// Applying a config lazily starts long maintenance intervals, so drain only due
// timers instead of runAllTimersAsync, which never finishes with an interval armed.
async function flushReload() {
  for (let round = 0; round < 5; round += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

describe("config reload observation", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    configAuditMocks.readSnapshot.mockReset().mockReturnValue(null);
    configAuditMocks.readLatestSnapshot.mockReset().mockReturnValue(null);
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("publishes the initial source, then each completed read including mode off", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: { mode: "off" } },
      agents: { defaults: { model: "openai/gpt-5.6-sol" } },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { mode: "off" } },
      agents: { defaults: { model: "openai/gpt-5.6-terra" } },
    };
    const harness = createReloaderHarness(
      async () => makeSnapshot({ config: nextConfig, hash: "mode-off-write" }),
      initialConfig,
    );
    await harness.reloader.ready;
    const observedGeneration = getConfigReloadObservation().generation;
    expect(getConfigReloadObservation().sourceConfig).toEqual(initialConfig);

    harness.watcher.emit("change");
    await flushReload();

    expect(getConfigReloadObservation()).toEqual({
      generation: observedGeneration + 1,
      sourceConfig: nextConfig,
    });
    await harness.reloader.stop();
  });

  it("publishes an invalid candidate as an unavailable source", async () => {
    const harness = createReloaderHarness(
      async () =>
        makeSnapshot({
          valid: false,
          issues: [{ path: "gateway.port", message: "Expected number" }],
          hash: "invalid",
        }),
      { gateway: { reload: {} } },
    );
    await harness.reloader.ready;
    const observedGeneration = getConfigReloadObservation().generation;

    harness.watcher.emit("change");
    await flushReload();

    expect(getConfigReloadObservation()).toEqual({
      generation: observedGeneration + 1,
      sourceConfig: null,
    });
    await harness.reloader.stop();
  });

  it.each([
    {
      name: "the default model",
      initial: { agents: { defaults: { model: "openai/gpt-5.6-sol" } } },
      next: {
        agents: { defaults: { model: "openai/gpt-5.6-terra" } },
        ui: { prefs: { themeMode: "dark" as const } },
      },
      ok: { liveDefaultModel: "openai/gpt-5.6-sol", observedDefaultModel: "openai/gpt-5.6-sol" },
      drift: {
        liveDefaultModel: "openai/gpt-5.6-sol",
        observedDefaultModel: "openai/gpt-5.6-terra",
        driftPaths: ["agents.defaults.model"],
      },
    },
    {
      name: "the secret provider selection",
      initial: {
        secrets: {
          defaults: { env: "primary" },
          providers: { primary: { source: "env" as const }, secondary: { source: "env" as const } },
        },
      },
      next: {
        secrets: {
          defaults: { env: "secondary" },
          providers: { primary: { source: "env" as const }, secondary: { source: "env" as const } },
        },
      },
      ok: { liveDefaultModel: null, observedDefaultModel: null },
      drift: { liveDefaultModel: null, observedDefaultModel: null, driftPaths: ["secrets"] },
    },
  ])("keeps health on the prior observation until $name read completes", async (fixture) => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: { mode: "off" } },
      ...fixture.initial,
    };
    const nextConfig: OpenClawConfig = { gateway: { reload: { mode: "off" } }, ...fixture.next };
    const snapshot = createDeferred<ConfigFileSnapshot>();
    const harness = createReloaderHarness(() => snapshot.promise, initialConfig);
    await harness.reloader.ready;
    const observedGeneration = getConfigReloadObservation().generation;
    const health = () =>
      buildRuntimeConfigHealth({
        liveSourceConfig: initialConfig,
        hasLiveSnapshot: true,
        observedSourceConfig: getConfigReloadObservation().sourceConfig,
      });

    harness.watcher.emit("change");
    await vi.runOnlyPendingTimersAsync();

    expect(getConfigReloadObservation().generation).toBe(observedGeneration);
    expect(health()).toEqual({ state: "ok", ...fixture.ok });

    snapshot.resolve(makeSnapshot({ config: nextConfig, hash: `completed-${fixture.name}` }));
    await flushReload();

    expect(getConfigReloadObservation().generation).toBe(observedGeneration + 1);
    expect(health()).toEqual({ state: "drift", ...fixture.drift, message: DRIFT_MESSAGE });
    await harness.reloader.stop();
  });

  it("publishes only the newest source when a watcher supersedes an active read", async () => {
    const model = (primary: string): OpenClawConfig => ({
      gateway: { reload: { mode: "off" } },
      agents: { defaults: { model: primary } },
    });
    const supersededRead = createDeferred<ConfigFileSnapshot>();
    const newestRead = createDeferred<ConfigFileSnapshot>();
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockImplementationOnce(() => supersededRead.promise)
      .mockImplementationOnce(() => newestRead.promise);
    const harness = createReloaderHarness(readSnapshot, model("openai/gpt-5.6-sol"));
    await harness.reloader.ready;
    const initialObservation = getConfigReloadObservation();

    harness.watcher.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    expect(readSnapshot).toHaveBeenCalledOnce();
    harness.watcher.emit("change");
    supersededRead.resolve(makeSnapshot({ config: model("openai/gpt-5.6-terra"), hash: "old" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(getConfigReloadObservation()).toEqual(initialObservation);

    newestRead.resolve(makeSnapshot({ config: model("openai/gpt-5.6-luna"), hash: "new" }));
    await flushReload();

    expect(getConfigReloadObservation()).toEqual({
      generation: initialObservation.generation + 1,
      sourceConfig: model("openai/gpt-5.6-luna"),
    });
    await harness.reloader.stop();
  });

  it("publishes an in-process restart write's source once its transaction completes", async () => {
    const previousConfig: OpenClawConfig = {
      gateway: { reload: { mode: "hot" } },
      agents: { defaults: { model: "openai-codex/gpt-5.5" } },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { mode: "hot" } },
      agents: { defaults: { model: "openai/gpt-5.5" } },
    };
    const harness = createReloaderHarness(
      async () => makeSnapshot({ config: nextConfig, hash: "hot-model-restart" }),
      previousConfig,
    );
    await harness.reloader.ready;

    harness.emitWrite({
      configPath: "/tmp/openclaw.json",
      sourceConfig: nextConfig,
      runtimeConfig: nextConfig,
      persistedHash: "hot-model-restart",
      revision: 1,
      fingerprint: "runtime-hot-model-restart",
      sourceFingerprint: "source-hot-model-restart",
      writtenAtMs: Date.now(),
      afterWrite: { mode: "restart", reason: "model/provider runtime changed" },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(harness.onRestart).toHaveBeenCalledOnce();
    const [plan, restartConfig] = harness.onRestart.mock.calls[0] ?? [];
    expect(plan?.restartReasons).toEqual(["model/provider runtime changed"]);
    expect(restartConfig).toBe(nextConfig);
    expect(getConfigReloadObservation().sourceConfig).toEqual(nextConfig);
    await harness.reloader.stop();
  });
});
