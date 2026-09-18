// Tests get-reply behavior while probing an auto-fallback primary model.
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { resolveModelRefFromString } from "../../agents/model-selection-shared.js";
import { createSessionModelCatalogFixture } from "../../agents/test-helpers/session-model-catalog.test-support.js";
import type { ModelDefinitionConfig, OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type * as ReplyDirectives from "./get-reply-directives.js";
import { withFastReplyConfig } from "./get-reply-fast-path.test-support.js";
import {
  buildGetReplyCtx,
  createGetReplySessionState,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
}));

registerGetReplyRuntimeOverrides(mocks);

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadManifestModelCatalog: vi.fn(() => []),
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogSnapshot: vi.fn(async () => ({
    entries: [],
    routeVariants: [],
    authoritative: true,
  })),
}));

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let resolveDefaultModelMock: typeof import("./directive-handling.defaults.js").resolveDefaultModel;
let runPreparedReplyMock: typeof import("./get-reply-run.js").runPreparedReply;
let resolveModelRefFromStringMock: typeof import("../../agents/model-selection.js").resolveModelRefFromString;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ resolveDefaultModel: resolveDefaultModelMock } =
    await import("./directive-handling.defaults.js"));
  ({ runPreparedReply: runPreparedReplyMock } = await import("./get-reply-run.js"));
  ({ resolveModelRefFromString: resolveModelRefFromStringMock } =
    await import("../../agents/model-selection.js"));
}

function emptyAliasIndex() {
  return { byAlias: new Map(), byKey: new Map() };
}

function makeTestModel(id: string, name: string, reasoning: boolean): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

function makeReasoningModelConfig(): OpenClawConfig {
  return withFastReplyConfig({
    agents: {
      defaults: {
        model: "openai/gpt-5.5",
        workspace: "/tmp/workspace",
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.test/v1",
          models: [makeTestModel("gpt-5.5", "GPT-5.5", true)],
        },
        anthropic: {
          baseUrl: "https://api.anthropic.test/v1",
          models: [makeTestModel("claude-fallback", "Claude Fallback", false)],
        },
      },
    },
  } satisfies OpenClawConfig);
}

function makePerAgentThinkingOffConfig(): OpenClawConfig {
  return withFastReplyConfig({
    agents: {
      defaults: {
        model: "openai/gpt-5.5",
        workspace: "/tmp/workspace",
      },
      list: [
        {
          id: "main",
          thinkingDefault: "off",
        },
      ],
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.test/v1",
          models: [makeTestModel("gpt-5.5", "GPT-5.5", true)],
        },
        anthropic: {
          baseUrl: "https://api.anthropic.test/v1",
          models: [makeTestModel("claude-fallback", "Claude Fallback", false)],
        },
      },
    },
  } satisfies OpenClawConfig);
}

function makePerModelThinkingConfig(
  thinking: false | "disabled" | "none" | "high",
): OpenClawConfig {
  return withFastReplyConfig({
    agents: {
      defaults: {
        model: "openai/gpt-5.5",
        workspace: "/tmp/workspace",
        models: {
          "openai/gpt-5.5": {
            params: { thinking },
          },
        },
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.test/v1",
          models: [makeTestModel("gpt-5.5", "GPT-5.5", true)],
        },
        anthropic: {
          baseUrl: "https://api.anthropic.test/v1",
          models: [makeTestModel("claude-fallback", "Claude Fallback", false)],
        },
      },
    },
  } satisfies OpenClawConfig);
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function mockAutoFallbackSession(
  params: { modelSelectionLocked?: boolean; fallbackPermission?: "configured" | "explicit" } = {},
) {
  const sessionKey = "agent:main:telegram:123";
  const sessionEntry: SessionEntry = {
    sessionId: "fallback-session",
    updatedAt: Date.now(),
    executionSelection: {
      state: "accepted",
      fallbackPermission: params.fallbackPermission ?? "configured",
      selection: {
        model: params.modelSelectionLocked
          ? { provider: "anthropic", id: "claude-fallback" }
          : { provider: "openai", id: "gpt-5.5" },
        executor: { kind: "harness", id: "openclaw" },
      },
    },
    modelProvider: "anthropic",
    model: "claude-fallback",
    modelSelectionLocked: params.modelSelectionLocked,
  };
  // Reply-turn admission re-reads the canonical SQLite store before starting
  // work; seed a real per-test store so the guard sees the same session the
  // mocks describe instead of depending on leftover host state.
  const storePath = path.join(tempDirs.make("auto-fallback-store"), "sessions.json");
  replaceSessionEntrySync({ storePath, sessionKey }, sessionEntry);
  mocks.initSessionState.mockResolvedValue(
    createGetReplySessionState({
      sessionKey,
      sessionId: sessionEntry.sessionId,
      sessionCtx: buildGetReplyCtx(),
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      storePath,
      triggerBodyNormalized: "hello",
      bodyStripped: "hello",
    }),
  );
  return { sessionKey, storePath };
}

async function resolveFixtureDirectives(
  params: Parameters<typeof ReplyDirectives.resolveReplyDirectives>[0],
) {
  const { resolveReplyDirectives } = await vi.importActual<typeof ReplyDirectives>(
    "./get-reply-directives.js",
  );
  const catalog: ModelCatalogSnapshot = {
    entries: Object.entries(params.cfg.models?.providers ?? {}).flatMap(([provider, config]) =>
      config.models.map((model) => ({
        ...model,
        provider,
        api: provider === "anthropic" ? "anthropic-messages" : "openai-responses",
        baseUrl: config.baseUrl,
      })),
    ),
    routeVariants: [],
    authoritative: true,
  };
  createSessionModelCatalogFixture().publish({
    config: params.cfg,
    agentId: params.agentId,
    catalog,
    profiles: {
      "openai:default": { type: "api_key", provider: "openai", key: "synthetic-test-key" },
      "openai:metered": { type: "api_key", provider: "openai", key: "synthetic-test-key" },
      "anthropic:default": { type: "api_key", provider: "anthropic", key: "synthetic-test-key" },
    },
  });
  return resolveReplyDirectives({ ...params, preparedModelCatalog: catalog });
}

describe("getReplyFromConfig accepted selection after temporary fallback", () => {
  beforeAll(async () => {
    await loadGetReplyRuntimeForTest();
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    delete process.env.OPENCLAW_TEST_FAST;
    mocks.resolveReplyDirectives.mockReset().mockImplementation(resolveFixtureDirectives);
    mocks.handleInlineActions.mockReset();
    mocks.initSessionState.mockReset();
    vi.mocked(resolveDefaultModelMock).mockReset();
    vi.mocked(runPreparedReplyMock).mockReset();
    vi.mocked(resolveModelRefFromStringMock).mockImplementation(resolveModelRefFromString);

    vi.mocked(resolveDefaultModelMock).mockReturnValue({
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: emptyAliasIndex(),
    });
    mocks.handleInlineActions.mockImplementation(async (params: unknown) => ({
      kind: "continue",
      directives: (params as { directives?: unknown }).directives ?? {},
      cleanedBody: (params as { cleanedBody?: string }).cleanedBody ?? "hello",
      abortedLastRun: false,
    }));
    vi.mocked(runPreparedReplyMock).mockResolvedValue({ text: "ok" });
  });

  it("does not probe the primary model for a model-locked session", async () => {
    const { sessionKey, storePath } = mockAutoFallbackSession({ modelSelectionLocked: true });

    await expect(
      getReplyFromConfig(buildGetReplyCtx(), undefined, makeReasoningModelConfig()),
    ).resolves.toEqual({ text: "ok" });

    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
    const runParams = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
    expect(runParams?.provider).toBe("anthropic");
    expect(runParams?.model).toBe("claude-fallback");
    expect(loadSessionEntry({ storePath, sessionKey })?.executionSelection).toMatchObject({
      state: "accepted",
      selection: { model: { provider: "anthropic", id: "claude-fallback" } },
    });
  });

  it("suppresses heartbeat model overrides for a model-locked session", async () => {
    mockAutoFallbackSession({ modelSelectionLocked: true });

    await expect(
      getReplyFromConfig(
        buildGetReplyCtx(),
        { isHeartbeat: true, heartbeatModelOverride: "openai/gpt-5.5@openai:metered" },
        makeReasoningModelConfig(),
      ),
    ).resolves.toEqual({ text: "ok" });

    expect(mocks.resolveReplyDirectives).toHaveBeenCalledOnce();
    expect(mocks.resolveReplyDirectives.mock.calls[0]?.[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-fallback",
      hasResolvedHeartbeatModelOverride: false,
    });
    expect(
      vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0].modelState.auth?.selection,
    ).toMatchObject({
      profileId: "anthropic:default",
      source: "auto",
    });
  });

  it("keeps an explicit heartbeat profile on its turn without persisting it into chat", async () => {
    const { sessionKey, storePath } = mockAutoFallbackSession();
    const cfg = makeReasoningModelConfig();
    cfg.auth = { order: { openai: ["openai:default", "openai:metered"] } };
    await getReplyFromConfig(
      buildGetReplyCtx(),
      {
        isHeartbeat: true,
        heartbeatModelOverride: "openai/gpt-5.5@openai:metered",
      },
      cfg,
    );
    expect(vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      modelState: { auth: { selection: { profileId: "openai:metered", source: "user" } } },
    });
    expect(loadSessionEntry({ storePath, sessionKey })?.authProfileOverride).toBeUndefined();
    await getReplyFromConfig(buildGetReplyCtx(), undefined, cfg);
    expect(
      vi.mocked(runPreparedReplyMock).mock.calls[1]?.[0].modelState.auth?.selection,
    ).toMatchObject({
      profileId: "openai:default",
      source: "auto",
    });
  });

  it("does not re-enable default reasoning for explicit thinking-off accepted-model turns", async () => {
    mockAutoFallbackSession();

    await expect(
      getReplyFromConfig(
        buildGetReplyCtx(),
        { thinkingLevelOverride: "off" },
        makeReasoningModelConfig(),
      ),
    ).resolves.toEqual({ text: "ok" });

    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
    const runParams = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
    expect(runParams?.provider).toBe("openai");
    expect(runParams?.model).toBe("gpt-5.5");
    expect(runParams?.resolvedThinkLevel).toBe("off");
    expect(runParams?.resolvedReasoningLevel).toBe("off");
  });

  it("uses primary model thinking defaults for invalid thinking override accepted-model turns", async () => {
    mockAutoFallbackSession();

    await expect(
      getReplyFromConfig(
        buildGetReplyCtx(),
        { thinkingLevelOverride: "not-a-level" },
        makeReasoningModelConfig(),
      ),
    ).resolves.toEqual({ text: "ok" });

    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
    const runParams = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
    expect(runParams?.provider).toBe("openai");
    expect(runParams?.model).toBe("gpt-5.5");
    expect(runParams?.resolvedThinkLevel).toBe("medium");
    expect(runParams?.resolvedReasoningLevel).toBe("off");
  });

  it("rejects a denied explicit selection without running or replacing it with a default", async () => {
    const { sessionKey, storePath } = mockAutoFallbackSession({ fallbackPermission: "explicit" });
    const before = loadSessionEntry({ storePath, sessionKey })?.executionSelection;
    const cfg = makeReasoningModelConfig();
    cfg.agents = {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models: { "openai/gpt-5.5": { params: { thinking: "high" } } },
        modelPolicy: { allow: ["anthropic/*"] },
      },
    };
    await expect(getReplyFromConfig(buildGetReplyCtx(), undefined, cfg)).resolves.toMatchObject({
      isError: true,
    });

    expect(vi.mocked(runPreparedReplyMock)).not.toHaveBeenCalled();
    expect(loadSessionEntry({ storePath, sessionKey })?.executionSelection).toEqual(before);

    cfg.agents = {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        modelPolicy: { allow: ["openai/*", "anthropic/*"] },
      },
    };
    await expect(getReplyFromConfig(buildGetReplyCtx(), undefined, cfg)).resolves.toEqual({
      text: "ok",
    });
    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
    expect(vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
    });
    expect(loadSessionEntry({ storePath, sessionKey })?.executionSelection).toEqual(before);
  });

  it("does not re-enable default reasoning for per-agent thinking-off accepted-model turns", async () => {
    mockAutoFallbackSession();

    await expect(
      getReplyFromConfig(buildGetReplyCtx(), undefined, makePerAgentThinkingOffConfig()),
    ).resolves.toEqual({ text: "ok" });

    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
    const runParams = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
    expect(runParams?.provider).toBe("openai");
    expect(runParams?.model).toBe("gpt-5.5");
    expect(runParams?.resolvedThinkLevel).toBe("off");
    expect(runParams?.resolvedReasoningLevel).toBe("off");
  });

  it.each([false, "disabled", "none"] as const)(
    "does not re-enable default reasoning for per-model thinking-off accepted-model turns (%s)",
    async (thinking) => {
      mockAutoFallbackSession();

      await expect(
        getReplyFromConfig(buildGetReplyCtx(), undefined, makePerModelThinkingConfig(thinking)),
      ).resolves.toEqual({ text: "ok" });

      expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
      const runParams = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
      expect(runParams?.provider).toBe("openai");
      expect(runParams?.model).toBe("gpt-5.5");
      expect(runParams?.resolvedThinkLevel).toBe("off");
      expect(runParams?.resolvedReasoningLevel).toBe("off");
    },
  );

  it("recomputes per-model thinking defaults for accepted-model turns", async () => {
    mockAutoFallbackSession();

    await expect(
      getReplyFromConfig(buildGetReplyCtx(), undefined, makePerModelThinkingConfig("high")),
    ).resolves.toEqual({ text: "ok" });

    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
    const runParams = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
    expect(runParams?.provider).toBe("openai");
    expect(runParams?.model).toBe("gpt-5.5");
    expect(runParams?.resolvedThinkLevel).toBe("high");
    expect(runParams?.resolvedReasoningLevel).toBe("off");
  });
});
