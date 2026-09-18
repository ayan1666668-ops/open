import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import { createSessionModelCatalogFixture } from "../agents/test-helpers/session-model-catalog.test-support.js";
import { migrateSessionExecutionSelection } from "../commands/doctor/shared/session-execution-selection.js";
import {
  loadSessionEntry,
  listSessionEntriesReadOnly,
} from "../config/sessions/session-accessor.js";
import { normalizePersistedSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { sessionSelectionFixture } from "./session-list.test-support.js";
import { agentDiscoveryMock, testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  sessionStoreEntry,
  type setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

async function catalogRuntimeContext() {
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const fixture = createSessionModelCatalogFixture();
  return {
    loadGatewayModelCatalogSnapshot: async () => {
      const entries = agentDiscoveryMock.models.map((entry) => ({
        id: entry.id,
        provider: entry.provider,
        name: entry.name ?? entry.id,
      }));
      return fixture.publish({
        config: getRuntimeConfig(),
        agentId: "main",
        catalog: { entries, routeVariants: entries },
        profiles: {},
        runtimeAuthModes: { "claude-cli": "oauth" },
      });
    },
  };
}

export function registerSessionCreateModelSelectionTests({
  createSessionStoreDir,
}: Pick<ReturnType<typeof setupGatewaySessionsTestHarness>, "createSessionStoreDir">) {
  test.each(["cli", "enabled", "disabled"] as const)(
    "sessions.create validates published catalog runtime before creating a session (%s)",
    async (harness) => {
      const { dir, storePath } = await createSessionStoreDir();
      testState.agentConfig = {
        model: { primary: "anthropic/claude-opus-4-8" },
        models: { "anthropic/claude-opus-4-8": { agentRuntime: { id: "missing-harness" } } },
      };
      agentDiscoveryMock.enabled = true;
      agentDiscoveryMock.models = [
        { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic" },
      ];
      const agentRuntime = harness === "cli" ? "claude-cli" : "fixture-harness";
      let fixture: ReturnType<typeof createColdPluginFixture> | undefined;
      if (harness !== "cli") {
        const rootDir = await fs.mkdtemp(path.join(dir, "catalog-harness-"));
        fixture = createColdPluginFixture({
          rootDir,
          pluginId: "fixture-harness",
          manifest: { activation: { onAgentHarnesses: ["fixture-harness"] } },
        });
        const { writeConfigFile } = await getGatewayConfigModule();
        await writeConfigFile({
          plugins: {
            load: { paths: [rootDir] },
            entries: { "fixture-harness": { enabled: harness === "enabled" } },
          },
        });
      }
      const resolveCreateSession = vi.fn(() => ({
        model: "anthropic/claude-opus-4-8",
        agentRuntime,
      }));
      const registry = createEmptyPluginRegistry();
      if (harness === "cli") {
        registry.cliBackends.push({
          pluginId: "anthropic",
          source: "test",
          backend: {
            id: "claude-cli",
            modelProvider: "anthropic",
            config: { command: "claude" },
            bundleMcp: false,
          },
        });
      }
      registry.sessionCatalogs.push({
        pluginId: "anthropic",
        source: "test",
        provider: {
          id: "claude",
          label: "Claude Code",
          resolveCreateSession,
          list: vi.fn(async () => []),
          read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
        },
      });
      setActivePluginRegistry(registry);

      try {
        const created = await directSessionReq<{
          entry?: {
            providerOverride?: string;
            modelOverride?: string;
            agentRuntimeOverride?: string;
            modelSelectionLocked?: boolean;
            pluginOwnerId?: string;
          };
          key?: string;
        }>(
          "sessions.create",
          { agentId: "main", catalogId: "claude" },
          { context: await catalogRuntimeContext() },
        );

        if (fixture) {
          expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
        }
        if (harness !== "cli") {
          expect(created.ok).toBe(false);
          expect(created.error?.code).toBe("INVALID_REQUEST");
          expect(listSessionEntriesReadOnly({ agentId: "main", storePath })).toEqual([]);
          expect(created.payload).toBeUndefined();
          return;
        }
        expect(created.ok, JSON.stringify(created.error)).toBe(true);
        expect(created.payload?.entry).toMatchObject({
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-8",
          agentRuntimeOverride: agentRuntime,
          modelSelectionLocked: true,
          pluginOwnerId: "anthropic",
        });
        expect(resolveCreateSession).toHaveBeenCalledWith({ agentId: "main" });

        const patched = await directSessionReq("sessions.patch", {
          key: created.payload?.key,
          agentId: "main",
          model: "anthropic/claude-opus-4-8",
        });
        expect(patched.ok).toBe(false);
        expect(patched.error).toMatchObject({
          code: "INVALID_REQUEST",
          message: "Model selection is locked for this session.",
        });

        const deleted = await directSessionReq("sessions.delete", {
          key: created.payload?.key,
          agentId: "main",
          deleteTranscript: false,
        });
        expect(deleted.ok).toBe(true);
        expect(
          loadSessionEntry({
            agentId: "main",
            sessionKey: created.payload?.key ?? "",
            storePath,
          }),
        ).toBeUndefined();
      } finally {
        testState.agentConfig = undefined;
        setActivePluginRegistry(createEmptyPluginRegistry());
      }
    },
  );

  test("sessions.create rejects a caller-supplied key for a catalog target", async () => {
    const { storePath } = await createSessionStoreDir();
    const existing = sessionStoreEntry("sess-existing-catalog-target", {
      executionSelection: {
        state: "deferred",
        request: { model: { provider: "openai", id: "gpt-existing" } },
        fallbackPermission: "explicit",
      },
    });
    await writeSessionStore({ entries: { main: existing } });
    const registry = createEmptyPluginRegistry();
    registry.sessionCatalogs.push({
      pluginId: "anthropic",
      source: "test",
      provider: {
        id: "claude",
        label: "Claude Code",
        resolveCreateSession: () => ({
          model: "anthropic/claude-opus-4-8",
          agentRuntime: "claude-cli",
        }),
        list: vi.fn(async () => []),
        read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
      },
    });
    setActivePluginRegistry(registry);

    try {
      const created = await directSessionReq("sessions.create", {
        key: "main",
        agentId: "main",
        catalogId: "claude",
      });

      expect(created.ok).toBe(false);
      expect(created.error).toMatchObject({
        code: "INVALID_REQUEST",
        message: "sessions.create catalogId cannot include key",
      });
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:main", storePath }),
      ).toMatchObject({
        sessionId: existing.sessionId,
        executionSelection: existing.executionSelection,
      });
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
    }
  });

  test("sessions.create authorizes a catalog target for the requested agent", async () => {
    await createSessionStoreDir();
    testState.agentsConfig = {
      list: [{ id: "main", default: true }, { id: "research" }],
    };
    const resolveCreateSession = vi.fn(({ agentId }: { agentId?: string }) =>
      agentId === "research"
        ? undefined
        : {
            model: "anthropic/claude-opus-4-8",
            agentRuntime: "claude-cli",
          },
    );
    const registry = createEmptyPluginRegistry();
    registry.sessionCatalogs.push({
      pluginId: "anthropic",
      source: "test",
      provider: {
        id: "claude",
        label: "Claude Code",
        resolveCreateSession,
        list: vi.fn(async () => []),
        read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
      },
    });
    setActivePluginRegistry(registry);

    try {
      const created = await directSessionReq("sessions.create", {
        agentId: "research",
        catalogId: "claude",
      });

      expect(created.ok).toBe(false);
      expect(created.error).toMatchObject({
        code: "UNAVAILABLE",
        message: "session catalog claude cannot create sessions",
      });
      expect(resolveCreateSession).toHaveBeenCalledWith({ agentId: "research" });
    } finally {
      testState.agentsConfig = undefined;
      setActivePluginRegistry(createEmptyPluginRegistry());
    }
  });

  test("sessions.create bypasses main-session reset for a catalog target", async () => {
    await createSessionStoreDir();
    testState.agentConfig = { model: { primary: "anthropic/claude-opus-4-8" } };
    testState.sessionConfig = { dmScope: "main" };
    agentDiscoveryMock.enabled = true;
    agentDiscoveryMock.models = [
      { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic" },
    ];
    await writeSessionStore({
      entries: {
        main: sessionStoreEntry("sess-parent-catalog"),
      },
    });
    const registry = createEmptyPluginRegistry();
    registry.cliBackends.push({
      pluginId: "anthropic",
      source: "test",
      backend: {
        id: "claude-cli",
        modelProvider: "anthropic",
        config: { command: "claude" },
        bundleMcp: false,
      },
    });
    registry.sessionCatalogs.push({
      pluginId: "anthropic",
      source: "test",
      provider: {
        id: "claude",
        label: "Claude Code",
        resolveCreateSession: () => ({
          model: "anthropic/claude-opus-4-8",
          agentRuntime: "claude-cli",
        }),
        list: vi.fn(async () => []),
        read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
      },
    });
    setActivePluginRegistry(registry);

    try {
      const created = await directSessionReq<{
        key?: string;
        entry?: {
          parentSessionKey?: string;
          providerOverride?: string;
          modelOverride?: string;
          agentRuntimeOverride?: string;
          modelSelectionLocked?: boolean;
        };
      }>(
        "sessions.create",
        {
          agentId: "main",
          catalogId: "claude",
          parentSessionKey: "main",
          emitCommandHooks: true,
        },
        { context: await catalogRuntimeContext() },
      );

      expect(created.ok).toBe(true);
      expect(created.payload?.key).toMatch(/^agent:main:dashboard:/);
      expect(created.payload?.entry).toMatchObject({
        parentSessionKey: "agent:main:main",
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-8",
        agentRuntimeOverride: "claude-cli",
        modelSelectionLocked: true,
      });
    } finally {
      testState.agentConfig = undefined;
      testState.sessionConfig = undefined;
      setActivePluginRegistry(createEmptyPluginRegistry());
    }
  });

  test("sessions.create inherits explicit selection without runtime model identity", async () => {
    const { storePath } = await createSessionStoreDir();
    await writeSessionStore({
      entries: {
        main: sessionStoreEntry("sess-parent", {
          executionSelection: sessionSelectionFixture({
            model: { provider: "codex", id: "gpt-5.5" },
            executor: { kind: "harness", id: "codex" },
          }),
          modelProvider: "codex",
          model: "gpt-5.5",
          contextTokens: 272000,
          inputTokens: 12000,
          outputTokens: 340,
          totalTokens: 12340,
          totalTokensFresh: false,
          contextBudgetStatus: {
            schemaVersion: 1,
            source: "pre-prompt-estimate",
            updatedAt: 1,
            provider: "codex",
            model: "gpt-5.5",
            route: "compact_then_truncate",
            shouldCompact: true,
            estimatedPromptTokens: 250000,
            contextTokenBudget: 128000,
            promptBudgetBeforeReserve: 112000,
            reserveTokens: 16000,
            effectiveReserveTokens: 16000,
            remainingPromptBudgetTokens: 0,
            overflowTokens: 138000,
            toolResultReducibleChars: 5000,
            messageCount: 12,
            unwindowedMessageCount: 12,
          },
          thinkingLevel: "off",
          fastMode: "auto",
          traceLevel: "debug",
          authProfileOverride: "codex-oauth",
          authProfileOverrideSource: "user",
        }),
      },
    });

    const created = await directSessionReq<{
      key?: string;
      resolved?: { modelProvider?: string; model?: string };
      entry?: {
        providerOverride?: string;
        modelOverride?: string;
        modelOverrideSource?: string;
        agentRuntimeOverride?: string;
        modelProvider?: string;
        model?: string;
        contextTokens?: number;
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        totalTokensFresh?: boolean;
        contextBudgetStatus?: unknown;
        thinkingLevel?: string;
        fastMode?: string;
        traceLevel?: string;
        authProfileOverride?: string;
        authProfileOverrideSource?: string;
        parentSessionKey?: string;
      };
    }>("sessions.create", {
      agentId: "main",
      label: "Fresh Chat",
      parentSessionKey: "main",
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
    expect(created.payload?.entry?.providerOverride).toBe("codex");
    expect(created.payload?.entry?.modelOverride).toBe("gpt-5.5");
    expect(created.payload?.entry?.modelOverrideSource).toBe("user");
    expect(created.payload?.entry?.agentRuntimeOverride).toBe("codex");
    expect(created.payload?.entry?.modelProvider).toBeUndefined();
    expect(created.payload?.entry?.model).toBeUndefined();
    expect(created.payload?.resolved).toEqual({ modelProvider: "codex", model: "gpt-5.5" });
    expect(created.payload?.entry?.contextTokens).toBeUndefined();
    expect(created.payload?.entry?.inputTokens).toBeUndefined();
    expect(created.payload?.entry?.outputTokens).toBeUndefined();
    expect(created.payload?.entry?.totalTokens).toBeUndefined();
    expect(created.payload?.entry?.totalTokensFresh).toBeUndefined();
    expect(created.payload?.entry?.contextBudgetStatus).toBeUndefined();
    expect(created.payload?.entry?.thinkingLevel).toBe("off");
    expect(created.payload?.entry?.fastMode).toBe("auto");
    expect(created.payload?.entry?.traceLevel).toBe("debug");
    expect(created.payload?.entry?.authProfileOverride).toBe("codex-oauth");
    expect(created.payload?.entry?.authProfileOverrideSource).toBe("user");

    const key = created.payload?.key as string;
    const storedEntry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    expect(storedEntry?.executionSelection).toEqual(
      sessionSelectionFixture({
        model: { provider: "codex", id: "gpt-5.5" },
        executor: { kind: "harness", id: "codex" },
      }),
    );
    expect(storedEntry?.modelProvider).toBeUndefined();
    expect(storedEntry?.model).toBeUndefined();
    expect(storedEntry?.parentSessionKey).toBe("agent:main:main");

    const overridden = await directSessionReq<{
      entry?: { fastMode?: boolean | "auto" };
    }>("sessions.create", {
      agentId: "main",
      fastMode: false,
      parentSessionKey: "main",
    });
    expect(overridden.ok, JSON.stringify(overridden.error)).toBe(true);
    expect(overridden.payload?.entry?.fastMode).toBe(false);
  });

  test("sessions.create inherits migrated requested intent rather than the observed auto fallback", async () => {
    const { storePath } = await createSessionStoreDir();
    testState.agentConfig = { model: { primary: "openai/gpt-primary" } };
    await writeSessionStore({
      entries: {
        main: expectDefined(
          normalizePersistedSessionEntryShape(
            migrateSessionExecutionSelection({
              entry: {
                ...sessionStoreEntry("sess-parent-auto-fallback"),
                providerOverride: "google-vertex",
                modelOverride: "gemini-fallback",
                modelOverrideSource: "auto",
                modelOverrideFallbackOriginProvider: "openai",
                modelOverrideFallbackOriginModel: "gpt-primary",
                agentRuntimeOverride: "vertex-runtime",
                contextWindow: "1m",
                authProfileOverride: "google-vertex:fallback",
                authProfileOverrideSource: "auto",
                thinkingLevel: "high",
              },
              classifyExecutor: () => undefined,
            }).entry,
          ),
          "converted fallback parent",
        ),
      },
    });

    const created = await directSessionReq<{
      key?: string;
      resolved?: { modelProvider?: string; model?: string };
      entry?: {
        parentSessionKey?: string;
        providerOverride?: string;
        modelOverride?: string;
        modelOverrideSource?: string;
        agentRuntimeOverride?: string;
        contextWindow?: string;
        authProfileOverride?: string;
        authProfileOverrideSource?: string;
        thinkingLevel?: string;
      };
    }>("sessions.create", {
      agentId: "main",
      parentSessionKey: "main",
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
    expect(created.payload?.entry?.providerOverride).toBe("openai");
    expect(created.payload?.entry?.modelOverride).toBe("gpt-primary");
    expect(created.payload?.entry?.modelOverrideSource).toBe("auto");
    expect(created.payload?.entry?.agentRuntimeOverride).toBe("vertex-runtime");
    expect(created.payload?.entry?.contextWindow).toBe("1m");
    expect(created.payload?.entry?.authProfileOverride).toBeUndefined();
    expect(created.payload?.entry?.authProfileOverrideSource).toBeUndefined();
    expect(created.payload?.entry?.thinkingLevel).toBe("high");
    expect(created.payload?.resolved).toEqual({ modelProvider: "openai", model: "gpt-primary" });

    const key = created.payload?.key as string;
    const storedEntry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    expect(storedEntry?.parentSessionKey).toBe("agent:main:main");
    expect(storedEntry?.executionSelection).toEqual({
      state: "deferred",
      request: { model: { provider: "openai", id: "gpt-primary" }, runtime: "vertex-runtime" },
      fallbackPermission: "configured",
    });
    expect(storedEntry?.contextWindow).toBe("1m");
    expect(storedEntry?.authProfileOverride).toBeUndefined();
    expect(storedEntry?.authProfileOverrideSource).toBeUndefined();
    expect(storedEntry?.thinkingLevel).toBe("high");
  });

  test("sessions.create resolves the current default instead of inherited runtime identity", async () => {
    const { storePath } = await createSessionStoreDir();
    testState.agentConfig = { model: { primary: "anthropic/current-model" } };
    await writeSessionStore({
      entries: {
        main: sessionStoreEntry("sess-parent-stale", {
          modelProvider: "openai",
          model: "stale-model",
        }),
      },
    });

    const created = await directSessionReq<{
      key?: string;
      resolved?: { modelProvider?: string; model?: string };
      entry?: { modelProvider?: string; model?: string };
    }>("sessions.create", {
      agentId: "main",
      parentSessionKey: "main",
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.entry?.modelProvider).toBeUndefined();
    expect(created.payload?.entry?.model).toBeUndefined();
    expect(created.payload?.resolved).toEqual({
      modelProvider: "anthropic",
      model: "current-model",
    });

    const key = created.payload?.key as string;
    const storedEntry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    expect(storedEntry?.modelProvider).toBeUndefined();
    expect(storedEntry?.model).toBeUndefined();
  });
}
