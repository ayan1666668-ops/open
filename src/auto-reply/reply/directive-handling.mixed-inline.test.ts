import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as authProfileStore from "../../agents/auth-profiles/store.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { loadProviderScopedThinkingCatalog } from "../../agents/model-catalog.runtime.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import { resolveThinkingDefault } from "../../agents/model-thinking-default.js";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import { loadNativeHarnessFixture } from "../../agents/test-helpers/bundled-native-harness.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../../sessions/session-lifecycle-events.js";
import {
  applyMixedDirectives,
  createSessionEntry,
  createStoredSessionFixture,
  createSelectedSessionEntry,
} from "./directive-handling.mixed-inline.test-helpers.js";
import { resolveReplyDirectiveRouting } from "./get-reply-directives-routing.js";
import { resolveReplyExecOverrides } from "./get-reply-exec-overrides.js";
import { refreshQueuedFollowupSession } from "./queue.js";
import * as sessionPersistence from "./session-entry-persistence.js";
import { buildTestCtx } from "./test-ctx.js";

const persistReplySessionEntry = sessionPersistence.persistReplySessionEntry;
let persist: MockInstance<typeof persistReplySessionEntry>;

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

vi.mock("../../agents/sticky-model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/sticky-model-selection.js")>()),
  persistStickyModelSelectionBestEffort: vi.fn(),
}));

vi.mock("../../gateway/session-patch-hooks.js", () => ({
  triggerSessionPatchHook: vi.fn(),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./queue.js", () => ({
  refreshQueuedFollowupSession: vi.fn(),
}));

describe("mixed inline directives", () => {
  let lifecycleEvents: SessionLifecycleEvent[];
  let unsubscribeLifecycle: () => void;

  let registryBefore: ReturnType<typeof captureActivePluginRegistrySnapshot>;

  beforeEach(async () => {
    registryBefore = captureActivePluginRegistrySnapshot();
    setActivePluginRegistry(createEmptyPluginRegistry());
    const { harness } = await loadNativeHarnessFixture({ label: "Test native app" });
    registerAgentHarness(harness);
    lifecycleEvents = [];
    unsubscribeLifecycle = onSessionLifecycleEvent((event) => lifecycleEvents.push(event));
    vi.clearAllMocks();
    vi.mocked(loadProviderScopedThinkingCatalog).mockReset().mockResolvedValue([]);
    vi.mocked(persistStickyModelSelectionBestEffort).mockReturnValue("requested");
    persist = vi.spyOn(sessionPersistence, "persistReplySessionEntry");
  });

  afterEach(() => {
    unsubscribeLifecycle();
    restoreActivePluginRegistrySnapshot(registryBefore);
    vi.restoreAllMocks();
  });
  it("continues mixed content with the selected route's context and thinking metadata", async () => {
    const selected: ModelCatalogEntry = {
      provider: "fixture-route",
      id: "reasoner",
      name: "Reasoner",
      api: "openai-responses",
      contextWindow: 48_000,
      contextTokens: 24_000,
      reasoning: true,
      compat: { supportedReasoningEfforts: ["low", "medium", "high", "max"] },
    };
    vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValueOnce([selected]);
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply /model fixture-route/reasoner -s",
      cfg: {
        models: {
          providers: {
            "fixture-route": {
              api: "openai-responses",
              baseUrl: "https://fixture.invalid/v1",
              models: [],
            },
          },
        },
      },
      allowedModels: [
        { provider: "anthropic", id: "claude-opus-4-6", name: "Opus", reasoning: false },
      ],
      selectableModels: [selected],
      sessionEntry: createSessionEntry({ thinkingLevel: "max" }),
    });
    expect(result).toMatchObject({
      kind: "continue",
      provider: selected.provider,
      model: selected.id,
      contextTokens: 24_000,
    });
    expect(sessionEntry.thinkingLevel).toBe("max");
    expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        nextSelection: {
          model: { provider: "fixture-route", id: "reasoner" },
          executor: { kind: "harness", id: "openclaw" },
        },
        nextThinking: expect.objectContaining({
          level: "max",
          catalog: expect.arrayContaining([
            expect.objectContaining({
              ...selected,
              baseUrl: "https://fixture.invalid/v1",
              input: ["text"],
            }),
          ]),
        }),
      }),
    );
  });

  it.each([
    { prefix: "", sibling: "", reason: "model-selection-rejected" },
    { prefix: "please reply ", sibling: "", reason: "session-directive-rejected" },
    { prefix: "", sibling: "\n/think high", reason: "session-directive-rejected" },
    { prefix: "please reply ", sibling: "\n/think high", reason: "session-directive-rejected" },
  ])(
    "rejects a restricted model with prefix $prefix and sibling $sibling without persistence",
    async ({ prefix, sibling, reason }) => {
      const sessionEntry = createSessionEntry({ thinkingLevel: "high" });
      const initial = { ...sessionEntry };
      const { result } = await applyMixedDirectives({
        body: `${prefix}/model openai/REJECTED_PRIVATE_TOKEN -s${sibling}`,
        cfg: { agents: { defaults: { modelPolicy: { allow: ["anthropic/*"] } } } },
        sessionEntry,
        allowedModels: [{ provider: "anthropic", id: "claude-opus-4-6", name: "Opus" }],
      });
      expect(result).toMatchObject({
        kind: "reply",
        reply: { isError: true, text: expect.stringContaining("is not allowed") },
        preRunRejection: reason,
      });
      expect(sessionEntry).toEqual(initial);
      expect(persist).not.toHaveBeenCalled();
      expect(triggerSessionPatchHook).not.toHaveBeenCalled();
      expect(loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
    },
  );

  describe.each(["", "please reply "])("off-catalog selection with prefix %j", (prefix) => {
    it.each([undefined, {}, { allow: [] }])(
      "uses policy %j independently of inventory",
      async (modelPolicy) => {
        const { result, sessionEntry } = await applyMixedDirectives({
          body: `${prefix}/model openai/gpt-5.6-luna -s`,
          cfg: { agents: { defaults: { modelPolicy } } },
          allowedModels: [{ provider: "anthropic", id: "claude-opus-4-6", name: "Opus" }],
          selectableModels: [
            { provider: "openai", id: "gpt-5.6-luna", name: "Selected model", reasoning: true },
          ],
          sessionEntry: createSessionEntry({ thinkingLevel: "high" }),
        });
        expect(result).toMatchObject(
          prefix
            ? { kind: "continue", provider: "openai", model: "gpt-5.6-luna" }
            : {
                kind: "reply",
                reply: { text: "Model changed to Selected model. Still using OpenClaw." },
              },
        );
        expect(sessionEntry).toMatchObject({
          executionSelection: {
            state: "accepted",
            selection: {
              model: { provider: "openai", id: "gpt-5.6-luna" },
              executor: { kind: "harness", id: "openclaw" },
            },
          },
          thinkingLevel: "high",
        });
        expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
      },
    );
  });

  it("publishes a mixed profile-only selection only after persistence settles", async () => {
    const releasePersistence = createDeferred();
    const persistenceStarted = createDeferred<SessionEntry>();
    persist.mockImplementationOnce(async (params) => {
      persistenceStarted.resolve({ ...params.entry });
      await releasePersistence.promise;
      return persistReplySessionEntry(params);
    });
    vi.spyOn(authProfileStore, "findPersistedAuthProfileCredential").mockReturnValue({
      type: "api_key",
      provider: "openai",
      key: "test-key",
    });
    const fixture = await createStoredSessionFixture(
      createSelectedSessionEntry("openai", "gpt-5.6-luna", {
        authProfileOverride: "openai:work",
        authProfileOverrideSource: "auto",
      }),
    );
    const request = {
      ...fixture,
      body: "please reply /model openai/gpt-5.6-luna@openai:work -s",
      provider: "openai",
      model: "gpt-5.6-luna",
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "Luna" }],
    };
    const pending = applyMixedDirectives(request);
    try {
      const proposed = await Promise.race([
        persistenceStarted.promise,
        pending.then(({ result }) => {
          throw new Error(`Selection completed before persistence: ${JSON.stringify(result)}`);
        }),
      ]);
      expect(persist).toHaveBeenCalledOnce();
      expect(lifecycleEvents).toEqual([]);
      expect(proposed.authProfileOverrideSource).toBe("user");
      expect(loadSessionEntryReadOnly(fixture)?.authProfileOverrideSource).toBe("auto");
      releasePersistence.resolve();
      const { result } = await pending;
      expect(result).toMatchObject({ kind: "continue", provider: "openai", model: "gpt-5.6-luna" });
      expect(lifecycleEvents).toEqual([
        { sessionKey: "agent:main:dm:1", agentId: "main", reason: "patch", catalogChanged: true },
      ]);
      expect(fixture.sessionEntry.authProfileOverrideSource).toBe("user");
      expect(loadSessionEntryReadOnly(fixture)?.authProfileOverrideSource).toBe("user");
      expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();

      const repeated = await applyMixedDirectives(request);
      expect(repeated.result).toMatchObject({
        kind: "continue",
        provider: "openai",
        model: "gpt-5.6-luna",
      });
      expect(loadSessionEntryReadOnly(fixture)?.authProfileOverrideSource).toBe("user");
      expect(lifecycleEvents).toHaveLength(1);
    } finally {
      releasePersistence.resolve();
      await pending;
    }
  });

  it.each(["", "please reply\n"])(
    "keeps reasoning persistence scoped to directive-only messages with prefix %j",
    async (prefix) => {
      const { result, sessionEntry } = await applyMixedDirectives({
        body: `${prefix}/reasoning on`,
        ...(await createStoredSessionFixture()),
      });

      expect(result).toMatchObject(
        prefix
          ? {
              kind: "continue",
              directives: { reasoningLevel: "on" },
              directiveAck: { text: "⚙️ Reasoning visibility enabled." },
            }
          : { kind: "reply", reply: { text: "⚙️ Reasoning visibility enabled." } },
      );
      expect(result).not.toHaveProperty("preRunRejection", expect.anything());
      expect(sessionEntry.reasoningLevel).toBe(prefix ? undefined : "on");
      if (prefix) {
        expect(persist).not.toHaveBeenCalled();
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
      } else {
        expect(persist).toHaveBeenCalledOnce();
        expect(enqueueSystemEvent).toHaveBeenCalledOnce();
        expect(lifecycleEvents).toEqual([
          { sessionKey: "agent:main:dm:1", agentId: "main", reason: "patch" },
        ]);
      }
    },
  );

  it.each([
    { mode: "off", initial: "on", expectedAck: "Reasoning visibility disabled." },
    { mode: "stream", initial: undefined, expectedAck: "Reasoning stream enabled." },
  ])(
    "applies reasoning $mode only to this turn with a channel-neutral acknowledgement",
    async ({ mode, initial, expectedAck }) => {
      const { result, sessionEntry } = await applyMixedDirectives({
        body: `please reply\n/reasoning ${mode}`,
        sessionEntry: createSessionEntry({ reasoningLevel: initial }),
        channel: "discord",
      });

      expect(result).toMatchObject({
        kind: "continue",
        directives: { reasoningLevel: mode },
        directiveAck: { text: `⚙️ ${expectedAck}` },
      });
      expect(sessionEntry.reasoningLevel).toBe(initial);
    },
  );

  it.each([
    { hint: "", stored: true },
    { hint: " /think high", stored: true },
    { hint: "", stored: false },
    { hint: " /think high", stored: false },
  ])(
    "commits a model switch with stored thinking=$stored and hint $hint",
    async ({ hint, stored }) => {
      const cfg = {
        commands: { text: true },
        agents: {
          defaults: {
            thinkingDefault: "ultra",
            models: { "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } } },
          },
        },
      } as OpenClawConfig;
      const { result, sessionEntry } = await applyMixedDirectives({
        body: `please reply /model openai/gpt-5.6-luna${hint}`,
        cfg,
        ...(await createStoredSessionFixture(
          createSelectedSessionEntry(
            "openai",
            "gpt-5.6-sol",
            stored ? { thinkingLevel: "ultra" } : {},
            "codex",
          ),
        )),
        resolveDefaultThinkingLevel: async () =>
          resolveThinkingDefault({ cfg, provider: "openai", model: "gpt-5.6-sol" }),
        provider: "openai",
        model: "gpt-5.6-sol",
        allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
        senderIsOwner: true,
      });

      expect(result).toMatchObject({ kind: "continue", provider: "openai", model: "gpt-5.6-luna" });
      expect(sessionEntry.thinkingLevel).toBe(stored ? "max" : undefined);
      if (hint) {
        expect(result).toMatchObject({ kind: "continue", directives: { thinkLevel: "high" } });
      }
      if (result.kind !== "continue") {
        throw new Error("Expected the model switch to continue the task");
      }
      expect(result.directiveAck?.text).toContain(
        "Model changed to GPT-5.6-Luna. Still using Test native app.",
      );
      expect(
        result.directiveAck?.text?.includes("Thinking level set to max (ultra not supported"),
      ).toBe(stored);
      expect(persist).toHaveBeenCalledOnce();
      expect(persist.mock.calls[0]?.[0].entry.thinkingLevel).toBe(stored ? "max" : undefined);
      expect(triggerSessionPatchHook).toHaveBeenCalledOnce();
      expect(refreshQueuedFollowupSession).toHaveBeenCalledOnce();
      expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).toHaveBeenCalledOnce();
      expect(enqueueSystemEvent).toHaveBeenCalledWith("Model switched to openai/gpt-5.6-luna.", {
        sessionKey: "agent:main:dm:1",
        contextKey: "model:openai/gpt-5.6-luna",
      });
      expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "agent:main:dm:1",
          nextSelection: {
            model: { provider: "openai", id: "gpt-5.6-luna" },
            executor: { kind: "harness", id: "codex" },
          },
          nextThinking: expect.objectContaining({
            level: stored ? "max" : undefined,
          }),
        }),
      );
    },
  );

  it.each([
    { label: "bare", body: "please reply /model" },
    { label: "list", body: "please reply /model list" },
    { label: "status", body: "please reply /model status" },
  ])("does not acknowledge or mutate a mixed $label model info directive", async ({ body }) => {
    const cfg = { commands: { text: true }, agents: { defaults: {} } } as OpenClawConfig;
    const directives = resolveReplyDirectiveRouting({
      commandText: body,
      agentText: body,
      modelAliases: [],
      canInterpretTextDirectives: true,
      isAuthorizedSender: true,
      isGroup: false,
      wasMentioned: false,
      ctx: buildTestCtx({ Body: body, CommandAuthorized: true }),
      cfg,
      agentId: "main",
      resetTriggered: false,
    }).directives;
    const { result, sessionEntry } = await applyMixedDirectives({
      body,
      cfg,
      directives,
    });

    expect(result).toMatchObject({
      kind: "continue",
      directives: { cleaned: "please reply", hasModelDirective: false },
    });
    expect(result).not.toHaveProperty("directiveAck");
    expect(sessionEntry).toEqual(createSessionEntry());
    expect(persist).not.toHaveBeenCalled();
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it.each([
    { name: "directive-only", body: "/model openai/gpt-5.6-luna -s" },
    { name: "mixed-content", body: "please reply /model openai/gpt-5.6-luna -s" },
  ])("keeps an owner $name selection session-only", async ({ body }) => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body,
      senderIsOwner: true,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(result).toMatchObject(
      body.startsWith("/model")
        ? {
            kind: "reply",
            reply: {
              text: "Model changed to GPT-5.6-Luna. Still using OpenClaw.",
            },
          }
        : {
            kind: "continue",
            provider: "openai",
            model: "gpt-5.6-luna",
            directiveAck: {
              text: "Model changed to GPT-5.6-Luna. Still using OpenClaw.",
            },
          },
    );
    expect(sessionEntry).toMatchObject({
      executionSelection: {
        state: "accepted",
        fallbackPermission: "explicit",
        selection: {
          model: { provider: "openai", id: "gpt-5.6-luna" },
          executor: { kind: "harness", id: "openclaw" },
        },
      },
    });
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it.each([
    { name: "legacy user", marker: undefined, expectedSource: "user" as const },
    { name: "marker-backed auto", marker: 0, expectedSource: "auto" as const },
  ])(
    "forwards a source-less $name auth profile canonically after /model",
    async ({ marker, expectedSource }) => {
      const sessionEntry = createSelectedSessionEntry("openai", "gpt-5.6-sol", {
        authProfileOverride: "openai:work",
        ...(marker === undefined ? {} : { authProfileOverrideCompactionCount: marker }),
      });

      await applyMixedDirectives({
        body: "/model openai/gpt-5.6-luna -s",
        senderIsOwner: true,
        provider: "openai",
        model: "gpt-5.6-sol",
        sessionEntry,
        allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
      });

      expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
      expect(sessionEntry.authProfileOverrideCompactionCount).toBe(marker);
      expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(
        expect.objectContaining({
          nextAuthProfileId: "openai:work",
          nextAuthProfileIdSource: expectedSource,
        }),
      );
    },
  );

  it("applies an owner alias session scope without continuing to the model", async () => {
    const aliasIndex: ModelAliasIndex = {
      byAlias: new Map([
        [
          "luna",
          {
            alias: "luna",
            ref: { provider: "openai", model: "gpt-5.6-luna" },
          },
        ],
      ]),
      byKey: new Map([["openai/gpt-5.6-luna", ["luna"]]]),
    };
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "/luna -s",
      modelAliases: ["luna"],
      aliasIndex,
      senderIsOwner: true,
      ...(await createStoredSessionFixture()),
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(result).toEqual({
      kind: "reply",
      reply: {
        text: "Model changed to GPT-5.6-Luna. Still using OpenClaw.",
      },
    });
    expect(sessionEntry).toMatchObject({
      executionSelection: {
        state: "accepted",
        fallbackPermission: "explicit",
        selection: {
          model: { provider: "openai", id: "gpt-5.6-luna" },
          executor: { kind: "harness", id: "openclaw" },
        },
      },
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it("preserves a mixed alias named list as a model selection", async () => {
    const body = "please reply /list -s";
    const cfg = { commands: { text: true }, agents: { defaults: {} } } as OpenClawConfig;
    const aliasIndex: ModelAliasIndex = {
      byAlias: new Map([
        [
          "list",
          {
            alias: "list",
            ref: { provider: "openai", model: "gpt-5.6-luna" },
          },
        ],
      ]),
      byKey: new Map([["openai/gpt-5.6-luna", ["list"]]]),
    };
    const directives = resolveReplyDirectiveRouting({
      commandText: body,
      agentText: body,
      modelAliases: ["list"],
      canInterpretTextDirectives: true,
      isAuthorizedSender: true,
      isGroup: false,
      wasMentioned: false,
      ctx: buildTestCtx({ Body: body, CommandAuthorized: true }),
      cfg,
      agentId: "main",
      resetTriggered: false,
    }).directives;
    const { result, sessionEntry } = await applyMixedDirectives({
      body,
      cfg,
      directives,
      modelAliases: ["list"],
      aliasIndex,
      senderIsOwner: true,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(directives).toMatchObject({
      cleaned: "please reply",
      hasModelDirective: true,
      modelDirectiveSource: "alias",
      rawModelDirective: "list",
    });
    expect(result).toMatchObject({
      kind: "continue",
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    expect(sessionEntry).toMatchObject({
      executionSelection: {
        state: "accepted",
        fallbackPermission: "explicit",
        selection: {
          model: { provider: "openai", id: "gpt-5.6-luna" },
          executor: { kind: "harness", id: "openclaw" },
        },
      },
    });
  });

  it.each([
    {
      body: "please reply /model openai/gpt-5.6-luna --runtime codex -s",
      supported: true,
      mixed: true,
    },
    {
      body: "please reply /model openai/gpt-5.6-luna -s --runtime codex",
      supported: true,
      mixed: true,
    },
    { body: "/model default --runtime codex -s", supported: true, mixed: false },
    { body: "/model default --runtime codex -s", supported: false, mixed: false },
  ])("honors explicit runtime support=$supported for $body", async ({ body, supported, mixed }) => {
    const previous = createSelectedSessionEntry("anthropic", "claude-opus-4-6");
    const initial = structuredClone(previous);
    const { result, sessionEntry } = await applyMixedDirectives({
      body,
      sessionEntry: previous,
      defaultProvider: supported ? "openai" : "anthropic",
      defaultModel: supported ? "gpt-5.6-luna" : "claude-opus-4-6",
      senderIsOwner: true,
      allowedModels: [
        { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" },
        { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus" },
      ],
    });

    if (supported) {
      expect(result).toMatchObject(
        mixed ? { kind: "continue", provider: "openai", model: "gpt-5.6-luna" } : { kind: "reply" },
      );
      expect(sessionEntry).toMatchObject({
        executionSelection: {
          state: "accepted",
          selection: {
            model: { provider: "openai", id: "gpt-5.6-luna" },
            executor: { kind: "harness", id: "codex" },
          },
        },
      });
    } else {
      expect(result).toMatchObject({
        kind: "reply",
        preRunRejection: "model-selection-rejected",
      });
      expect(sessionEntry).toEqual(initial);
      expect(refreshQueuedFollowupSession).not.toHaveBeenCalled();
    }
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it.each([
    { name: "directive-only", body: "/model openai/gpt-5.6-luna -a" },
    { name: "mixed-content", body: "please reply /model openai/gpt-5.6-luna -a" },
  ])("reports immutable config for an owner $name agent-default selection", async ({ body }) => {
    vi.mocked(persistStickyModelSelectionBestEffort).mockReturnValueOnce("skipped-immutable");

    const { result } = await applyMixedDirectives({
      body,
      senderIsOwner: true,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    const expectedText =
      "Model changed to GPT-5.6-Luna. Still using OpenClaw. Agent default unchanged because configuration is immutable.";
    expect(result).toMatchObject(
      body.startsWith("/model")
        ? { kind: "reply", reply: { text: expectedText } }
        : { kind: "continue", directiveAck: { text: expectedText } },
    );
  });

  it("keeps a partial scope option as text without overriding the configured scope", async () => {
    const { result } = await applyMixedDirectives({
      body: "please reply /model openai/gpt-5.6-luna -slow",
      cfg: { agents: { defaults: { modelSelectionScope: "session" } } },
      senderIsOwner: true,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(result).toMatchObject({
      kind: "continue",
      provider: "openai",
      model: "gpt-5.6-luna",
      directiveAck: {
        text: "Model changed to GPT-5.6-Luna. Still using OpenClaw.",
      },
    });
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it("clears an incompatible auth pin with a cross-provider /model default -s", async () => {
    const sessionEntry = createSelectedSessionEntry("openai", "gpt-5.6-luna", {
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    });
    const { result } = await applyMixedDirectives({
      cfg: { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } },
      body: "/model default -s",
      senderIsOwner: true,
      sessionEntry,
      allowedModels: [{ provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus" }],
    });

    expect(result).toMatchObject({
      kind: "reply",
      reply: {
        text: "Using the configured default: Claude Opus in OpenClaw.",
      },
    });
    expect(sessionEntry.executionSelection).toEqual({
      state: "accepted",
      fallbackPermission: "configured",
      selection: {
        model: { provider: "anthropic", id: "claude-opus-4-6" },
        executor: { kind: "harness", id: "openclaw" },
      },
    });
    expect(sessionEntry.authProfileOverride).toBeUndefined();
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
    expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        nextSelection:
          sessionEntry.executionSelection?.state === "accepted"
            ? sessionEntry.executionSelection.selection
            : undefined,
      }),
    );
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it("preserves a compatible auth pin with a same-provider /model default -s", async () => {
    const sessionEntry = createSelectedSessionEntry("openai", "gpt-5.6-sol", {
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    });
    const { result } = await applyMixedDirectives({
      cfg: { agents: { defaults: { model: "openai/gpt-5.6-luna" } } },
      body: "/model default -s",
      senderIsOwner: true,
      provider: "openai",
      model: "gpt-5.6-sol",
      defaultProvider: "openai",
      defaultModel: "gpt-5.6-luna",
      sessionEntry,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(result).toMatchObject({
      kind: "reply",
      reply: {
        text: "Using the configured default: GPT-5.6-Luna in OpenClaw.",
      },
    });
    expect(sessionEntry.executionSelection).toEqual({
      state: "accepted",
      fallbackPermission: "configured",
      selection: {
        model: { provider: "openai", id: "gpt-5.6-luna" },
        executor: { kind: "harness", id: "openclaw" },
      },
    });
    expect(sessionEntry).toMatchObject({
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    });
    expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        nextSelection:
          sessionEntry.executionSelection?.state === "accepted"
            ? sessionEntry.executionSelection.selection
            : undefined,
      }),
    );
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it("keeps an operator.admin selection session-only", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "/model openai/gpt-5.6-luna --session",
      gatewayClientScopes: ["operator.admin"],
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(result).toMatchObject({
      kind: "reply",
      reply: {
        text: "Model changed to GPT-5.6-Luna. Still using OpenClaw.",
      },
    });
    expect(sessionEntry).toMatchObject({
      executionSelection: {
        state: "accepted",
        fallbackPermission: "explicit",
        selection: {
          model: { provider: "openai", id: "gpt-5.6-luna" },
          executor: { kind: "harness", id: "openclaw" },
        },
      },
    });
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it("routes a mixed default reset to the committed configured selection", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply /model default",
      provider: "openai",
      model: "gpt-5.6-sol",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      sessionEntry: createSelectedSessionEntry("openai", "gpt-5.6-sol"),
      allowedModels: [
        {
          provider: "anthropic",
          id: "claude-opus-4-6",
          name: "Claude Opus",
          contextTokens: 90_000,
        },
      ],
    });

    expect(result).toMatchObject({
      kind: "continue",
      provider: "anthropic",
      model: "claude-opus-4-6",
      contextTokens: 90_000,
      directiveAck: {
        text: "Using the configured default: Claude Opus in OpenClaw.",
      },
    });
    expect(sessionEntry.executionSelection).toEqual({
      state: "accepted",
      fallbackPermission: "configured",
      selection: {
        model: { provider: "anthropic", id: "claude-opus-4-6" },
        executor: { kind: "harness", id: "openclaw" },
      },
    });
  });

  it("keeps mixed queue options on the current message", async () => {
    const fixture = await createStoredSessionFixture();
    const initialEntry = structuredClone(fixture.sessionEntry);
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply\n/queue collect debounce:1500 cap:4 drop:old",
      ...fixture,
    });

    expect(result).toMatchObject({
      kind: "continue",
      perMessageQueueMode: "collect",
      perMessageQueueOptions: { debounceMs: 1500, cap: 4, dropPolicy: "old" },
    });
    expect(sessionEntry).toEqual(initialEntry);
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps routed exec policy on its message without changing session placement", async () => {
    const cfg = { commands: { text: true }, agents: { defaults: {} } } as OpenClawConfig;
    const sessionEntry = createSessionEntry({ execHost: "node", execNode: "worker-1" });
    const initialEntry = { ...sessionEntry };
    for (const [body, security, ask] of [
      ["please reply /exec host=gateway node=other security=deny ask=always", "deny", "always"],
      ["please reply again", undefined, undefined],
    ] as const) {
      const { directives } = resolveReplyDirectiveRouting({
        commandText: body,
        agentText: body,
        modelAliases: [],
        canInterpretTextDirectives: true,
        isAuthorizedSender: true,
        isGroup: false,
        wasMentioned: false,
        ctx: buildTestCtx({ Body: body, CommandAuthorized: true }),
        cfg,
        agentId: "main",
        resetTriggered: false,
      });
      const { result } = await applyMixedDirectives({ body, cfg, directives, sessionEntry });
      if (result.kind !== "continue") {
        throw new Error("Expected the message to continue to the agent");
      }
      expect(resolveReplyExecOverrides({ directives: result.directives, sessionEntry })).toEqual({
        host: "node",
        node: "worker-1",
        security,
        ask,
      });
      if (security) {
        expect(result.directiveAck?.text).toContain(
          "Exec policy for this run only (security=deny, ask=always).",
        );
      } else {
        expect(result.directiveAck).toBeUndefined();
      }
      expect(sessionEntry).toEqual(initialEntry);
    }
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not persist fast-mode or exec placement from mixed transactions", async () => {
    const fast = await applyMixedDirectives({ body: "please reply\n/fast on" });
    expect(fast.result).toMatchObject({ kind: "continue", directives: { fastMode: true } });
    expect(fast.sessionEntry.fastMode).toBeUndefined();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    const exec = await applyMixedDirectives({
      body: "please reply\n/exec host=node security=allowlist ask=always node=worker-1",
      gatewayClientScopes: [],
    });
    expect(exec.result).toMatchObject({
      kind: "continue",
      directiveAck: { text: expect.stringContaining("Exec defaults set") },
    });
    expect(exec.sessionEntry).toEqual(createSessionEntry());
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not persist trace directives for unauthorized mixed messages", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply\n/trace raw",
      sessionEntry: createSessionEntry({ traceLevel: "off" }),
      gatewayClientScopes: [],
    });

    expect(result).toMatchObject({ kind: "continue" });
    expect(sessionEntry.traceLevel).toBe("off");
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    {
      ignored: "/trace raw",
      expectedAck: "/trace is restricted to owners",
    },
    {
      ignored: "/verbose nonsense",
      expectedAck: "Current verbose level:",
    },
    {
      ignored: "/fast status",
      expectedAck: "Current fast mode:",
    },
  ])(
    "applies valid sibling settings despite an ignored $ignored directive",
    async ({ ignored, expectedAck }) => {
      const { result, sessionEntry } = await applyMixedDirectives({
        body: `please reply\n${ignored}\n/reasoning on`,
        ...(await createStoredSessionFixture()),
        gatewayClientScopes: [],
      });

      expect(result).toMatchObject({
        kind: "continue",
        directives: { reasoningLevel: "on" },
        directiveAck: { text: expect.stringContaining(expectedAck) },
      });
      expect(result).not.toHaveProperty("preRunRejection", expect.anything());
      expect(sessionEntry.reasoningLevel).toBeUndefined();
      expect(sessionEntry.traceLevel).toBeUndefined();
      expect(persist).not.toHaveBeenCalled();
    },
  );

  it.each(["", "/verbose", "/fast status", "/trace raw"])(
    "validates unsupported thinking despite an informational sibling %j",
    async (sibling) => {
      const { result, sessionEntry } = await applyMixedDirectives({
        body: `please reply ${sibling} /think high`,
        provider: "fixture-route",
        model: "reasoner",
        allowedModels: [
          {
            provider: "fixture-route",
            id: "reasoner",
            name: "Reasoner",
            reasoning: false,
          },
        ],
        gatewayClientScopes: [],
      });
      expect(result).toMatchObject({
        kind: "reply",
        reply: {
          isError: true,
          text: expect.stringContaining('Thinking level "high" is not supported'),
        },
        preRunRejection: "session-directive-rejected",
      });
      expect(sessionEntry).toEqual(createSessionEntry());
      expect(persist).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
    },
  );

  it("keeps valid turn hints when a sibling exec option is invalid", async () => {
    const fixture = await createStoredSessionFixture();
    const initialEntry = structuredClone(fixture.sessionEntry);
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply\n/exec host=node security=bogus\n/reasoning on",
      ...fixture,
    });

    expect(result).toMatchObject({
      kind: "continue",
      directives: { reasoningLevel: "on" },
      directiveAck: { text: expect.stringContaining('Unrecognized exec security "bogus"') },
    });
    expect(sessionEntry).toEqual(initialEntry);
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps informational and unauthorized siblings from persisting turn hints", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply\n/trace raw\n/verbose nonsense\n/reasoning on",
      ...(await createStoredSessionFixture()),
      gatewayClientScopes: [],
    });

    expect(result).toMatchObject({
      kind: "continue",
      directives: { reasoningLevel: "on" },
      directiveAck: { text: expect.stringContaining("/trace is restricted to owners") },
    });
    expect(sessionEntry.reasoningLevel).toBeUndefined();
    expect(sessionEntry.traceLevel).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not announce unchanged elevated mode as a transition", async () => {
    const { result } = await applyMixedDirectives({
      body: "please reply\n/elevated full",
      ...(await createStoredSessionFixture(createSessionEntry({ elevatedLevel: "full" }))),
    });

    expect(result).toMatchObject({ kind: "continue" });
    expect(persist).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
