// Tests compact command behavior for session compaction and reply status.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { createSessionModelCatalogFixture } from "../../agents/test-helpers/session-model-catalog.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { commitSessionExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  resolveAgentDirMock,
  resolveSessionAgentIdMock,
} from "./commands-agent-scope.test-support.js";
import { handleCompactCommand } from "./commands-compact.js";
import {
  abortEmbeddedAgentRun,
  buildCompactParams,
  compactEmbeddedAgentSession,
  formatContextUsageShort,
  runCompactCommand,
  incrementCompactionCount,
  requireCompactEmbeddedAgentSessionCall,
  requireIncrementCompactionCountCall,
  requireResolveAgentDirCall,
  requireResolveSessionAgentIdCall,
  resetCompactCommandMocks,
  waitForEmbeddedAgentRunEnd,
} from "./commands-compact.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { createModelSelectionState } from "./model-selection.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);

describe("handleCompactCommand", () => {
  beforeEach(resetCompactCommandMocks);

  it("returns null when command is not /compact", async () => {
    const result = await runCompactCommand(
      buildCompactParams("/status", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig),
      true,
    );

    expect(result).toBeNull();
    expect(vi.mocked(compactEmbeddedAgentSession)).not.toHaveBeenCalled();
  });

  it("uses the complete prepared turn-local route without repinning the human session", async () => {
    const priorRegistry = captureActivePluginRegistrySnapshot();
    onTestFinished(() => {
      restoreActivePluginRegistrySnapshot(priorRegistry);
      cliBackendsTesting.resetDepsForTest();
    });
    const backend = {
      id: "claude-cli",
      pluginId: "anthropic",
      modelProvider: "anthropic",
      config: { command: process.execPath },
      bundleMcp: false,
    };
    const registry = createEmptyPluginRegistry();
    registry.cliBackends = [{ pluginId: "anthropic", source: "fixture", backend }];
    setActivePluginRegistry(registry);
    cliBackendsTesting.setDepsForTest({ resolveRuntimeCliBackends: () => [backend] });
    const cfg: OpenClawConfig = {
      commands: { text: true },
      agents: {
        defaults: {
          model: "fixture/temporary",
          models: { "fixture/temporary": { agentRuntime: { id: "openclaw" } } },
        },
      },
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://compaction-fixture.invalid/v1",
            models: [
              {
                id: "temporary",
                name: "Temporary",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    };
    const published = createSessionModelCatalogFixture().publish({
      config: cfg,
      agentId: "main",
      catalog: {
        entries: [
          {
            provider: "fixture",
            id: "temporary",
            name: "Temporary",
            api: "openai-completions",
            contextWindow: 32000,
          },
        ],
        routeVariants: [],
      },
      profiles: {
        "anthropic:human": { type: "api_key", provider: "anthropic", key: "synthetic-human-key" },
        "fixture:temporary": {
          type: "api_key",
          provider: "fixture",
          key: "synthetic-temporary-key",
        },
      },
      plugins: createPluginMetadataSnapshotFixture({
        plugins: [
          { id: "anthropic", cliBackends: ["claude-cli"], syntheticAuthRefs: ["claude-cli"] },
        ],
      }).plugins,
      runtimeAuthModes: { "claude-cli": "oauth" },
    });
    const entry: SessionEntry = {
      sessionId: "temporary-compact",
      updatedAt: 1,
      authProfileOverride: "anthropic:human",
      authProfileOverrideSource: "auto",
      cliSessionBindings: {
        "claude-cli": { sessionId: "human-native-session", authProfileId: "anthropic:human" },
      },
    };
    commitSessionExecutionSelection(entry, {
      model: { provider: "anthropic", id: "human-model" },
      executor: { kind: "cli", id: "claude-cli" },
    });
    const before = structuredClone(entry);
    const params = buildCompactParams("/compact", cfg);
    params.sessionEntry = entry;
    params.sessionStore = { [params.sessionKey]: entry };
    let state = await createModelSelectionState({
      cfg,
      agentId: "main",
      agentCfg: cfg.agents?.defaults,
      sessionEntry: entry,
      sessionKey: params.sessionKey,
      sessionStore: params.sessionStore,
      defaultProvider: "fixture",
      defaultModel: "temporary",
      provider: "fixture",
      model: "temporary",
      hasModelDirective: false,
      prepareExecution: false,
      hasOneTurnModelOverride: true,
      preparedModelCatalog: published,
      replyAuth: { isNewSession: false },
    });
    params.prepareModelState = async (current, guard) => {
      state = await state.refreshExecution(current, guard);
      return state;
    };
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({ ok: true, compacted: false });
    await handleCompactCommand(params, true);
    expect(compactEmbeddedAgentSession).toHaveBeenCalledOnce();
    expect(requireCompactEmbeddedAgentSessionCall()).toMatchObject({
      provider: "fixture",
      model: "temporary",
      agentHarnessId: "openclaw",
      authProfileId: "fixture:temporary",
      authProfileIdSource: "auto",
      cliSessionId: undefined,
      cliSessionBinding: undefined,
      contextTokenBudget: 32000,
    });
    expect(
      vi.mocked(compactEmbeddedAgentSession).mock.calls[0]?.[1]?.preparedSelection,
    ).toMatchObject({
      selection: {
        model: { provider: "fixture", id: "temporary" },
        executor: { kind: "harness", id: "openclaw" },
      },
      auth: {
        selection: { profileId: "fixture:temporary", source: "auto" },
        validate: expect.any(Function),
      },
    });
    expect(entry).toEqual(before);
    expect(params.sessionStore[params.sessionKey]).toEqual(before);
  });

  it("rejects unauthorized /compact commands", async () => {
    const params = buildCompactParams("/compact", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);

    const result = await runCompactCommand(
      {
        ...params,
        command: {
          ...params.command,
          isAuthorizedSender: false,
          senderId: "unauthorized",
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result).toEqual({ shouldContinue: false });
    expect(vi.mocked(compactEmbeddedAgentSession)).not.toHaveBeenCalled();
  });

  it("routes manual compaction with explicit trigger and context metadata", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });
    const abortController = new AbortController();

    const result = await runCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: "/tmp/openclaw-session-store.json" },
        } as OpenClawConfig),
        ctx: {
          Provider: "whatsapp",
          Surface: "whatsapp",
          CommandSource: "text",
          CommandBody: "/compact: focus on decisions",
          commandText: "/compact: focus on decisions",
          From: "+15550001",
          To: "+15550002",
          SenderName: "Alice",
          SenderUsername: "alice_u",
          SenderE164: "+15551234567",
        },
        agentDir: "/tmp/openclaw-agent-compact",
        opts: { abortSignal: abortController.signal },
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          groupId: "group-1",
          groupChannel: "#general",
          space: "workspace-1",
          spawnedBy: "agent:main:parent",
          totalTokens: 12345,
          authProfileOverride: "github-copilot:work",
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(vi.mocked(compactEmbeddedAgentSession)).toHaveBeenCalledOnce();
    const call = requireCompactEmbeddedAgentSessionCall();
    expect(call.sessionId).toBe("session-1");
    expect(call.abortSignal).toBe(abortController.signal);
    expect(call.sessionKey).toBe("agent:main:main");
    expect(call.allowGatewaySubagentBinding).toBe(true);
    expect(call.trigger).toBe("manual");
    expect(call.customInstructions).toBe("focus on decisions");
    expect(call.messageChannel).toBe("whatsapp");
    expect(call.groupId).toBe("group-1");
    expect(call.groupChannel).toBe("#general");
    expect(call.groupSpace).toBe("workspace-1");
    expect(call.spawnedBy).toBe("agent:main:parent");
    expect(call.senderId).toBe("owner");
    expect(call.senderName).toBe("Alice");
    expect(call.senderUsername).toBe("alice_u");
    expect(call.senderE164).toBe("+15551234567");
    expect(call.agentDir).toBe("/tmp/openclaw-agent-compact");
    expect(call.authProfileId).toBe("github-copilot:work");
    expect(call.authProfileIdSource).toBe("user");
    expect(vi.mocked(abortEmbeddedAgentRun)).not.toHaveBeenCalled();
    expect(vi.mocked(waitForEmbeddedAgentRunEnd)).not.toHaveBeenCalled();
  });

  it("keeps the verified current owner in bounded manual-compaction prompt guidance", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });
    const ownerIds = Array.from({ length: 24 }, (_, index) => `owner-${index}`);
    const params = buildCompactParams("/compact", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    params.command = {
      ...params.command,
      ownerList: ownerIds,
      senderId: "owner-23",
      senderIsOwner: true,
    };
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
    };

    await runCompactCommand(params, true);

    const call = requireCompactEmbeddedAgentSessionCall();
    expect(call.ownerNumbers).toHaveLength(16);
    expect(call.ownerNumbers?.at(-1)).toBe("owner-23");
    expect(call).not.toHaveProperty("senderIsOwner");
    expect(params.command.ownerList).toEqual(ownerIds);
  });

  it("treats already-under-target manual compaction as skipped", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "already under target",
    });

    const result = await runCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.reply?.text).toBe(
      "⚙️ Compaction skipped: context is already under the compaction target • Context 12.1k",
    );
    expect(result?.reply?.isStatusNotice).toBe(true);
    expect(vi.mocked(incrementCompactionCount)).not.toHaveBeenCalled();
  });

  it("does not hide a failed manual compaction with an empty-transcript reason", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "no real conversation messages",
    });

    const result = await runCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.reply?.text).toBe(
      "⚙️ Compaction failed: nothing compactable in this session yet • Context 12.1k",
    );
    expect(vi.mocked(incrementCompactionCount)).not.toHaveBeenCalled();
  });

  it("treats already_compacted manual compaction as skipped", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "already_compacted",
    });

    const result = await runCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.reply?.text).toBe(
      "⚙️ Compaction skipped: session is already compacted • Context 12.1k",
    );
    expect(result?.reply?.isStatusNotice).toBe(true);
  });

  it("uses the canonical session agent when resolving the compaction session file", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });
    resolveSessionAgentIdMock.mockReturnValue("target");
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: "/tmp/openclaw-session-store.json" },
    } as OpenClawConfig;

    await runCompactCommand(
      {
        ...buildCompactParams("/compact", cfg),
        agentId: "main",
        sessionKey: "agent:target:whatsapp:direct:12345",
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(compactEmbeddedAgentSession).toHaveBeenCalledOnce();
    const resolveCall = requireResolveSessionAgentIdCall();
    expect(resolveCall.sessionKey).toBe("agent:target:whatsapp:direct:12345");
    expect(resolveCall.config).toBe(cfg);
    expect(requireCompactEmbeddedAgentSessionCall().sessionTarget).toEqual({
      agentId: "target",
      sessionId: "session-1",
      sessionKey: "agent:target:whatsapp:direct:12345",
      storePath: "/tmp/openclaw-session-store.json",
    });
  });

  it("keeps the selected agent when compacting an ambiguous global session", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });
    resolveSessionAgentIdMock.mockReturnValue("marie-clawndo");
    const cfg = {
      agents: {
        entries: {
          main: {},
          "marie-clawndo": {},
        },
      },
    } as OpenClawConfig;

    await runCompactCommand(
      {
        ...buildCompactParams("/compact", cfg),
        agentId: "marie-clawndo",
        sessionKey: "global",
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      sessionKey: "global",
      config: cfg,
      agentId: "marie-clawndo",
    });
    expect(requireCompactEmbeddedAgentSessionCall().sessionTarget).toMatchObject({
      agentId: "marie-clawndo",
    });
  });

  it("uses the resolved command store for compaction", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });
    const dir = tempDirs.make("openclaw-compact-command-store-");
    const storePath = join(dir, "scoped-sessions.sqlite");
    const sessionEntry = { sessionId: "session-1", updatedAt: Date.now() };
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:main", storePath },
      sessionEntry,
    );
    const cfg: OpenClawConfig = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: join(dir, "default-sessions.sqlite") },
    };

    const result = await runCompactCommand(
      {
        ...buildCompactParams("/compact", cfg),
        storePath,
        sessionEntry,
      } as HandleCommandsParams,
      true,
    );

    expect(compactEmbeddedAgentSession, result?.reply?.text).toHaveBeenCalledOnce();
    expect(requireCompactEmbeddedAgentSessionCall().sessionTarget?.storePath).toBe(storePath);
  });

  it("uses the canonical session agent directory for compaction runtime inputs", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });
    resolveSessionAgentIdMock.mockReturnValue("target");
    resolveAgentDirMock.mockReturnValue("/tmp/target-agent");
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;

    await runCompactCommand(
      {
        ...buildCompactParams("/compact", cfg),
        agentId: "main",
        agentDir: "/tmp/main-agent",
        sessionKey: "agent:target:whatsapp:direct:12345",
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(requireCompactEmbeddedAgentSessionCall().agentDir).toBe("/tmp/target-agent");
    expect(compactEmbeddedAgentSession).toHaveBeenCalledOnce();
    const [configArg, agentIdArg] = requireResolveAgentDirCall();
    expect(configArg).toBe(cfg);
    expect(agentIdArg).toBe("target");
  });

  it("prefers the target session entry for compaction runtime metadata", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });

    await runCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionKey: "agent:target:whatsapp:direct:12345",
        sessionEntry: {
          sessionId: "wrapper-session",
          updatedAt: Date.now(),
          groupId: "wrapper-group",
          groupChannel: "#wrapper",
          space: "wrapper-space",
          spawnedBy: "agent:wrapper",
          skillsSnapshot: { prompt: "wrapper", skills: [] },
          contextTokens: 111,
        },
        sessionStore: {
          "agent:target:whatsapp:direct:12345": {
            sessionId: "target-session",
            updatedAt: Date.now(),
            groupId: "target-group",
            groupChannel: "#target",
            space: "target-space",
            spawnedBy: "agent:target-parent",
            skillsSnapshot: { prompt: "target", skills: [] },
            contextTokens: 222,
          },
        },
      } as HandleCommandsParams,
      true,
    );

    const call = requireCompactEmbeddedAgentSessionCall();
    expect(call.sessionId).toBe("target-session");
    expect(call.groupId).toBe("target-group");
    expect(call.groupChannel).toBe("#target");
    expect(call.groupSpace).toBe("target-space");
    expect(call.spawnedBy).toBe("agent:target-parent");
    expect(call.skillsSnapshot).toEqual({ prompt: "target", skills: [] });
  });

  it("refuses an unbound native-managed selection without unlocking or compacting it", async () => {
    const entry = {
      sessionId: "locked-session",
      updatedAt: 1,
      executionSelection: {
        state: "accepted",
        selection: { model: "native-managed", executor: { kind: "harness", id: "codex" } },
        fallbackPermission: "explicit",
      },
      modelSelectionLocked: true,
    } satisfies NonNullable<HandleCommandsParams["sessionEntry"]>;
    const before = structuredClone(entry);
    await expect(
      runCompactCommand(
        {
          ...buildCompactParams("/compact", {}),
          sessionEntry: entry,
        },
        true,
      ),
    ).resolves.toMatchObject({
      shouldContinue: false,
      sessionCompaction: {
        compacted: false,
        reason: expect.stringContaining("Could not confirm this app's session ownership"),
      },
      reply: { text: expect.stringContaining("Compaction unavailable") },
    });
    expect(entry).toEqual(before);
    expect(compactEmbeddedAgentSession).not.toHaveBeenCalled();
    expect(abortEmbeddedAgentRun).not.toHaveBeenCalled();
  });

  it("targets the persisted native CLI session for manual compaction", async () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () =>
        [
          {
            id: "claude-cli",
            modelProvider: "anthropic",
            config: { command: "claude" },
            bundleMcp: false,
          },
        ] as never,
    });
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
    });

    try {
      await runCompactCommand(
        {
          ...buildCompactParams("/compact", {
            commands: { text: true },
            channels: { whatsapp: { allowFrom: ["*"] } },
          } as OpenClawConfig),
          provider: "anthropic",
          sessionEntry: {
            sessionId: "cli-session",
            updatedAt: Date.now(),
            executionSelection: {
              state: "accepted",
              selection: {
                model: { provider: "anthropic", id: "fixture" },
                executor: { kind: "cli", id: "claude-cli" },
              },
              fallbackPermission: "explicit",
            },
            cliSessionBindings: {
              "claude-cli": { sessionId: "native-claude-session" },
            },
          },
        } as HandleCommandsParams,
        true,
      );

      expect(requireCompactEmbeddedAgentSessionCall()).toMatchObject({
        agentHarnessId: "claude-cli",
        cliSessionId: "native-claude-session",
        trigger: "manual",
      });
    } finally {
      cliBackendsTesting.resetDepsForTest();
    }
  });

  it.each([
    { provider: "anthropic", harness: "claude-cli", expectedRuntime: "claude-cli" },
    { provider: "openai", harness: "claude-cli", expectedRuntime: undefined },
    { provider: "anthropic", harness: "codex", expectedRuntime: undefined },
    { provider: "openai", harness: "codex", expectedRuntime: "codex" },
    { provider: "github-copilot", harness: "copilot", expectedRuntime: "copilot" },
  ])(
    "compacts through the accepted executor and ignores historical $harness for $provider (#117470)",
    async ({ provider, harness, expectedRuntime }) => {
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () =>
          [
            {
              id: "claude-cli",
              modelProvider: "anthropic",
              config: { command: "claude" },
              bundleMcp: false,
            },
            {
              id: "copilot",
              modelProvider: "github-copilot",
              config: { command: "copilot" },
              bundleMcp: false,
            },
          ] as never,
        resolvePluginSetupCliBackend: () => {
          throw new Error("manual compaction attempted synchronous CLI setup discovery");
        },
      });
      vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
        ok: false,
        compacted: false,
        reason: "runtime ownership probe",
      });

      try {
        const result = await runCompactCommand(
          {
            ...buildCompactParams("/compact", {
              commands: { text: true },
              channels: { whatsapp: { allowFrom: ["*"] } },
            } as OpenClawConfig),
            provider,
            sessionEntry: {
              sessionId: "picker-session",
              updatedAt: Date.now(),
              ...(expectedRuntime
                ? {
                    executionSelection: {
                      state: "accepted",
                      selection: {
                        model: { provider, id: "fixture" },
                        executor: {
                          kind: harness === "codex" ? "harness" : "cli",
                          id: expectedRuntime,
                        },
                      },
                      fallbackPermission: "explicit",
                    },
                  }
                : {}),
              agentHarnessId: harness,
            },
          } as HandleCommandsParams,
          true,
        );

        expect(compactEmbeddedAgentSession, result?.reply?.text).toHaveBeenCalledOnce();
        expect(requireCompactEmbeddedAgentSessionCall().agentHarnessId).toBe(
          expectedRuntime ?? "openclaw",
        );
        expect(
          requireCompactEmbeddedAgentSessionCall().sessionEntry?.executionSelection,
        ).toMatchObject({
          state: "accepted",
          selection: { executor: { id: expectedRuntime ?? "openclaw" } },
        });
      } finally {
        cliBackendsTesting.resetDepsForTest();
        vi.mocked(compactEmbeddedAgentSession).mockReset();
      }
    },
  );

  it("prefers the target session entry when incrementing compaction count", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      compactionKind: "context-engine",
      result: {
        summary: "compacted",
        firstKeptEntryId: "first-kept",
        tokensBefore: 999,
        tokensAfter: 321,
      },
    });

    await runCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionKey: "agent:target:whatsapp:direct:12345",
        sessionEntry: {
          sessionId: "wrapper-session",
          updatedAt: Date.now(),
        },
        sessionStore: {
          "agent:target:whatsapp:direct:12345": {
            sessionId: "target-session",
            updatedAt: Date.now(),
          },
        },
      } as HandleCommandsParams,
      true,
    );

    const call = requireIncrementCompactionCountCall();
    if (!call.sessionEntry) {
      throw new Error("incrementCompactionCount sessionEntry missing");
    }
    expect(call.sessionEntry.sessionId).toBe("target-session");
    expect(call.compactionKind).toBe("context-engine");
    expect(call.tokensAfter).toBe(321);
  });

  it("reports authoritative compaction no-ops without incrementing", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });

    const result = await runCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionEntry: {
          sessionId: "target-session",
          updatedAt: Date.now(),
          totalTokens: 999,
          totalTokensFresh: true,
        },
      } as HandleCommandsParams,
      true,
    );

    expect(vi.mocked(incrementCompactionCount)).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("Compaction skipped");
  });

  it.each([
    {
      owner: "native harness",
      compactionKind: "native-harness" as const,
      details: { completed: true },
    },
    {
      owner: "context engine",
      compactionKind: "context-engine" as const,
      details: undefined,
    },
  ])("counts confirmed $owner compaction without a post-compaction count", async (testCase) => {
    const { details } = testCase;
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      compactionKind: testCase.compactionKind,
      result: {
        summary: "",
        firstKeptEntryId: "",
        tokensBefore: 999,
        ...(details ? { details } : {}),
      },
    });

    const result = await runCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionEntry: {
          sessionId: "native-session",
          updatedAt: Date.now(),
          totalTokens: 999,
          totalTokensFresh: true,
        },
      } as HandleCommandsParams,
      true,
    );

    expect(vi.mocked(incrementCompactionCount)).toHaveBeenCalledOnce();
    expect(requireIncrementCompactionCountCall().compactionKind).toBe(testCase.compactionKind);
    expect(requireIncrementCompactionCountCall().tokensAfter).toBeUndefined();
    expect(vi.mocked(formatContextUsageShort)).toHaveBeenLastCalledWith(null, null);
    expect(result?.reply?.text).toContain("Compaction finished (resulting context unknown) •");
    expect(result?.reply?.text).not.toContain("undefined");
  });

  it("forwards the routed account id from the command context", async () => {
    // Group session keys carry no account identity, so manual /compact has to
    // pass it explicitly or it resolves the root history limit while prompt
    // preparation already used the account limit.
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({ ok: true, compacted: false });
    const params = {
      ...buildCompactParams("/compact", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig),
      provider: "anthropic",
      model: "claude-opus-4-6",
      contextTokens: 200_000,
      sessionEntry: { sessionId: "session", updatedAt: Date.now() },
    } as unknown as HandleCommandsParams;
    params.ctx.AccountId = "work";
    params.ctx.ConversationRoutePeerId = "peer";
    params.ctx.ChatType = "direct";

    await runCompactCommand(params, true);

    expect(requireCompactEmbeddedAgentSessionCall().agentAccountId).toBe("work");
    expect(requireCompactEmbeddedAgentSessionCall()).toMatchObject({
      conversationRoutePeerId: "peer",
      chatType: "direct",
    });
  });
});
