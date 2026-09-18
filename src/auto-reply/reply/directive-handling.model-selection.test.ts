import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { loadProviderScopedThinkingCatalog } from "../../agents/model-catalog.runtime.js";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import {
  replaceSessionEntry,
  loadSessionEntryReadOnly,
} from "../../config/sessions/session-accessor.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { admitSessionExecutionFallback } from "../../model-picker/apply-session-model-selection.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../../sessions/model-overrides.js";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../../sessions/session-lifecycle-events.js";
import {
  applyMixedDirectives,
  createSessionEntry,
  createSelectedSessionEntry,
  createStoredSessionFixture,
} from "./directive-handling.mixed-inline.test-helpers.js";
import { refreshQueuedFollowupSession } from "./queue.js";
import * as sessionPersistence from "./session-entry-persistence.js";

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

describe("mixed inline directives / model selection", () => {
  let lifecycleEvents: SessionLifecycleEvent[];
  let unsubscribeLifecycle: () => void;

  beforeEach(() => {
    lifecycleEvents = [];
    unsubscribeLifecycle = onSessionLifecycleEvent((event) => lifecycleEvents.push(event));
    vi.clearAllMocks();
    vi.mocked(loadProviderScopedThinkingCatalog).mockReset().mockResolvedValue([]);
    vi.mocked(persistStickyModelSelectionBestEffort).mockReturnValue("requested");
    persist = vi.spyOn(sessionPersistence, "persistReplySessionEntry");
  });

  afterEach(() => {
    unsubscribeLifecycle();
    vi.restoreAllMocks();
  });
  describe.each(["", "please reply "])("model scope with prefix %j", (prefix) => {
    it.each([
      { scope: undefined, flag: "", owner: true, target: undefined, writes: false },
      { scope: "session", flag: "", owner: true, target: undefined, writes: false },
      { scope: "agent", flag: "", owner: true, target: "agent", writes: true },
      { scope: "global", flag: "", owner: true, target: "defaults", writes: true },
      { scope: "global", flag: " --session", owner: true, target: undefined, writes: false },
      { scope: "session", flag: " --agent", owner: true, target: "agent", writes: true },
      { scope: "agent", flag: " --global", owner: true, target: "defaults", writes: true },
      { scope: "agent", flag: "", owner: false, target: undefined, writes: false },
      { scope: "global", flag: "", owner: false, target: undefined, writes: false },
    ] as const)(
      "resolves scope=$scope flag=$flag owner=$owner without widening authority",
      async ({ scope, flag, owner, target, writes }) => {
        const { result, sessionEntry } = await applyMixedDirectives({
          body: `${prefix}/model openai/gpt-5.6-luna${flag}`,
          cfg: { agents: { defaults: { modelSelectionScope: scope } } },
          senderIsOwner: owner,
          allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
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
        const defaultUpdate =
          target === "agent"
            ? " Agent default update requested."
            : target === "defaults"
              ? " Global default update requested."
              : "";
        const acknowledgement = {
          text: `Model changed to GPT-5.6-Luna. Still using OpenClaw.${defaultUpdate}`,
        };
        expect(result).toMatchObject(
          prefix
            ? { kind: "continue", directiveAck: acknowledgement }
            : { kind: "reply", reply: acknowledgement },
        );
        if (writes) {
          expect(persistStickyModelSelectionBestEffort).toHaveBeenCalledExactlyOnceWith({
            agentId: "main",
            model: "openai/gpt-5.6-luna",
            ...(target ? { target } : {}),
          });
        } else {
          expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
        }
      },
    );
  });

  describe.each(["", "please reply "])("default authorization with prefix %j", (prefix) => {
    it.each([
      { input: "fixture/primary", model: "primary", permission: "configured" },
      { input: "default", model: "primary", permission: "configured" },
      { input: "fixture/other", model: "other", permission: "explicit" },
    ])("keeps the executor and authorization for $input", async ({ input, model, permission }) => {
      const { sessionEntry } = await applyMixedDirectives({
        body: prefix + "/model " + input,
        cfg: {
          agents: {
            defaults: {
              model: "fixture/primary",
              ...(input === "fixture/primary"
                ? {
                    models: {
                      "fixture/primary": { agentRuntime: { id: "unavailable-preference" } },
                    },
                  }
                : {}),
            },
          },
        },
        sessionEntry: createSelectedSessionEntry("fixture", "before"),
        provider: "fixture",
        model: "before",
        defaultProvider: "fixture",
        defaultModel: "primary",
        allowedModels: [
          { provider: "fixture", id: "primary", name: "Primary" },
          { provider: "fixture", id: "other", name: "Other" },
        ],
      });
      expect(sessionEntry.executionSelection).toEqual({
        state: "accepted",
        selection: {
          model: { provider: "fixture", id: model },
          executor: { kind: "harness", id: "openclaw" },
        },
        fallbackPermission: permission,
      });
      expect(
        admitSessionExecutionFallback({
          entry: sessionEntry,
          candidate: {
            model: { provider: "fixture", id: "backup" },
            executor: { kind: "harness", id: "openclaw" },
          },
        }).status,
      ).toBe(permission === "configured" ? "accepted" : "rejected");
    });
  });

  it("adopts an authoritative model lock and emits no losing side effects", async () => {
    const fixture = await createStoredSessionFixture(
      createSelectedSessionEntry("anthropic", "claude-opus-4-6"),
    );
    const { sessionEntry } = fixture;
    const lockedEntry = { ...sessionEntry, updatedAt: 2, modelSelectionLocked: true };
    persist.mockImplementationOnce(async (params) => {
      await replaceSessionEntry(fixture, lockedEntry);
      return persistReplySessionEntry(params);
    });

    const { result, sessionStore } = await applyMixedDirectives({
      body: "please reply /model openai/gpt-5.6-luna",
      ...fixture,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
      senderIsOwner: true,
    });

    expect(result).toEqual({
      kind: "reply",
      reply: { text: MODEL_SELECTION_LOCKED_MESSAGE, isError: true },
      preRunRejection: "session-directive-rejected",
    });
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ requireModelSelectionUnlocked: true }),
    );
    expect(sessionEntry).toEqual(lockedEntry);
    expect(loadSessionEntryReadOnly(fixture)).toEqual(lockedEntry);
    expect(sessionStore["agent:main:dm:1"]).toEqual(lockedEntry);
    expect(lifecycleEvents).toEqual([]);
    expect(triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("reports a locked valid model instead of an ignored unauthorized sibling", async () => {
    const fixture = await createStoredSessionFixture(createSessionEntry());
    const { sessionEntry } = fixture;
    const lockedEntry = { ...sessionEntry, updatedAt: 2, modelSelectionLocked: true };
    persist.mockImplementationOnce(async (params) => {
      await replaceSessionEntry(fixture, lockedEntry);
      return persistReplySessionEntry(params);
    });

    const { result } = await applyMixedDirectives({
      body: "please reply\n/trace raw\n/model openai/gpt-5.6-luna",
      ...fixture,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
      gatewayClientScopes: [],
    });

    expect(result).toEqual({
      kind: "reply",
      reply: { text: MODEL_SELECTION_LOCKED_MESSAGE, isError: true },
      preRunRejection: "session-directive-rejected",
    });
    expect(sessionEntry).toEqual(lockedEntry);
    expect(loadSessionEntryReadOnly(fixture)).toEqual(lockedEntry);
    expect(persist).toHaveBeenCalledOnce();
    expect(triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
