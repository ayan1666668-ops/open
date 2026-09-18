import { join } from "node:path";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { acceptCompactionSuccessor } from "../../agents/embedded-agent-runner/compaction-successor.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import { createSessionModelCatalogFixture } from "../../agents/test-helpers/session-model-catalog.test-support.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { resolveAgentDirMock } from "./commands-agent-scope.test-support.js";
import { handleCompactCommand } from "./commands-compact.js";
import {
  buildCompactParams,
  compactEmbeddedAgentSession,
  requireCompactEmbeddedAgentSessionCall,
  resetCompactCommandMocks,
  resolveCurrentSessionEntry,
} from "./commands-compact.test-support.js";
import { createModelSelectionState } from "./model-selection.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);
beforeEach(resetCompactCommandMocks);

async function setup(observedHarness: string, nativeOwned = false) {
  const dir = dirs.make("openclaw-compact-transport-");
  const agentDir = join(dir, "agent");
  const workspaceDir = join(dir, "workspace");
  resolveAgentDirMock.mockReturnValue(agentDir);
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: "fixture/compact-model",
        models: { "fixture/compact-model": { params: { temperature: 0.2 } } },
      },
      list: [{ id: "main", agentDir }],
    },
    models: {
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: "https://compaction-fixture.invalid/v1",
          headers: { "X-Compaction-Fixture": "preserve" },
          models: [],
        },
      },
    },
  };
  const registry = captureActivePluginRegistrySnapshot();
  onTestFinished(() => restoreActivePluginRegistrySnapshot(registry));
  setActivePluginRegistry(createEmptyPluginRegistry());
  registerAgentHarness({
    id: "fixture-app",
    label: "Fixture app",
    supports: (context) =>
      context.modelProvider?.requestTransportOverrides === "present"
        ? { supported: false, fallbackRuntime: "openclaw", reason: "Requires host transport" }
        : { supported: true },
    runAttempt: vi.fn(),
  });
  const published = createSessionModelCatalogFixture().publish({
    config: cfg,
    agentId: "main",
    catalog: {
      entries: [{ provider: "fixture", id: "compact-model", name: "Compaction model" }],
      routeVariants: [],
    },
    profiles: {
      "fixture:account": { type: "api_key", provider: "fixture", key: "synthetic-fixture-key" },
    },
  });
  const target = {
    agentId: "main",
    sessionKey: "agent:main:compact-transport",
    storePath: join(dir, "sessions.sqlite"),
  };
  const entry: InternalSessionEntry = {
    sessionId: "compaction-session",
    lifecycleRevision: "compaction-lifecycle",
    updatedAt: 1,
    modelSelectionLocked: true,
    ...(!nativeOwned ? { pluginOwnerId: "model-owner" } : {}),
    agentHarnessId: observedHarness,
    authProfileOverride: "fixture:account",
    authProfileOverrideSource: "user",
    executionSelection: {
      state: "accepted",
      selection: {
        model: { provider: "fixture", id: "compact-model" },
        executor: { kind: "harness", id: "fixture-app" },
      },
      fallbackPermission: "explicit",
    },
  };
  replaceSessionEntrySync(target, entry);
  const params = {
    ...buildCompactParams("/compact", cfg),
    ...target,
    workspaceDir,
    agentDir,
    sessionEntry: entry,
    sessionStore: { [target.sessionKey]: entry },
  };
  const state = await createModelSelectionState({
    cfg,
    agentId: "main",
    agentCfg: cfg.agents?.defaults,
    sessionEntry: entry,
    sessionStore: params.sessionStore,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
    defaultProvider: "fixture",
    defaultModel: "compact-model",
    provider: "fixture",
    model: "compact-model",
    hasModelDirective: false,
    prepareExecution: false,
    preparedModelCatalog: published,
    replyAuth: { isNewSession: false },
  });
  params.prepareModelState = (current, validateCommit, purpose) =>
    state.refreshExecution(current, validateCommit, purpose);
  vi.mocked(resolveCurrentSessionEntry).mockImplementation(({ expected }) => {
    const current = loadSessionEntryReadOnly(target);
    return current?.sessionId === expected.sessionId &&
      current.lifecycleRevision === expected.lifecycleRevision
      ? current
      : undefined;
  });
  vi.mocked(compactEmbeddedAgentSession).mockImplementation(async (_input, host) => {
    host?.assertActive?.();
    return { ok: true, compacted: true, result: { tokensBefore: 100, tokensAfter: 50 } };
  });
  return { params, entry, target, state };
}

it.each(["openclaw", "fixture-app"])(
  "manual compaction uses declared host transport without repinning observed %s history",
  async (observed) => {
    const { params, entry, target, state } = await setup(observed);
    await expect(state.refreshExecution(entry)).rejects.toThrow("cannot run");
    const reply = await handleCompactCommand(params, true);
    expect(reply?.reply?.text).toContain("Compacted");
    expect(requireCompactEmbeddedAgentSessionCall()).toMatchObject({
      provider: "fixture",
      model: "compact-model",
      agentHarnessId: "openclaw",
      authProfileId: "fixture:account",
      authProfileIdSource: "user",
      modelSelectionLocked: true,
      config: params.cfg,
    });
    expect(loadSessionEntryReadOnly(target)).toMatchObject(entry);
  },
);

it("refuses a native transcript owner's declared host fallback", async () => {
  const { params, target, entry } = await setup("fixture-app", true);
  const reply = await handleCompactCommand(params, true);
  expect(reply?.reply?.text).toContain("Compaction unavailable");
  expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
  expect(loadSessionEntryReadOnly(target)).toMatchObject(entry);
});

it.each(["account", "plugin-owner", "writer", "identity"] as const)(
  "refuses compaction when the persisted %s changes after preparation",
  async (change) => {
    const { params, entry, target } = await setup("fixture-app");
    params.resolveModelLevels = async () => {
      replaceSessionEntrySync(target, {
        ...entry,
        ...(change === "account"
          ? { authProfileOverride: "fixture:other" }
          : change === "plugin-owner"
            ? { pluginOwnerId: "other-owner" }
            : change === "writer"
              ? { activeWriterRunId: "other-writer" }
              : { sessionId: "unadmitted-replacement" }),
      });
      return { resolvedThinkLevel: "medium", resolvedReasoningLevel: "off" };
    };
    const reply = await handleCompactCommand(params, true);
    expect(reply?.reply?.text).toContain("Compaction unavailable");
    expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "keeps command custody after an actual successor commit (wrong predecessor=%s)",
  async (wrongPredecessor) => {
    const { params, entry, target } = await setup("fixture-app");
    vi.mocked(compactEmbeddedAgentSession).mockImplementation(async (_input, host) => {
      const result = {
        ok: true,
        compacted: true,
        result: { sessionId: "command-successor", tokensBefore: 100, tokensAfter: 50 },
      };
      await acceptCompactionSuccessor({
        config: params.cfg,
        currentSessionFile: target.sessionKey,
        currentTarget: { ...target, sessionId: entry.sessionId },
        expectedEntry: {
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
          activeWriterRunId: entry.activeWriterRunId,
        },
        assertActive: () => host?.assertActive?.(),
        result,
        onCommitted: (accepted) => {
          // Negative control: a corrupt predecessor receipt cannot advance preparation custody.
          host?.onCommitted?.(
            wrongPredecessor ? { ...accepted, previousSessionId: "another-predecessor" } : accepted,
          );
        },
      });
      host?.assertActive?.();
      return result;
    });
    const command = handleCompactCommand(params, true);
    if (wrongPredecessor) {
      await expect(command).rejects.toThrow("The session selection changed");
    } else {
      expect((await command)?.reply?.text).toContain("Compacted");
    }
    const { updatedAt: originalUpdatedAt, ...originalEntry } = entry;
    const committed = loadSessionEntryReadOnly(target);
    expect(committed).toMatchObject({
      ...originalEntry,
      sessionId: "command-successor",
      executionSelection: entry.executionSelection,
    });
    expect(committed?.updatedAt).toBeGreaterThan(originalUpdatedAt);
  },
);
