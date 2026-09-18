import { join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import {
  commitSessionExecutionSelection,
  prepareSessionExecutionSelection,
} from "../../model-picker/apply-session-model-selection.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { CliBackendPlugin } from "../../plugins/types.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import { createSessionModelCatalogFixture } from "../test-helpers/session-model-catalog.test-support.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import { attachCompactionAccountingRecorder } from "./run/compaction-accounting-bridge.js";

const { runCliAgent } = vi.hoisted(() => ({
  runCliAgent: vi.fn(async () => ({ meta: { durationMs: 1 } })),
}));
vi.mock("../cli-runner.js", () => ({ runCliAgent }));
const { compactEmbeddedAgentSession } = await import("./compact.queued.js");
const { compactEmbeddedAgentSessionDirect } = await import("./compact.js");
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    cleanup();
    runCliAgent.mockClear();
    cliBackendsTesting.resetDepsForTest();
  }),
);

it.each([
  { entryPoint: "queued", account: "prepared" },
  { entryPoint: "queued", account: "none" },
  { entryPoint: "direct", account: "prepared" },
  { entryPoint: "direct", account: "none" },
] as const)(
  "$entryPoint native control consumes the prepared $account account",
  async ({ entryPoint, account }) => {
    const dir = tempDirs.make("openclaw-compact-selection-");
    const agentDir = join(dir, "agent");
    const workspaceDir = join(dir, "workspace");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: "anthropic/compact-fixture",
          models: { "anthropic/compact-fixture": { agentRuntime: { id: "claude-cli" } } },
        },
        list: [{ id: "main", agentDir }],
      },
      ...(account === "none" ? { auth: { order: { anthropic: [] } } } : {}),
    };
    const backend: CliBackendPlugin & { pluginId: string } = {
      id: "claude-cli",
      pluginId: "anthropic",
      modelProvider: "anthropic",
      config: { command: process.execPath, sessionMode: "existing" as const },
      bundleMcp: false,
      ownsNativeCompaction: true,
      manualCompaction: {
        buildPrompt: () => "/compact",
        input: "arg" as const,
        validateOutput: () => ({ ok: true as const }),
      },
    };
    const registry = createEmptyPluginRegistry();
    registry.cliBackends = [{ pluginId: "anthropic", source: "fixture", backend }];
    const previousRegistry = captureActivePluginRegistrySnapshot();
    onTestFinished(() => restoreActivePluginRegistrySnapshot(previousRegistry));
    setActivePluginRegistry(registry);
    cliBackendsTesting.setDepsForTest({ resolveRuntimeCliBackends: () => [backend] });
    const target = {
      agentId: "main",
      sessionId: "compact-selection",
      sessionKey: "agent:main:compact-selection",
      storePath: join(dir, "sessions.sqlite"),
    };
    const entry: InternalSessionEntry = {
      sessionId: target.sessionId,
      updatedAt: 1,
      cliSessionBindings: {
        "claude-cli": { sessionId: "native-session", authProfileId: "anthropic:subscription" },
      },
    };
    commitSessionExecutionSelection(entry, {
      model: { provider: "anthropic", id: "compact-fixture" },
      executor: { kind: "cli", id: "claude-cli" },
    });
    await upsertSessionEntryCore(target, entry);
    const before = loadSessionEntry(target);
    const plugins = createPluginMetadataSnapshotFixture({
      plugins: [
        { id: "anthropic", cliBackends: ["claude-cli"], syntheticAuthRefs: ["claude-cli"] },
      ],
    }).plugins;
    const catalog = createSessionModelCatalogFixture().publish({
      config: cfg,
      agentId: "main",
      catalog: {
        entries: [
          {
            provider: "anthropic",
            id: "compact-fixture",
            name: "Compaction fixture",
            api: "anthropic-messages",
          },
        ],
        routeVariants: [],
      },
      profiles: {
        "anthropic:subscription": {
          type: "api_key",
          provider: "anthropic",
          key: "synthetic-compaction-key",
        },
      },
      plugins,
      runtimeAuthModes: { "claude-cli": "oauth" },
    });
    const prepared = await prepareSessionExecutionSelection({
      cfg,
      agentId: "main",
      sessionEntry: entry,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
      request: { kind: "initialize" },
      replyAuth: { isNewSession: false },
      modelCatalog: catalog.entries,
      manifestPlugins: plugins,
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") {
      throw new Error(prepared.message);
    }
    expect(prepared.auth).toBeDefined();
    expect(prepared.auth?.selection?.profileId).toBe(
      account === "prepared" ? "anthropic:subscription" : undefined,
    );
    const runtimeContext: ContextEngineRuntimeContext = {};
    attachCompactionAccountingRecorder(runtimeContext, { preparedSelection: prepared });
    const params: CompactEmbeddedAgentSessionParams = {
      ...target,
      sessionTarget: target,
      sessionFile: target.sessionKey,
      workspaceDir,
      agentDir,
      config: cfg,
      provider: "stale",
      model: "stale-model",
      agentHarnessId: "openclaw",
      authProfileId: "stale:account",
      cliSessionBinding: entry.cliSessionBindings?.["claude-cli"],
      trigger: "manual",
      contextEngineRuntimeContext: runtimeContext,
    };
    const scope = new AsyncWorkScope();
    try {
      const result = await scope.run(() =>
        entryPoint === "queued"
          ? compactEmbeddedAgentSession(params, { preparedSelection: prepared })
          : compactEmbeddedAgentSessionDirect(params),
      );
      if (account === "none") {
        expect(result).toMatchObject({
          ok: false,
          compacted: false,
          reason: expect.stringContaining("account changed"),
        });
        expect(runCliAgent).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ ok: true, compacted: true });
        expect(runCliAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: "claude-cli",
            modelProvider: "anthropic",
            model: "compact-fixture",
            cliSessionId: "native-session",
            authProfileId: "anthropic:subscription",
            controlOperation: "compact",
            cleanupCliLiveSessionOnRunEnd: true,
          }),
        );
      }
      expect(loadSessionEntry(target)).toEqual(before);
    } finally {
      await AsyncWorkScope.runWhenAllIdle(
        () => [scope],
        () => scope.drain(),
      );
    }
  },
);
