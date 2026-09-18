import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import * as runtimeChoice from "../../agents/model-runtime-choice.js";
import * as preparedModelCatalog from "../../agents/prepared-model-catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { commitStoredSessionExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import {
  buildNativeCommandCtx,
  buildStatusReplyMock,
  createTypingController,
  handleCommandsMock,
  migratedSessionEntry,
  runTestNativeSlashFastReply,
  runtimeCliBackends,
  selectedSessionEntry,
  useNativeSlashFastReplyFixture,
  useRealNativeCompactCommand,
} from "./get-reply-native-slash-fast-path.test-support.js";

describe("native slash model selection", () => {
  const { tempDirs, resolveNativeDirectiveCommand } = useNativeSlashFastReplyFixture();

  it("reports locked deferred compact without evaluating, compacting or replacing selection", async () => {
    const { compact, abort, wait } = await useRealNativeCompactCommand();
    const storePath = path.join(tempDirs.make("openclaw-native-locked-empty-"), "sessions.json");
    const sessionKey = "agent:main:main";
    const entry: SessionEntry = {
      sessionId: "locked-deferred",
      updatedAt: 1,
      modelSelectionLocked: true,
    };
    commitStoredSessionExecutionSelection(entry, {
      state: "deferred",
      request: {},
      fallbackPermission: "configured",
    });
    await replaceSessionEntry({ agentId: "main", sessionKey, storePath }, entry);
    const before = loadExactSessionEntry({ agentId: "main", sessionKey, storePath })?.entry;
    expect(before?.executionSelection?.state).toBe("deferred");
    const evaluate = vi.spyOn(runtimeChoice, "evaluatePublishedModelRuntimeChoice");
    const typing = createTypingController();
    const result = await runTestNativeSlashFastReply(
      {
        ctx: buildNativeCommandCtx("/compact", { CommandTargetSessionKey: sessionKey }),
        cfg: markCompleteReplyConfig({ session: { store: storePath } }),
        agentId: "main",
        commandAuthorized: true,
        typing,
      },
      false,
    );
    expect(result).toMatchObject({
      handled: true,
      reply: { text: "⚙️ Compaction unavailable: Model selection is locked for this session." },
    });
    expect(typing.cleanup).toHaveBeenCalledOnce();
    expect(evaluate).not.toHaveBeenCalled();
    expect(handleCommandsMock).toHaveBeenCalledOnce();
    expect(compact).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(loadExactSessionEntry({ agentId: "main", sessionKey, storePath })?.entry).toMatchObject({
      modelSelectionLocked: true,
      executionSelection: before?.executionSelection,
    });
  });

  it.each([
    { model: "openai/gpt-5.5", options: "--runtime codex -s" },
    { model: "default", options: "-s --runtime codex" },
  ])("applies native /model $model with explicit runtime options", async ({ model, options }) => {
    const storePath = path.join(tempDirs.make("openclaw-native-model-options-"), "sessions.json");
    const { result } = await resolveNativeDirectiveCommand(
      `/model ${model} ${options}`,
      {
        session: { store: storePath },
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
          },
        },
      },
      { shouldContinue: true },
    );

    expect(result).toMatchObject({ handled: true });
    const sessionEntry = loadExactSessionEntry({
      sessionKey: "agent:main:telegram:123",
      storePath,
    })?.entry;
    expect(sessionEntry).toMatchObject({
      executionSelection: {
        state: "accepted",
        selection: {
          model: { provider: "openai", id: "gpt-5.5" },
          executor: { kind: "harness", id: "codex" },
        },
      },
    });
  });

  it("applies native model selections using the admitted catalog without rediscovery", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    const storePath = path.join(tempDirs.make("openclaw-native-prepared-model-"), "sessions.json");
    vi.mocked(preparedModelCatalog.loadPreparedModelCatalogSnapshot).mockRejectedValue(
      new Error("native selection must not rediscover the prepared catalog"),
    );
    const { result } = await resolveNativeDirectiveCommand(
      "/model ollama/picker-secondary -s",
      { session: { store: storePath } },
      { shouldContinue: true },
      {
        entries: [
          {
            provider: "ollama",
            id: "picker-secondary",
            name: "Picker secondary",
            api: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            reasoning: false,
            contextWindow: 32768,
          },
        ],
        routeVariants: [],
      },
    );

    expect(result).toMatchObject({
      handled: true,
      reply: { text: "Model changed to Picker secondary. Still using OpenClaw." },
    });
    expect(
      loadExactSessionEntry({ sessionKey: "agent:main:telegram:123", storePath })?.entry,
    ).toMatchObject({
      executionSelection: {
        state: "accepted",
        selection: {
          model: { provider: "ollama", id: "picker-secondary" },
          executor: { kind: "harness", id: "openclaw" },
        },
      },
    });
    expect(preparedModelCatalog.loadPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(preparedModelCatalog.loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
  });

  it("renders native status thinking for the pinned model and target agent", async () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => runtimeCliBackends,
      resolvePluginSetupCliBackend: ({ backend }) => {
        if (backend === "fixture" || backend === "openai") {
          return undefined;
        }
        throw new Error(`unexpected native status CLI backend lookup: ${backend}`);
      },
      resolvePluginSetupRegistry: () => {
        throw new Error("native status must not load the full CLI setup registry");
      },
    });
    const { buildStatusReplyParts } = await import("../../status/status-text.js");
    buildStatusReplyMock.mockImplementation(
      async (params: Parameters<typeof buildStatusReplyParts>[0]) =>
        buildStatusReplyParts({
          ...params,
          statusChannel: "telegram",
          resolvedHarness: "openclaw",
          pluginHealthLineOverride: "Plugins: test",
          taskLineOverride: "",
          skipDefaultTaskLookup: true,
          modelAuthOverride: "api-key",
          activeModelAuthOverride: "api-key",
          includeTranscriptUsage: false,
        }),
    );
    vi.spyOn(preparedModelCatalog, "readPreparedModelCatalog").mockResolvedValue([
      { provider: "openai", id: "gpt-5.5", name: "Default model", reasoning: false },
      { provider: "fixture", id: "selected-model", name: "Selected model", reasoning: true },
    ]);
    const storePath = path.join(tempDirs.make("openclaw-native-status-thinking-"), "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      selectedSessionEntry(
        { sessionId: "pinned-model", updatedAt: Date.now() },
        "fixture",
        "selected-model",
      ),
    );

    const { result } = await resolveNativeDirectiveCommand("/status", {
      session: { store: storePath },
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          models: {
            "openai/gpt-5.5": { params: { thinking: "off" } },
            "fixture/selected-model": { params: { thinking: "low" } },
          },
        },
        entries: {
          main: { models: { "fixture/selected-model": { params: { thinking: "high" } } } },
        },
      },
    });

    expect(result).toMatchObject({
      handled: true,
      reply: { text: expect.stringContaining("think high") },
    });
    expect(result).toMatchObject({
      reply: { text: expect.stringContaining("fixture/selected-model") },
    });
    const entry = loadExactSessionEntry({ sessionKey, storePath })?.entry;
    expect(entry).toMatchObject({
      executionSelection: {
        state: "accepted",
        selection: {
          model: { provider: "fixture", id: "selected-model" },
          executor: { kind: "harness", id: "openclaw" },
        },
      },
    });
    expect(entry?.thinkingLevel).toBeUndefined();
  });

  it("marks native /compact terminal replies for delivery under message_tool_only (#90185)", async () => {
    const { compact } = await useRealNativeCompactCommand();
    const result = await runTestNativeSlashFastReply({
      ctx: buildNativeCommandCtx("/compact", {
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: "telegram:slash:123",
        CommandTargetSessionKey: "agent:main:telegram:123",
      }),
      cfg: markCompleteReplyConfig({
        session: {
          store: path.join(tempDirs.make("openclaw-native-compact-delivery-"), "sessions.json"),
        },
      }),
      agentId: "main",
      commandAuthorized: true,
      typing: createTypingController(),
    });
    expect(result).toMatchObject({
      handled: true,
      reply: { text: expect.stringContaining("Compaction skipped: session is already compacted") },
    });
    expect(compact).toHaveBeenCalledOnce();
    if (!result.handled || !result.reply || Array.isArray(result.reply)) {
      throw new Error("expected single handled reply payload");
    }
    expect(getReplyPayloadMetadata(result.reply)?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it("resolves the selected model context for native compact", async () => {
    const { compact } = await useRealNativeCompactCommand();

    const storePath = path.join(tempDirs.make("openclaw-native-override-"), "sessions.json");
    await replaceSessionEntry(
      { agentId: "main", sessionKey: "agent:main:main", storePath },
      selectedSessionEntry(
        { sessionId: "fable-session", updatedAt: Date.now(), thinkingLevel: "off" },
        "anthropic",
        "claude-fable-5",
        { kind: "cli", id: "claude-cli" },
      ),
    );

    const typing = createTypingController();
    const result = await runTestNativeSlashFastReply({
      ctx: buildNativeCommandCtx("/compact", {
        SessionKey: "telegram:slash:123",
        CommandTargetSessionKey: "agent:main:main",
      }),
      cfg: markCompleteReplyConfig(
        {
          session: { store: storePath },
        } as OpenClawConfig,
        { runtimeMode: "full" },
      ),
      agentId: "main",
      agentCfg: undefined,
      commandAuthorized: true,
      typing,
    });

    expect(result.handled).toBe(true);
    expect(handleCommandsMock).toHaveBeenCalledOnce();
    expect(compact).toHaveBeenCalledOnce();
    expect(compact.mock.calls[0]?.[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-fable-5",
      contextTokenBudget: 1_000_000,
      agentHarnessId: "claude-cli",
      thinkLevel: "off",
    });
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    { source: "auto" as const, locked: false, expectedProvider: "anthropic" },
    { source: "auto" as const, locked: false, fallbackOrigin: true, expectedProvider: "openai" },
    { source: "auto" as const, locked: true, expectedProvider: "anthropic" },
    { source: undefined, locked: false, legacyAuto: true, expectedProvider: "openai" },
    {
      source: "auto" as const,
      locked: false,
      selfOrigin: true,
      targetAgentId: "subagent",
      expectedProvider: "anthropic",
    },
    {
      source: "user" as const,
      locked: false,
      transportAuthorized: false,
      approvedByPolicy: true,
      expectedProvider: "anthropic",
    },
    {
      source: "user" as const,
      locked: false,
      overrideProvider: "claude-cli",
      hasBoundCli: true,
      expectedProvider: "anthropic",
    },
    {
      source: "user" as const,
      locked: false,
      allowed: ["openai/*"],
      agentAllowed: ["anthropic/legacy-fast-model", "anthropic/claude-sonnet-4-6"],
      targetAgentId: "research",
      overrideModel: "claude-sonnet-4-6",
      resolvedModel: "claude-sonnet-4-6",
      expectedProvider: "anthropic",
    },
    {
      source: "user" as const,
      locked: false,
      allowed: ["openai/*"],
      forbidden: true,
      expectedProvider: "openai",
    },
    {
      source: "user" as const,
      locked: false,
      allowed: ["anthropic/*"],
      expectedProvider: "anthropic",
    },
    {
      source: "user" as const,
      locked: true,
      allowed: ["openai/*"],
      expectedProvider: "anthropic",
    },
    {
      source: "user" as const,
      locked: false,
      allowed: ["anthropic/*"],
      agentAllowed: ["openai/*"],
      forbidden: true,
      expectedProvider: "openai",
    },
    {
      source: "user" as const,
      locked: false,
      allowed: ["anthropic/claude-fable-5"],
      overrideProvider: "openai",
      overrideModel: "gpt-5.5",
      expectedProvider: "openai",
      expectedContextTokens: 200_000,
    },
    {
      source: "user" as const,
      locked: false,
      allowed: ["openai/*"],
      agentAllowed: ["anthropic/claude-fable-5"],
      targetAgentId: "target",
      agentCap: 120_000,
      overrideProvider: "openai",
      overrideModel: "gpt-5.5",
      expectedProvider: "openai",
      expectedContextTokens: 200_000,
    },
  ])(
    "prepares migrated model intent with source=$source, locked=$locked and origin=$fallbackOrigin",
    async (testCase) => {
      const { source, locked, expectedProvider } = testCase;
      const transportAuthorized =
        ("transportAuthorized" in testCase ? testCase.transportAuthorized : undefined) ?? true;
      const { compact, abort, wait } = await useRealNativeCompactCommand();
      const targetAgentId =
        ("targetAgentId" in testCase ? testCase.targetAgentId : undefined) ?? "main";
      const resolvedModel = "resolvedModel" in testCase ? testCase.resolvedModel : undefined;
      const targetSessionKey = `agent:${targetAgentId}:main`;
      const storePath = path.join(tempDirs.make("openclaw-native-source-"), "sessions.json");
      await replaceSessionEntry(
        { agentId: targetAgentId, sessionKey: targetSessionKey, storePath },
        migratedSessionEntry({
          sessionId: "selected-session",
          updatedAt: Date.now(),
          providerOverride:
            "overrideProvider" in testCase ? testCase.overrideProvider : "anthropic",
          modelOverride: "overrideModel" in testCase ? testCase.overrideModel : "claude-fable-5",
          modelOverrideSource: source,
          modelSelectionLocked: locked,
          contextTokens: 1_000_000,
          thinkingLevel: "off",
          ...("legacyAuto" in testCase || "selfOrigin" in testCase || "fallbackOrigin" in testCase
            ? {
                modelOverrideFallbackOriginProvider:
                  "selfOrigin" in testCase ? "anthropic" : "openai",
                modelOverrideFallbackOriginModel:
                  "selfOrigin" in testCase ? "claude-fable-5" : "gpt-5.5",
              }
            : {}),
          ...("hasBoundCli" in testCase
            ? {
                agentHarnessId: "claude-cli",
                cliSessionBindings: {
                  "claude-cli": { sessionId: "native-claude-session", forceReuse: true },
                },
              }
            : {}),
        }),
      );

      const before = loadExactSessionEntry({
        agentId: targetAgentId,
        sessionKey: targetSessionKey,
        storePath,
      })?.entry;
      const pending = runTestNativeSlashFastReply({
        ctx: buildNativeCommandCtx("/compact", {
          CommandAuthorized: transportAuthorized,
          Provider: "telegram",
          Surface: "telegram",
          From: "telegram:approved-sender",
          SenderId: "approved-sender",
          SessionKey: "telegram:slash:123",
          CommandTargetSessionKey: targetSessionKey,
        }),
        cfg: markCompleteReplyConfig(
          {
            session: { store: storePath },
            ...("approvedByPolicy" in testCase
              ? { commands: { allowFrom: { "*": ["approved-sender"] } } }
              : {}),
            ...("allowed" in testCase
              ? {
                  agents: {
                    defaults: {
                      model: { primary: "openai/gpt-5.5" },
                      modelPolicy: { allow: testCase.allowed },
                    },
                    ...("agentAllowed" in testCase
                      ? {
                          list: [
                            {
                              id: targetAgentId,
                              modelPolicy: { allow: testCase.agentAllowed },
                              ...("agentCap" in testCase
                                ? { contextTokens: testCase.agentCap }
                                : {}),
                              ...(resolvedModel !== undefined
                                ? {
                                    models: {
                                      [`anthropic/${resolvedModel}`]: {
                                        alias: "legacy-fast-model",
                                      },
                                    },
                                  }
                                : {}),
                            },
                          ],
                        }
                      : {}),
                  },
                }
              : {}),
          } as OpenClawConfig,
          { runtimeMode: "full" },
        ),
        agentId: targetAgentId,
        commandAuthorized: transportAuthorized,
        aliasIndex: {
          byKey: new Map(),
          byAlias: new Map(
            resolvedModel !== undefined
              ? [
                  [
                    "legacy-fast-model",
                    {
                      alias: "legacy-fast-model",
                      ref: { provider: "anthropic", model: resolvedModel },
                    },
                  ],
                ]
              : [],
          ),
        },
        typing: createTypingController(),
      });

      if ("forbidden" in testCase) {
        await expect(pending).resolves.toMatchObject({
          handled: true,
          reply: { text: expect.stringContaining("This model is not available for this agent") },
        });
        expect(handleCommandsMock).toHaveBeenCalledOnce();
        expect(compact).not.toHaveBeenCalled();
        expect(abort).not.toHaveBeenCalled();
        expect(wait).not.toHaveBeenCalled();
        expect(
          loadExactSessionEntry({ agentId: targetAgentId, sessionKey: targetSessionKey, storePath })
            ?.entry.executionSelection,
        ).toEqual(before?.executionSelection);
        return;
      }
      const result = await pending;
      expect(result.handled).toBe(true);
      expect(compact).toHaveBeenCalledOnce();
      expect(compact.mock.calls[0]?.[0]).toMatchObject({
        provider: expectedProvider,
        model:
          resolvedModel !== undefined
            ? resolvedModel
            : expectedProvider === "anthropic"
              ? "claude-fable-5"
              : "gpt-5.5",
        contextTokenBudget:
          "expectedContextTokens" in testCase
            ? testCase.expectedContextTokens
            : expectedProvider === "anthropic"
              ? 1_000_000
              : 200_000,
      });
      const selectedModel =
        resolvedModel ?? (expectedProvider === "anthropic" ? "claude-fable-5" : "gpt-5.5");
      const stored = loadExactSessionEntry({
        agentId: targetAgentId,
        sessionKey: targetSessionKey,
        storePath,
      })?.entry;
      expect(stored?.executionSelection).toMatchObject({
        state: "accepted",
        selection: {
          model: { provider: expectedProvider, id: selectedModel },
          executor:
            "hasBoundCli" in testCase
              ? { kind: "cli", id: "claude-cli" }
              : { kind: "harness", id: "openclaw" },
        },
        fallbackPermission:
          source === "auto" || "legacyAuto" in testCase ? "configured" : "explicit",
      });
      expect(stored?.modelSelectionLocked).toBe(before?.modelSelectionLocked);
      if ("hasBoundCli" in testCase) {
        expect(stored?.cliSessionBindings).toEqual(before?.cliSessionBindings);
      }
    },
  );

  it("initializes configured selection without treating observed history as intent", async () => {
    const storePath = path.join(tempDirs.make("openclaw-native-history-"), "sessions.json");
    const sessionKey = "agent:main:main";
    const observed = {
      modelProvider: "anthropic",
      model: "claude-fable-5",
      agentHarnessId: "claude-cli",
    };
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "history-only",
        updatedAt: 1,
        ...observed,
      },
    );
    const { compact } = await useRealNativeCompactCommand();
    const result = await runTestNativeSlashFastReply({
      ctx: buildNativeCommandCtx("/compact", { CommandTargetSessionKey: sessionKey }),
      cfg: markCompleteReplyConfig({ session: { store: storePath } }, { runtimeMode: "full" }),
      agentId: "main",
      commandAuthorized: true,
      typing: createTypingController(),
    });
    expect(result).toMatchObject({
      handled: true,
      reply: { text: expect.stringContaining("Compaction skipped") },
    });
    expect(handleCommandsMock).toHaveBeenCalledOnce();
    expect(compact).toHaveBeenCalledOnce();
    expect(compact.mock.calls[0]?.[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      agentHarnessId: "openclaw",
      contextTokenBudget: 200_000,
    });
    expect(loadExactSessionEntry({ agentId: "main", sessionKey, storePath })?.entry).toMatchObject({
      ...observed,
      executionSelection: {
        state: "accepted",
        selection: {
          model: { provider: "openai", id: "gpt-5.5" },
          executor: { kind: "harness", id: "openclaw" },
        },
        fallbackPermission: "configured",
      },
    });
  });

  it.each([
    { selection: "user override", source: "user" as const },
    { selection: "automatic fallback", source: "auto" as const },
    { selection: "channel override", source: undefined },
  ])("preserves canonical native /status $selection", async (testCase) => {
    vi.spyOn(preparedModelCatalog, "readPreparedModelCatalog").mockResolvedValueOnce([]);
    const targetSessionKey = "agent:main:main";
    const storePath = path.join(tempDirs.make("openclaw-native-status-"), "sessions.json");
    await replaceSessionEntry(
      { agentId: "main", sessionKey: targetSessionKey, storePath },
      {
        sessionId: "status-session",
        updatedAt: Date.now(),
        contextTokens: 1_000_000,
        ...(testCase.source
          ? migratedSessionEntry({
              sessionId: "status-session",
              updatedAt: Date.now(),
              providerOverride: "anthropic",
              modelOverride: "claude-fable-5",
              modelOverrideSource: testCase.source,
              ...(testCase.source === "auto"
                ? {
                    modelOverrideFallbackOriginProvider: "openai",
                    modelOverrideFallbackOriginModel: "gpt-5.5",
                    modelProvider: "openai",
                    model: "gpt-5.5",
                  }
                : {}),
            })
          : {
              delivery: normalizeSessionDeliveryState({ context: { channel: "telegram" } }),
              groupId: "123",
            }),
      },
    );

    const result = await runTestNativeSlashFastReply({
      ctx: buildNativeCommandCtx("/status", {
        SessionKey: "telegram:slash:123",
        CommandTargetSessionKey: targetSessionKey,
      }),
      cfg: markCompleteReplyConfig({
        session: { store: storePath },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            modelPolicy: { allow: ["openai/*"] },
          },
        },
        channels: { modelByChannel: { telegram: { "123": "openai/gpt-5.5" } } },
      } as OpenClawConfig),
      agentId: "main",
      commandAuthorized: true,
      typing: createTypingController(),
    });

    const statusCall = buildStatusReplyMock.mock.calls[0]?.[0];
    expect(statusCall).toMatchObject({ provider: "openai", model: "gpt-5.5" });
    if (testCase.source) {
      expect(statusCall.sessionEntry.executionSelection).toEqual(
        loadExactSessionEntry({ agentId: "main", sessionKey: targetSessionKey, storePath })?.entry
          .executionSelection,
      );
    } else {
      expect(statusCall.sessionEntry).not.toHaveProperty("executionSelection");
    }
    expect(result).toMatchObject({ reply: { text: "selected model status" } });
  });
});
