import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { evaluatePublishedModelRuntimeChoice } from "../agents/model-runtime-choice.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import { applySessionExecutionSelection } from "./apply-session-model-selection.js";
import type {
  ApplySessionExecutionSelectionParams,
  ModelExecutionSelection,
} from "./execution-selection.js";

vi.mock("../agents/model-runtime-choice.js", () => ({
  evaluatePublishedModelRuntimeChoice: vi.fn(),
}));
const effects = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(),
  info: vi.fn(),
  mutateConfigFileWithRetry: vi.fn(),
  refreshQueuedFollowupSession: vi.fn(),
  triggerSessionPatchHook: vi.fn(),
  warn: vi.fn(),
  getMany: vi.fn(),
}));
vi.mock("../infra/system-events.js", () => ({ enqueueSystemEvent: effects.enqueueSystemEvent }));
vi.mock("../auto-reply/reply/queue.js", () => ({
  refreshQueuedFollowupSession: effects.refreshQueuedFollowupSession,
}));
vi.mock("../gateway/session-patch-hooks.js", () => ({
  triggerSessionPatchHook: effects.triggerSessionPatchHook,
}));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  mutateConfigFileWithRetry: effects.mutateConfigFileWithRetry,
}));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) =>
      subsystem === "agents/sticky-model-selection"
        ? { info: effects.info, warn: effects.warn }
        : actual.createSubsystemLogger(subsystem),
  };
});
vi.mock("../gateway/session-worker-placement-context.js", () => ({
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: { getMany: effects.getMany },
  }),
}));

const catalog: ModelCatalogEntry[] = [
  { provider: "fixture", id: "original", name: "Original", contextTokens: 32_000 },
  {
    provider: "fixture",
    id: "selected",
    name: "Selected",
    contextTokens: 16_000,
    reasoning: true,
    compat: { supportedReasoningEfforts: ["low", "medium", "high"] },
  },
  { provider: "other", id: "alternate", name: "Alternate" },
];
function pair(id = "original", provider = "fixture"): ModelExecutionSelection {
  return { model: { provider, id }, executor: { kind: "harness", id: "openclaw" } };
}
function createEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 1,
    delivery: { kind: "none" },
    executionSelection: { state: "accepted", selection: pair(), fallbackPermission: "configured" },
    ...overrides,
  };
}
function createParams(overrides: Partial<ApplySessionExecutionSelectionParams> = {}) {
  const sessionEntry = overrides.sessionEntry ?? createEntry();
  const sessionKey = overrides.sessionKey ?? "agent:main:dm:1";
  return {
    cfg: { agents: { defaults: { model: "fixture/original" } } },
    agentId: "main",
    sessionKey,
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    modelCatalog: catalog,
    thinkingCatalog: catalog,
    markLiveSwitchPending: true,
    request: { kind: "model", model: pair("selected").model },
    ...overrides,
  } satisfies ApplySessionExecutionSelectionParams;
}
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let lifecycleEvents: SessionLifecycleEvent[];
let unsubscribeLifecycle: () => void;
beforeEach(() => {
  vi.mocked(evaluatePublishedModelRuntimeChoice)
    .mockReset()
    .mockImplementation(async ({ provider, model }) => ({
      kind: "ready",
      entry: catalog.find((row) => row.provider === provider && row.id === model) ?? {
        provider,
        id: model,
        name: "Selected model",
      },
      validate: () => undefined,
    }));
  for (const effect of Object.values(effects)) {
    effect.mockReset();
  }
  effects.getMany.mockReturnValue(new Map());
  effects.mutateConfigFileWithRetry.mockResolvedValue({ nextConfig: {}, result: "defaults" });
  lifecycleEvents = [];
  unsubscribeLifecycle = onSessionLifecycleEvent((event) => lifecycleEvents.push(event));
});
afterEach(() => unsubscribeLifecycle());
function expectNoEffects() {
  expect(lifecycleEvents).toEqual([]);
  expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
  expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
  expect(effects.enqueueSystemEvent).not.toHaveBeenCalled();
}

describe("applySessionExecutionSelection public operation", () => {
  it("preserves unfinished SDK intent through initialization and consumes it on reset", async () => {
    const params = createParams({
      sessionEntry: createEntry({
        executionSelection: {
          state: "deferred",
          request: { defaultSelection: "configured" },
          fallbackPermission: "configured",
          legacyRequest: { provider: "other" },
        },
      }),
      request: { kind: "initialize" },
    });
    const initialized = await applySessionExecutionSelection(params);
    expect(initialized).toMatchObject({ status: "applied", selection: pair() });
    expect(params.sessionEntry.executionSelection).toMatchObject({
      state: "accepted",
      selection: pair(),
      legacyRequest: { provider: "other" },
    });
    const reset = await applySessionExecutionSelection({ ...params, request: { kind: "reset" } });
    expect(reset).toMatchObject({ status: "applied", selection: pair(), reason: "reset" });
    expect(params.sessionEntry.executionSelection).not.toHaveProperty("legacyRequest");
  });

  it.each(["accepted", "deferred"] as const)(
    "refuses forbidden explicit %s intent before initialization",
    async (state) => {
      const params = createParams({
        cfg: {
          agents: {
            defaults: {
              model: "fixture/original",
              modelPolicy: { allow: ["fixture/original"] },
            },
          },
        },
        sessionEntry: createEntry({
          executionSelection:
            state === "accepted"
              ? { state, selection: pair("selected"), fallbackPermission: "explicit" }
              : {
                  state,
                  request: { model: pair("selected").model },
                  fallbackPermission: "explicit",
                },
        }),
        request: { kind: "initialize" },
      });
      const initial = structuredClone(params.sessionEntry);
      expect(await applySessionExecutionSelection(params)).toMatchObject({
        status: "rejected",
        reason: "not-allowed",
      });
      expect(params.sessionEntry).toEqual(initial);
      expect(evaluatePublishedModelRuntimeChoice).not.toHaveBeenCalled();
      expectNoEffects();
    },
  );

  it.each([
    { requestKind: "initialize", allow: ["fixture/visible"], admitted: true },
    { requestKind: "initialize", allow: ["other/*"], admitted: false },
    { requestKind: "model", allow: ["fixture/visible"], admitted: false },
  ] as const)(
    "retains the configured primary only for its initial exact policy: $requestKind $allow",
    async ({ requestKind, allow, admitted }) => {
      const params = createParams({
        cfg: {
          agents: {
            defaults: {
              model: "fixture/original",
              modelPolicy: { allow: [...allow] },
            },
          },
        },
        sessionEntry: createEntry({
          executionSelection: {
            state: "deferred",
            request: { model: pair().model },
            fallbackPermission: "explicit",
          },
        }),
        request:
          requestKind === "initialize"
            ? { kind: "initialize" }
            : { kind: "model", model: pair().model },
      });
      const before = structuredClone(params.sessionEntry);
      const result = await applySessionExecutionSelection(params);
      if (admitted) {
        expect(result).toMatchObject({ status: "applied", selection: pair() });
        expect(params.sessionEntry.executionSelection).toMatchObject({
          state: "accepted",
          selection: pair(),
          fallbackPermission: "explicit",
        });
      } else {
        expect(result).toMatchObject({ status: "rejected", reason: "not-allowed" });
        expect(params.sessionEntry).toEqual(before);
        expect(evaluatePublishedModelRuntimeChoice).not.toHaveBeenCalled();
        expectNoEffects();
      }
    },
  );

  it.each(["configured", "locked"] as const)(
    "retains %s initialization authorization outside the manual picker",
    async (authorization) => {
      const params = createParams({
        cfg: {
          agents: {
            defaults: {
              model: "fixture/original",
              modelPolicy: { allow: ["fixture/original"] },
            },
          },
        },
        sessionEntry: createEntry({
          modelSelectionLocked: authorization === "locked",
          executionSelection: {
            state: "deferred",
            request: { model: pair("selected").model },
            fallbackPermission: authorization === "configured" ? "configured" : "explicit",
          },
        }),
        request: { kind: "initialize" },
      });
      expect(await applySessionExecutionSelection(params)).toMatchObject({
        status: "applied",
        selection: pair("selected"),
      });
      expect(params.sessionEntry.executionSelection).toMatchObject({
        state: "accepted",
        selection: pair("selected"),
      });
    },
  );

  it.each(["configured", "explicit"] as const)(
    "inherits the parent's %s authorization with its model",
    async (fallbackPermission) => {
      const storePath = path.join(
        tempDirs.make("openclaw-selection-parent-policy-"),
        "sessions.json",
      );
      const parentSessionKey = "agent:main:main";
      const parent = createEntry({
        executionSelection: { state: "accepted", selection: pair("selected"), fallbackPermission },
      });
      await replaceSessionEntry({ storePath, sessionKey: parentSessionKey }, parent);
      const params = createParams({
        cfg: {
          agents: {
            defaults: {
              model: "fixture/original",
              modelPolicy: { allow: ["fixture/original"] },
            },
          },
        },
        sessionKey: "agent:main:subagent:child",
        storePath,
        sessionEntry: createEntry({
          sessionId: "child",
          parentSessionKey,
          executionSelection: {
            state: "deferred",
            request: { defaultSelection: "inherit" },
            fallbackPermission: "configured",
          },
        }),
        request: { kind: "initialize" },
      });
      await replaceSessionEntry({ storePath, sessionKey: params.sessionKey }, params.sessionEntry);
      const initial = loadSessionEntryReadOnly({ storePath, sessionKey: params.sessionKey });
      const result = await applySessionExecutionSelection(params);
      if (fallbackPermission === "configured") {
        expect(result).toMatchObject({ status: "applied", selection: pair("selected") });
        expect(
          loadSessionEntryReadOnly({ storePath, sessionKey: params.sessionKey })
            ?.executionSelection,
        ).toMatchObject({ state: "accepted", selection: pair("selected"), fallbackPermission });
      } else {
        expect(result).toMatchObject({ status: "rejected", reason: "not-allowed" });
        expect(loadSessionEntryReadOnly({ storePath, sessionKey: params.sessionKey })).toEqual(
          initial,
        );
        expectNoEffects();
      }
      expect(
        loadSessionEntryReadOnly({ storePath, sessionKey: parentSessionKey })?.executionSelection,
      ).toEqual(parent.executionSelection);
    },
  );

  it.each(["model", "executor", "missing-model"] as const)(
    "does not use deferred initialization to bypass a locked %s",
    async (change) => {
      const params = createParams({
        sessionEntry: createEntry({
          modelSelectionLocked: true,
          executionSelection: {
            state: "deferred",
            request: change === "missing-model" ? {} : { model: pair().model },
            fallbackPermission: "explicit",
          },
        }),
        request:
          change === "model"
            ? { kind: "model", model: pair("selected").model }
            : change === "executor"
              ? {
                  kind: "model",
                  model: pair().model,
                  executor: { kind: "harness", id: "other-app" },
                }
              : { kind: "initialize" },
      });
      const initial = structuredClone(params.sessionEntry);
      expect(await applySessionExecutionSelection(params)).toMatchObject({
        status: "rejected",
        reason: "locked",
      });
      expect(params.sessionEntry).toEqual(initial);
      expectNoEffects();
    },
  );

  it("retains the executor, invalidates context, and publishes the accepted pair once", async () => {
    const params = createParams({
      sessionKey: "agent:main:channel:bound:thread:42",
      sessionEntry: createEntry({
        contextTokens: 8_000,
        model: "observed",
        modelProvider: "other",
        agentHarnessId: "observed-app",
      }),
      profileOverride: "fixture:work",
    });
    const result = await applySessionExecutionSelection(params);
    expect(result).toMatchObject({
      status: "applied",
      selection: pair("selected"),
      before: pair(),
      reason: "model",
      changed: true,
      contextTokens: 16_000,
      message: "Model changed to Selected. Still using OpenClaw.",
    });
    expect(params.sessionEntry).toMatchObject({
      executionSelection: {
        state: "accepted",
        selection: pair("selected"),
        fallbackPermission: "explicit",
      },
      authProfileOverride: "fixture:work",
      authProfileOverrideSource: "user",
      liveModelSwitchPending: true,
      model: "observed",
      modelProvider: "other",
      agentHarnessId: "observed-app",
    });
    expect(params.sessionEntry.contextTokens).toBeUndefined();
    expect(effects.triggerSessionPatchHook).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionKey: params.sessionKey,
        patch: { key: params.sessionKey, model: "fixture/selected" },
      }),
    );
    expect(effects.refreshQueuedFollowupSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        key: params.sessionKey,
        nextSelection: pair("selected"),
        nextAuthProfileId: "fixture:work",
        nextAuthProfileIdSource: "user",
      }),
    );
    expect(effects.enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
      result.status === "applied" ? result.message : "",
      {
        sessionKey: params.sessionKey,
        contextKey: "model:fixture/selected",
      },
    );
    expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "changes the accepted app only when support is disproved=%s",
    async (unsupported) => {
      const previous: ModelExecutionSelection = {
        ...pair(),
        executor: { kind: "harness", id: "fixture-app" },
      };
      vi.mocked(evaluatePublishedModelRuntimeChoice).mockImplementation(async ({ runtimeId }) =>
        unsupported && runtimeId === "fixture-app"
          ? { kind: "unsupported", message: "Unsupported route" }
          : { kind: "ready", entry: catalog[1]!, validate: () => undefined },
      );
      const params = createParams({
        sessionEntry: createEntry({
          executionSelection: {
            state: "accepted",
            selection: previous,
            fallbackPermission: "explicit",
          },
        }),
      });
      expect(await applySessionExecutionSelection(params)).toMatchObject({
        status: "applied",
        before: previous,
        reason: unsupported ? "unsupported" : "model",
        selection: {
          model: pair("selected").model,
          executor: unsupported ? pair().executor : previous.executor,
        },
        message: unsupported
          ? "Now using Selected in OpenClaw; the selected app cannot run it."
          : "Model changed to Selected. Still using the selected app.",
      });
    },
  );

  it("honors an explicit executor and reports it", async () => {
    const params = createParams({
      request: { kind: "model", model: pair("selected").model, executor: pair().executor },
    });
    expect(await applySessionExecutionSelection(params)).toMatchObject({
      status: "applied",
      reason: "explicit",
      selection: pair("selected"),
      message: "Now using Selected in OpenClaw.",
    });
  });

  it.each([false, true])("uses the configured default only with reset intent=%s", async (reset) => {
    const params = createParams({
      cfg: {
        agents: {
          defaults: { model: "fixture/original", modelPolicy: { allow: ["fixture/selected"] } },
        },
      },
      sessionEntry: createEntry({
        executionSelection: {
          state: "accepted",
          selection: pair("selected"),
          fallbackPermission: "explicit",
        },
      }),
      request: reset ? { kind: "reset" } : { kind: "model", model: pair().model },
    });
    const before = structuredClone(params.sessionEntry);
    const result = await applySessionExecutionSelection(params);
    expect(result).toMatchObject(
      reset
        ? { status: "applied", selection: pair(), reason: "reset" }
        : { status: "rejected", reason: "not-allowed" },
    );
    if (reset) {
      expect(params.sessionEntry.executionSelection).toMatchObject({
        selection: pair(),
        fallbackPermission: "configured",
      });
    } else {
      expect(params.sessionEntry).toEqual(before);
      expectNoEffects();
    }
  });

  it.each(["unknown", "unavailable", "unsupported", "forbidden"] as const)(
    "refuses %s without changing the pair or publishing effects",
    async (kind) => {
      vi.mocked(evaluatePublishedModelRuntimeChoice).mockResolvedValue({
        kind,
        message: "Selection is forbidden.",
        validate: () => undefined,
      });
      const params = createParams();
      const before = structuredClone(params.sessionEntry);
      expect(await applySessionExecutionSelection(params)).toMatchObject({
        status: "rejected",
        reason: kind === "forbidden" ? "not-allowed" : kind,
      });
      expect(params.sessionEntry).toEqual(before);
      expectNoEffects();
    },
  );

  it.each([true, false])(
    "records an unauthenticated reset only while its catalog is current=%s",
    async (current) => {
      vi.mocked(evaluatePublishedModelRuntimeChoice).mockResolvedValue({
        kind: "unavailable",
        message: "Unavailable",
        validate: () => (current ? undefined : "The catalog was retired."),
      });
      const params = createParams({ request: { kind: "reset" } });
      const before = structuredClone(params.sessionEntry);
      const result = await applySessionExecutionSelection(params);
      if (current) {
        expect(result).toMatchObject({ status: "applied", selection: pair() });
        expect(result.message).toMatch(/sign in/i);
      } else {
        expect(result.status).toBe("rejected");
        expect(params.sessionEntry).toEqual(before);
        expectNoEffects();
      }
    },
  );

  it("uses the admitted route metadata outside the browse inventory for thinking and context", async () => {
    const selected: ModelCatalogEntry = {
      provider: "fixture",
      id: "off-menu",
      name: "Reasoner",
      contextTokens: 24_000,
      contextWindow: 48_000,
      reasoning: true,
      compat: { supportedReasoningEfforts: ["low", "medium", "high", "max"] },
    };
    vi.mocked(evaluatePublishedModelRuntimeChoice).mockResolvedValueOnce({
      kind: "ready",
      entry: selected,
      validate: () => undefined,
    });
    const params = createParams({
      sessionEntry: createEntry({ thinkingLevel: "max" }),
      request: { kind: "model", model: { provider: selected.provider, id: selected.id } },
    });
    const result = await applySessionExecutionSelection(params);
    expect(result).toMatchObject({ status: "applied", contextTokens: 24_000 });
    expect(result).not.toHaveProperty("thinkingRemap");
    expect(params.sessionEntry.thinkingLevel).toBe("max");
    expect(effects.refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        nextThinking: { level: "max", catalog: expect.arrayContaining([selected]) },
      }),
    );
  });

  it.each([false, true])(
    "remaps unsupported thinking when the model is already selected=%s",
    async (sameModel) => {
      const params = createParams({
        sessionEntry: createEntry({
          thinkingLevel: "adaptive",
          ...(sameModel
            ? {
                executionSelection: {
                  state: "accepted",
                  selection: pair("selected"),
                  fallbackPermission: "explicit",
                },
              }
            : {}),
        }),
      });
      expect(await applySessionExecutionSelection(params)).toMatchObject({
        status: "applied",
        changed: true,
        thinkingRemap: { from: "adaptive", to: "medium", provider: "fixture", model: "selected" },
      });
      expect(params.sessionEntry.thinkingLevel).toBe("medium");
      expect(effects.refreshQueuedFollowupSession).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { marker: undefined, source: "user" },
    { marker: 0, source: "auto" },
  ])(
    "retains compatible source-less accounts and queues source $source",
    async ({ marker, source }) => {
      const params = createParams({
        sessionEntry: createEntry({
          authProfileOverride: "fixture:work",
          authProfileOverrideCompactionCount: marker,
        }),
      });
      expect((await applySessionExecutionSelection(params)).status).toBe("applied");
      expect(params.sessionEntry.authProfileOverride).toBe("fixture:work");
      expect(params.sessionEntry.authProfileOverrideSource).toBeUndefined();
      expect(params.sessionEntry.authProfileOverrideCompactionCount).toBe(marker);
      expect(effects.refreshQueuedFollowupSession).toHaveBeenCalledWith(
        expect.objectContaining({ nextAuthProfileIdSource: source }),
      );
    },
  );

  it.each(["fixture", "other"])(
    "reset preserves only accounts compatible with %s",
    async (provider) => {
      const params = createParams({
        cfg: {
          agents: {
            defaults: { model: `${provider}/${provider === "fixture" ? "original" : "alternate"}` },
          },
        },
        sessionEntry: createEntry({
          authProfileOverride: "fixture:work",
          authProfileOverrideSource: "user",
          authProfileOverrideCompactionCount: 3,
        }),
        request: { kind: "reset" },
        canPersistStickyModelSelection: true,
      });
      expect((await applySessionExecutionSelection(params)).status).toBe("applied");
      expect(params.sessionEntry.authProfileOverride).toBe(
        provider === "fixture" ? "fixture:work" : undefined,
      );
      expect(params.sessionEntry.authProfileOverrideCompactionCount).toBe(
        provider === "fixture" ? 3 : undefined,
      );
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    },
  );

  it("publishes a profile-only change after the scoped row is persisted", async () => {
    const storePath = path.join(tempDirs.make("openclaw-selection-profile-"), "sessions.json");
    const params = createParams({
      storePath,
      sessionEntry: createEntry({
        authProfileOverride: "fixture:work",
        authProfileOverrideSource: "auto",
      }),
      request: { kind: "model", model: pair().model },
      profileOverride: "fixture:work",
    });
    await replaceSessionEntry({ sessionKey: params.sessionKey, storePath }, params.sessionEntry);
    let published: SessionEntry | undefined;
    const off = onSessionLifecycleEvent(() => {
      published = loadSessionEntryReadOnly({ sessionKey: params.sessionKey, storePath });
    });
    try {
      expect(await applySessionExecutionSelection(params)).toMatchObject({
        status: "applied",
        changed: true,
      });
      expect(published).toMatchObject({
        executionSelection: { selection: pair() },
        authProfileOverrideSource: "user",
      });
      expect(lifecycleEvents).toEqual([
        { sessionKey: params.sessionKey, agentId: "main", reason: "patch" },
      ]);
      expect(effects.enqueueSystemEvent).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it.each(["locked", "replaced", "selection", "account", "permission"])(
    "rejects concurrent %s after awaited preparation",
    async (change) => {
      const gate =
        createDeferred<Awaited<ReturnType<typeof evaluatePublishedModelRuntimeChoice>>>();
      vi.mocked(evaluatePublishedModelRuntimeChoice).mockReturnValueOnce(gate.promise);
      let permitted = true;
      const params = createParams({
        validateCommit: () => (permitted ? undefined : "Select an account you own."),
      });
      const original = structuredClone(params.sessionEntry);
      const pending = applySessionExecutionSelection(params);
      // The lazy public boundary has reached the awaited runtime evaluator before the concurrent writer acts.
      await vi.waitFor(() => expect(evaluatePublishedModelRuntimeChoice).toHaveBeenCalledOnce());
      const concurrent = createEntry(
        change === "locked"
          ? { modelSelectionLocked: true }
          : change === "replaced"
            ? { sessionId: "replacement" }
            : change === "selection"
              ? {
                  executionSelection: {
                    state: "accepted",
                    selection: pair("alternate", "other"),
                    fallbackPermission: "explicit",
                  },
                }
              : change === "account"
                ? { authProfileOverride: "fixture:new" }
                : {},
      );
      if (change === "permission") {
        permitted = false;
      } else {
        params.sessionStore[params.sessionKey] = concurrent;
      }
      gate.resolve({ kind: "ready", entry: catalog[1]!, validate: () => undefined });
      expect(await pending).toMatchObject(
        change === "locked"
          ? { status: "rejected", reason: "locked" }
          : change === "permission"
            ? { status: "rejected", message: "Select an account you own." }
            : { status: "conflict" },
      );
      expect(params.sessionEntry).toEqual(original);
      if (change !== "permission") {
        expect(params.sessionStore[params.sessionKey]).toBe(concurrent);
      }
      expectNoEffects();
    },
  );

  it.each(["lock", "replacement", "selection"])(
    "preserves a concurrent persisted %s without a hybrid row",
    async (change) => {
      const storePath = path.join(tempDirs.make("openclaw-selection-race-"), "sessions.json");
      const params = createParams({ storePath });
      const original = structuredClone(params.sessionEntry);
      const concurrent = createEntry(
        change === "lock"
          ? { modelSelectionLocked: true }
          : change === "replacement"
            ? { sessionId: "replacement" }
            : {
                executionSelection: {
                  state: "accepted",
                  selection: pair("alternate", "other"),
                  fallbackPermission: "explicit",
                },
              },
      );
      await replaceSessionEntry({ sessionKey: params.sessionKey, storePath }, concurrent);
      expect(await applySessionExecutionSelection(params)).toMatchObject(
        change === "lock" ? { status: "rejected", reason: "locked" } : { status: "conflict" },
      );
      expect(loadSessionEntryReadOnly({ sessionKey: params.sessionKey, storePath })).toMatchObject(
        concurrent,
      );
      expect(params.sessionEntry).toEqual(original);
      expectNoEffects();
    },
  );

  it.each(["locked", "policy", "placement"])("keeps the %s protection", async (guard) => {
    const params = createParams(
      guard === "locked"
        ? { sessionEntry: createEntry({ modelSelectionLocked: true }) }
        : guard === "policy"
          ? {
              cfg: {
                agents: {
                  defaults: {
                    model: "fixture/original",
                    modelPolicy: { allow: ["fixture/original"] },
                  },
                },
              },
            }
          : {},
    );
    if (guard === "placement") {
      effects.getMany.mockReturnValue(
        new Map([["session-1", { state: "active", executionMode: "remote-exec" }]]),
      );
    }
    const initial = structuredClone(params.sessionEntry);
    expect(await applySessionExecutionSelection(params)).toMatchObject({
      status: "rejected",
      reason: guard === "locked" ? "locked" : "not-allowed",
    });
    expect(params.sessionEntry).toEqual(initial);
    expectNoEffects();
  });

  it.each(["runtime", "placement"])(
    "rechecks %s after waiting for the session writer",
    async (guard) => {
      const storePath = path.join(tempDirs.make("openclaw-selection-commit-"), "sessions.json");
      const params = createParams({ storePath });
      await replaceSessionEntry({ sessionKey: params.sessionKey, storePath }, params.sessionEntry);
      const initial = structuredClone(params.sessionEntry);
      const entered = createDeferred();
      const release = createDeferred();
      const validated = createDeferred();
      const writer = patchSessionEntryCore(
        { sessionKey: params.sessionKey, storePath },
        async () => {
          entered.resolve();
          await release.promise;
          return null;
        },
      );
      await entered.promise;
      let runtimeAvailable = true;
      vi.mocked(evaluatePublishedModelRuntimeChoice).mockResolvedValueOnce({
        kind: "ready",
        entry: catalog[1]!,
        validate: () => {
          validated.resolve();
          return runtimeAvailable ? undefined : "Selected app is no longer available.";
        },
      });
      const pending = applySessionExecutionSelection(params);
      try {
        expect(
          await Promise.race([validated.promise.then(() => true), pending.then(() => false)]),
        ).toBe(true);
        if (guard === "runtime") {
          runtimeAvailable = false;
        } else {
          effects.getMany.mockReturnValue(
            new Map([["session-1", { state: "active", executionMode: "remote-exec" }]]),
          );
        }
      } finally {
        release.resolve();
        await writer;
      }
      expect(await pending).toMatchObject({ status: "rejected", reason: "not-allowed" });
      expect(loadSessionEntryReadOnly({ sessionKey: params.sessionKey, storePath })).toEqual(
        initial,
      );
      expect(params.sessionEntry).toEqual(initial);
      expectNoEffects();
    },
  );

  it("keeps compatible active placement", async () => {
    effects.getMany.mockReturnValue(
      new Map([["session-1", { state: "active", executionMode: "worker-turn" }]]),
    );
    expect((await applySessionExecutionSelection(createParams())).status).toBe("applied");
  });

  it("keeps an idempotent acknowledgment without duplicate effects", async () => {
    const params = createParams({
      sessionEntry: createEntry({
        executionSelection: {
          state: "accepted",
          selection: pair("selected"),
          fallbackPermission: "explicit",
        },
      }),
    });
    expect(await applySessionExecutionSelection(params)).toMatchObject({
      status: "applied",
      changed: false,
      selection: pair("selected"),
      message: "Model changed to Selected. Still using OpenClaw.",
    });
    expectNoEffects();
  });

  it.each([false, true])(
    "keeps session success when the authorized configured write fails=%s",
    async (fails) => {
      const cfg: OpenClawConfig = { agents: { defaults: { model: "fixture/original" } } };
      const draft: OpenClawConfig = {
        agents: {
          defaults: { model: "fixture/original" },
          entries: { main: { model: "fixture/other" } },
        },
      };
      if (fails) {
        effects.mutateConfigFileWithRetry.mockRejectedValueOnce(new Error("config write failed"));
      } else {
        effects.mutateConfigFileWithRetry.mockImplementationOnce(
          async ({ mutate }: { mutate: (config: OpenClawConfig) => string }) => ({
            nextConfig: draft,
            result: mutate(draft),
          }),
        );
      }
      const params = createParams({ cfg, canPersistStickyModelSelection: true });
      expect(await applySessionExecutionSelection(params)).toMatchObject({
        status: "applied",
        configuredDefaultUpdate: "requested",
      });
      expect(params.sessionEntry.executionSelection).toMatchObject({ selection: pair("selected") });
      if (fails) {
        await vi.waitFor(() => expect(effects.warn).toHaveBeenCalledOnce());
      } else {
        await vi.waitFor(() => expect(effects.info).toHaveBeenCalledOnce());
        expect(draft.agents?.defaults?.model).toBe("fixture/original");
        expect(draft.agents?.entries?.main?.model).toBe("fixture/selected");
      }
    },
  );
});
