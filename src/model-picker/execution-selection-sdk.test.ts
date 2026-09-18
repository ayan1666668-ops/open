import { describe, expect, it, vi } from "vitest";
import { evaluatePublishedModelRuntimeChoice } from "../agents/model-runtime-choice.js";
import { createAgentPatchedSessionModelRunGuard } from "../agents/session-model-auto-revert.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resolveStoredModelOverride } from "../plugin-sdk/command-auth-native.js";
import {
  applyModelOverrideToSessionEntry,
  applyModelOverrideWithAuthProfileCompatibility,
  ModelSelectionLockedError,
  resolvePersistedSessionRuntimeId,
  resolveSessionModelRef,
} from "../plugin-sdk/model-session-runtime.js";
import { projectPluginSessionEntry } from "../plugin-sdk/session-store-runtime-internal.js";
import {
  getSessionEntry,
  patchSessionEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "../plugin-sdk/session-store-runtime.js";
import { getActivePluginRegistryVersion } from "../plugins/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  applySessionExecutionSelection,
  createAgentPatchedSessionModelFallback,
} from "./apply-session-model-selection.js";
import type { AcpExecutionSelection } from "./execution-selection.js";

vi.mock("../agents/model-runtime-choice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/model-runtime-choice.js")>()),
  evaluatePublishedModelRuntimeChoice: vi.fn(
    async (params: { runtimeId: string; provider: string; model: string }) => {
      const generation = getActivePluginRegistryVersion();
      return {
        kind: "ready" as const,
        entry: { provider: params.provider, id: params.model, name: "Requested" },
        validate: () =>
          generation === getActivePluginRegistryVersion()
            ? undefined
            : "Prepared selection is no longer current.",
      };
    },
  ),
}));

function entry(pinned = true): SessionEntry {
  return projectPluginSessionEntry({
    sessionId: "sdk-session",
    updatedAt: 1,
    ...(pinned
      ? {
          executionSelection: {
            state: "accepted" as const,
            selection: {
              model: { provider: "fixture", id: "before" },
              executor: { kind: "harness" as const, id: "openclaw" },
            },
            fallbackPermission: "explicit" as const,
          },
        }
      : {}),
  });
}
const selection = { provider: "fixture", model: "family/after" };

describe("released model-selection SDK entry points", () => {
  it.each(["accepted", "deferred"] as const)(
    "stages a supplied %s pair without accepting forged recovery history",
    async (state) => {
      await withOpenClawTestState({ label: "sdk-selection-recovery" }, async () => {
        const scope = { agentId: "main", sessionKey: "agent:main:sdk" };
        const previous = {
          model: { provider: "fixture", id: "original" },
          executor: { kind: "harness" as const, id: "openclaw" },
        };
        const proposed = {
          model: { provider: "fixture", id: "proposed" },
          executor: { kind: "harness" as const, id: "openclaw" },
        };
        await replaceSessionEntry(scope, {
          sessionId: "sdk-session",
          updatedAt: 1,
          executionSelection: {
            state: "accepted",
            selection: previous,
            fallbackPermission: "explicit",
          },
        });
        await patchSessionEntry({
          ...scope,
          update: () => ({
            executionSelection:
              state === "accepted"
                ? { state, selection: proposed, fallbackPermission: "explicit" }
                : { state, request: proposed, previous: proposed, fallbackPermission: "explicit" },
          }),
        });
        expect(loadSessionEntryReadOnly(scope)?.executionSelection).toEqual({
          state: "deferred",
          request: proposed,
          previous,
          fallbackPermission: "explicit",
        });
      });
    },
  );

  it.each(
    [false, true].flatMap((authAware) =>
      [
        { shape: "raw", existing: false, write: "upsert" },
        { shape: "raw", existing: false, write: "patch" },
        { shape: "raw", existing: true, write: "upsert" },
        { shape: "projected", existing: true, write: "upsert" },
      ].flatMap(({ shape, existing, write }) =>
        [false, true].map((isDefault) => ({ shape, existing, write, authAware, isDefault })),
      ),
    ),
  )(
    "preserves ACP selection through a $shape row, existing=$existing, write=$write, auth-aware=$authAware, default=$isDefault",
    async ({ shape, existing, write, authAware, isDefault }) => {
      await withOpenClawTestState({ label: "sdk-acp-row-selection" }, async () => {
        const scope = { agentId: "main", sessionKey: "agent:main:sdk-acp" };
        const previous: AcpExecutionSelection = {
          executor: { kind: "acp", backend: "fixture-backend", agent: "fixture-agent" },
          model: { id: "prior" },
        };
        const raw: SessionEntry = {
          sessionId: "sdk-acp-session",
          updatedAt: 1,
          acp: {
            backend: "fixture-backend",
            agent: "fixture-agent",
            runtimeSessionName: "fixture-handle",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 1,
            runtimeOptions: { model: "prior", runtimeMode: "normal" },
          },
        };
        if (existing) {
          await replaceSessionEntry(scope, {
            sessionId: raw.sessionId,
            updatedAt: raw.updatedAt,
            executionSelection: {
              state: "accepted",
              selection: previous,
              fallbackPermission: "explicit",
            },
            acp: {
              runtimeSessionName: "fixture-handle",
              mode: "persistent",
              state: "idle",
              lastActivityAt: 1,
              runtimeOptions: { runtimeMode: "normal" },
            },
          });
        }
        const row = shape === "projected" ? getSessionEntry(scope) : raw;
        if (!row) {
          throw new Error("Expected released ACP session view");
        }
        const originalAcp = structuredClone(row.acp);
        const setter = authAware
          ? applyModelOverrideWithAuthProfileCompatibility
          : applyModelOverrideToSessionEntry;
        setter({
          cfg: {},
          agentDir: "/nonexistent/sdk-agent",
          currentProvider: "fixture",
          entry: row,
          selection: {
            provider: "fixture",
            model: isDefault ? "configured-default" : "requested",
            isDefault,
          },
          metadataSnapshot: { plugins: [] },
        });
        expect(row.acp).toEqual(originalAcp);
        if (write === "patch") {
          await patchSessionEntry({
            ...scope,
            fallbackEntry: row,
            replaceEntry: true,
            requireWriteSuccess: true,
            update: () => row,
          });
        } else {
          await upsertSessionEntry({ ...scope, entry: row });
        }
        const stored = loadSessionEntryReadOnly(scope);
        if (!stored) {
          throw new Error("Expected stored ACP session");
        }
        if (shape === "projected" && isDefault) {
          expect(stored.executionSelection).toEqual({
            state: "accepted",
            selection: previous,
            fallbackPermission: "explicit",
          });
        } else {
          expect(stored.executionSelection).toEqual({
            state: "deferred",
            request: {
              executor: previous.executor,
              model: isDefault ? { id: "prior" } : { provider: "fixture", id: "requested" },
            },
            fallbackPermission: isDefault ? "configured" : "explicit",
            ...(existing ? { previous } : {}),
          });
        }
        expect(stored.acp).toEqual({
          runtimeSessionName: "fixture-handle",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 1,
          runtimeOptions: { runtimeMode: "normal" },
        });
      });
    },
  );

  it.each([false, true])("stages a model with pin=%s without claiming acceptance", (pinned) => {
    const row = entry(pinned);
    expect(
      applyModelOverrideToSessionEntry({ entry: row, selection, markLiveSwitchPending: true }),
    ).toEqual({ updated: true });
    expect(row.executionSelection).toMatchObject({
      state: "deferred",
      request: { model: { provider: selection.provider, id: selection.model } },
      fallbackPermission: "explicit",
    });
    expect(row.agentRuntimeOverride).toBe(pinned ? "openclaw" : undefined);
    expect(row.liveModelSwitchPending).toBe(true);
    expect(applyModelOverrideToSessionEntry({ entry: row, selection })).toEqual({ updated: false });
  });

  it("clears the model without clearing the released runtime pin", () => {
    const row = entry();
    applyModelOverrideToSessionEntry({
      entry: row,
      selection: { ...selection, isDefault: true },
      explicitDefaultSelection: true,
    });
    expect(row.executionSelection).toMatchObject({
      state: "deferred",
      request: { executor: { kind: "harness", id: "openclaw" } },
      fallbackPermission: "configured",
    });
    expect(
      row.executionSelection?.state === "deferred" && row.executionSelection.request.model,
    ).toBeUndefined();
    expect(row.agentRuntimeOverride).toBe("openclaw");
    expect(row.modelOverride).toBeUndefined();
  });

  it("preserves a compatible account through the auth-aware setter", () => {
    const row = {
      ...entry(),
      authProfileOverride: "fixture-account",
      authProfileOverrideSource: "user" as const,
    };
    applyModelOverrideWithAuthProfileCompatibility({
      cfg: { auth: { profiles: { "fixture-account": { provider: "fixture", mode: "api_key" } } } },
      agentDir: "/nonexistent/sdk-agent",
      currentProvider: "fixture",
      entry: row,
      selection,
      metadataSnapshot: { plugins: [] },
    });
    expect(row.authProfileOverride).toBe("fixture-account");
    expect(row.executionSelection?.state).toBe("deferred");
  });

  it.each([applyModelOverrideToSessionEntry, applyModelOverrideWithAuthProfileCompatibility])(
    "refuses a locked selection without partial mutation",
    (setter) => {
      const row = { ...entry(), modelSelectionLocked: true };
      const before = structuredClone(row);
      expect(() =>
        setter({
          cfg: {},
          agentDir: "/nonexistent/sdk-agent",
          currentProvider: "fixture",
          entry: row,
          selection,
        }),
      ).toThrow(ModelSelectionLockedError);
      expect(row).toEqual(before);
    },
  );

  it.each([false, true])(
    "invalidates stale released caller observations and context, pending=%s",
    (pending) => {
      const row = {
        ...entry(),
        modelProvider: "observed",
        model: "observed-model",
        contextTokens: 4096,
        contextTokensSource: "runtime" as const,
        authProfileOverride: "old-account",
        authProfileOverrideSource: "user" as const,
      };
      applyModelOverrideToSessionEntry({
        entry: row,
        selection,
        profileOverride: "new-account",
        markLiveSwitchPending: pending,
      });
      expect(row.modelProvider).toBeUndefined();
      expect(row.model).toBeUndefined();
      expect(row.contextTokens).toBeUndefined();
      expect(row.contextTokensSource).toBeUndefined();
      expect(row.authProfileOverride).toBe("new-account");
      expect(row.liveModelSwitchPending).toBe(pending ? true : undefined);
    },
  );

  it.each(["auto", "user"] as const)("replaces an explicit default with a %s request", (source) => {
    const row = entry();
    applyModelOverrideToSessionEntry({
      entry: row,
      selection: { ...selection, isDefault: true },
      explicitDefaultSelection: true,
    });
    row.contextTokens = 4096;
    row.contextTokensSource = "runtime";
    applyModelOverrideToSessionEntry({
      entry: row,
      selection,
      selectionSource: source,
      markLiveSwitchPending: true,
    });
    expect(row.executionSelection).toMatchObject({
      state: "deferred",
      request: { model: { provider: selection.provider, id: selection.model } },
      fallbackPermission: source === "auto" ? "configured" : "explicit",
    });
    expect(row.contextTokens).toBeUndefined();
    expect(row.contextTokensSource).toBeUndefined();
    expect(row.liveModelSwitchPending).toBe(true);
  });

  it("invalidates context and signals a default reset", () => {
    const row = { ...entry(), contextTokens: 4096, contextTokensSource: "runtime" as const };
    applyModelOverrideToSessionEntry({
      entry: row,
      selection: { ...selection, isDefault: true },
      explicitDefaultSelection: true,
      markLiveSwitchPending: true,
    });
    expect(row.executionSelection).toMatchObject({
      state: "deferred",
      fallbackPermission: "configured",
    });
    expect(row.contextTokens).toBeUndefined();
    expect(row.contextTokensSource).toBeUndefined();
    expect(row.liveModelSwitchPending).toBe(true);
  });

  it("signals an account-only change while retaining the accepted pair", () => {
    const row = {
      ...entry(),
      authProfileOverride: "old-account",
      authProfileOverrideSource: "user" as const,
    };
    const before = structuredClone(row.executionSelection);
    applyModelOverrideToSessionEntry({
      entry: row,
      selection: { provider: "fixture", model: "before" },
      profileOverride: "new-account",
      markLiveSwitchPending: true,
    });
    expect(row.executionSelection).toEqual(before);
    expect(row.authProfileOverride).toBe("new-account");
    expect(row.liveModelSwitchPending).toBe(true);
  });

  it.each([false, true])("preserves account metadata only when requested=%s", (preserve) => {
    const row = {
      ...entry(),
      authProfileOverride: "fixture:account",
      authProfileOverrideSource: "user" as const,
      authProfileOverrideCompactionCount: 2,
    };
    applyModelOverrideToSessionEntry({
      entry: row,
      selection,
      preserveAuthProfileOverride: preserve,
    });
    expect(row.authProfileOverride).toBe(preserve ? "fixture:account" : undefined);
    expect(row.authProfileOverrideSource).toBe(preserve ? "user" : undefined);
    expect(row.authProfileOverrideCompactionCount).toBe(preserve ? 2 : undefined);
  });

  it("keeps released default/source semantics through a new user request", () => {
    const row = entry();
    applyModelOverrideToSessionEntry({
      entry: row,
      selection: { ...selection, isDefault: true },
      explicitDefaultSelection: true,
    });
    expect(row.modelOverrideSource).toBe("default");
    expect(row.modelOverride).toBeUndefined();
    applyModelOverrideToSessionEntry({ entry: row, selection });
    expect(row.executionSelection?.fallbackPermission).toBe("explicit");
    expect(row.modelOverrideSource).toBe("user");
  });

  it.each([
    [false, false, "user"],
    [false, true, "user"],
    [true, false, "user"],
    [true, true, "user"],
    [false, false, "auto"],
    [false, true, "auto"],
    [true, false, "auto"],
    [true, true, "auto"],
  ] as const)(
    "preserves released default intake across the store: auth=%s explicit=%s parent=%s",
    async (authAware, explicit, parentSource) => {
      await withOpenClawTestState({ label: "sdk-default-intake" }, async () => {
        const cfg = {
          agents: {
            defaults: {
              model: "fixture/default",
              models: { "fixture/default": {}, "fixture/parent": {} },
            },
          },
        };
        const parentKey = "agent:main:sdk-parent";
        const scope = { agentId: "main", sessionKey: "agent:main:sdk-child" };
        const parent = { ...entry(), sessionId: "sdk-parent" };
        applyModelOverrideToSessionEntry({
          entry: parent,
          selection: { provider: "fixture", model: "parent" },
          selectionSource: parentSource,
        });
        await upsertSessionEntry({ agentId: "main", sessionKey: parentKey, entry: parent });
        await upsertSessionEntry({
          ...scope,
          entry: {
            ...entry(),
            parentSessionKey: parentKey,
            modelProvider: "fixture",
            model: "observed",
          },
        });
        await patchSessionEntry({
          ...scope,
          replaceEntry: true,
          requireWriteSuccess: true,
          update: (row) => {
            const params = {
              entry: row,
              selection: { provider: "fixture", model: "default", isDefault: true },
              explicitDefaultSelection: explicit,
            };
            if (authAware) {
              applyModelOverrideWithAuthProfileCompatibility({
                ...params,
                cfg,
                agentDir: "/nonexistent/sdk-agent",
                currentProvider: "fixture",
                metadataSnapshot: { plugins: [] },
              });
            } else {
              applyModelOverrideToSessionEntry(params);
            }
            expect(row.modelOverrideSource).toBe(explicit ? "default" : undefined);
            return row;
          },
        });
        const loaded = getSessionEntry(scope);
        expect(loaded?.modelOverrideSource).toBe(explicit ? "default" : undefined);
        expect(resolvePersistedSessionRuntimeId(loaded)).toBe("openclaw");
        expect(loaded?.model).toBeUndefined();
        expect(loaded?.modelProvider).toBeUndefined();
        expect(
          resolveSessionModelRef(cfg, loaded, undefined, { allowPluginNormalization: false }),
        ).toEqual({ provider: "fixture", model: "default" });
        expect(
          resolveStoredModelOverride({
            sessionEntry: loaded,
            sessionKey: scope.sessionKey,
            parentSessionKey: parentKey,
            defaultProvider: "fixture",
            loadSessionEntry: (sessionKey) => getSessionEntry({ agentId: "main", sessionKey }),
            allowPluginNormalization: false,
          }),
        ).toEqual(
          explicit
            ? null
            : {
                provider: "fixture",
                model: "parent",
                source: "parent",
                routeResolution: "resolved",
              },
        );
        const canonical = loadSessionEntryReadOnly(scope);
        if (!canonical) {
          throw new Error("Expected deferred default selection");
        }
        const result = await applySessionExecutionSelection({
          cfg,
          ...scope,
          sessionEntry: canonical,
          modelCatalog: [
            { provider: "fixture", id: "parent", name: "Parent" },
            { provider: "fixture", id: "default", name: "Default" },
          ],
          request: { kind: "initialize" },
        });
        expect(result.status).toBe("applied");
        expect(loadSessionEntryReadOnly(scope)?.executionSelection).toEqual({
          state: "accepted",
          selection: {
            executor: { kind: "harness", id: "openclaw" },
            model: { provider: "fixture", id: explicit ? "default" : "parent" },
          },
          fallbackPermission: explicit || parentSource === "auto" ? "configured" : "explicit",
        });
      });
    },
  );

  it("does not accept an inherited model when its parent changes during preparation", async () => {
    await withOpenClawTestState({ label: "sdk-inherit-current-parent" }, async () => {
      const cfg = {
        agents: {
          defaults: {
            model: "fixture/default",
            models: { "fixture/default": {}, "fixture/before": {} },
          },
        },
      };
      const parentScope = { agentId: "main", sessionKey: "agent:main:sdk-parent" };
      const scope = { agentId: "main", sessionKey: "agent:main:sdk-child" };
      await upsertSessionEntry({ ...parentScope, entry: { ...entry(), sessionId: "sdk-parent" } });
      const child = { ...entry(), parentSessionKey: parentScope.sessionKey };
      applyModelOverrideToSessionEntry({
        entry: child,
        selection: { provider: "fixture", model: "default", isDefault: true },
      });
      await upsertSessionEntry({ ...scope, entry: child });
      const canonical = loadSessionEntryReadOnly(scope);
      if (!canonical) {
        throw new Error("Expected deferred inherited selection");
      }
      const before = structuredClone(canonical.executionSelection);
      vi.mocked(evaluatePublishedModelRuntimeChoice).mockImplementationOnce(async (params) => {
        const generation = getActivePluginRegistryVersion();
        await patchSessionEntry({
          ...parentScope,
          update: (row) => {
            applyModelOverrideToSessionEntry({
              entry: row,
              selection: { provider: "fixture", model: "changed" },
            });
            return row;
          },
        });
        return {
          kind: "ready",
          entry: { provider: params.provider, id: params.model, name: "Requested" },
          validate: () =>
            generation === getActivePluginRegistryVersion()
              ? undefined
              : "Prepared selection is no longer current.",
        };
      });
      const result = await applySessionExecutionSelection({
        cfg,
        ...scope,
        sessionEntry: canonical,
        modelCatalog: [{ provider: "fixture", id: "before", name: "Parent" }],
        request: { kind: "initialize" },
      });
      expect(result).toMatchObject({
        status: "rejected",
        message: "The parent session selection changed. Retry the turn.",
      });
      expect(loadSessionEntryReadOnly(scope)?.executionSelection).toEqual(before);
    });
  });

  it.each([false, true])(
    "round-trips fallback observations without rewriting previous selection; edited=%s",
    async (edited) => {
      await withOpenClawTestState({ label: "sdk-fallback-partial-request" }, async (testState) => {
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:sdk-fallback",
          storePath: testState.path("alternate", "sessions.json"),
        };
        await upsertSessionEntry({ ...scope, entry: entry(false) });
        await patchSessionEntry({
          ...scope,
          update: () => ({
            providerOverride: "pending",
            modelProvider: "observed-provider",
            model: "observed-model",
          }),
        });
        const staged = loadSessionEntryReadOnly(scope);
        if (!staged) {
          throw new Error("Expected the staged session");
        }
        const applied = await applySessionExecutionSelection({
          cfg: { agents: { defaults: { model: "fixture/default" } } },
          ...scope,
          sessionEntry: staged,
          sessionStore: { [scope.sessionKey]: staged },
          modelCatalog: [{ provider: "fixture", id: "default", name: "Default" }],
          request: { kind: "initialize" },
        });
        expect(applied.status).toBe("applied");
        const previous = loadSessionEntryReadOnly(scope);
        if (!previous?.model || !previous.modelProvider) {
          throw new Error("Expected the recorded observation at the fallback boundary");
        }
        const snapshot = createAgentPatchedSessionModelFallback({
          entry: previous,
          provider: previous.modelProvider,
          model: previous.model,
          ts: 10,
        });
        await replaceSessionEntry(scope, { ...previous, modelFallback: snapshot });
        const view = getSessionEntry(scope);
        if (!view?.modelFallback) {
          throw new Error("Expected the released fallback view");
        }
        expect(view.modelFallback).toMatchObject({
          prevProvider: "observed-provider",
          prevModel: "observed-model",
          prevProviderOverride: "pending",
        });
        expect(view.modelFallback.prevModelOverride).toBeUndefined();
        const publicFallback = view.modelFallback;
        if (edited) {
          await patchSessionEntry({
            ...scope,
            update: () => ({ modelFallback: { ...publicFallback, lastValidatedPatchTs: 20 } }),
          });
        } else {
          await upsertSessionEntry({ ...scope, entry: view });
        }
        const after = getSessionEntry(scope);
        expect(after?.modelFallback).toEqual({
          ...view.modelFallback,
          ...(edited ? { lastValidatedPatchTs: 20 } : {}),
        });
        const stored = loadSessionEntryReadOnly(scope);
        expect(stored?.executionSelection).toEqual(previous.executionSelection);
        const restored = stored?.modelFallback?.previous;
        expect(restored?.legacyRequest).toEqual({ provider: "pending" });
        expect(restored).toEqual(previous.executionSelection);
      });
    },
  );

  it("rolls back an SDK auto-fallback marker to its requested origin, not its observed route", async () => {
    await withOpenClawTestState({ label: "sdk-rollback-origin" }, async (testState) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:sdk-rollback",
        storePath: testState.path("alternate", "sessions.json"),
      };
      const cfg = {
        agents: {
          defaults: {
            model: "fixture/origin",
            models: {
              "fixture/origin": {},
              "fixture/before": {},
              "alternate/fallback": {},
            },
          },
        },
      };
      await upsertSessionEntry({
        ...scope,
        entry: {
          ...entry(false),
          providerOverride: "alternate",
          modelOverride: "fallback",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "fixture",
          modelOverrideFallbackOriginModel: "origin",
        },
      });
      expect(resolveSessionModelRef(cfg, getSessionEntry(scope), "main")).toEqual({
        provider: "fixture",
        model: "origin",
      });
      await patchSessionEntry({
        ...scope,
        update: () => ({
          providerOverride: "fixture",
          modelOverride: "before",
          modelFallback: {
            prevModel: "observed-model",
            prevProvider: "observed-provider",
            prevModelOverride: "fallback",
            prevProviderOverride: "alternate",
            prevModelOverrideSource: "auto",
            prevModelOverrideFallbackOriginProvider: "fixture",
            prevModelOverrideFallbackOriginModel: "origin",
            ts: 10,
            source: "agent-patch",
          },
        }),
      });
      expect(getSessionEntry(scope)?.modelFallback).toMatchObject({
        prevModel: "observed-model",
        prevProvider: "observed-provider",
        prevModelOverride: "origin",
        prevProviderOverride: "fixture",
      });
      const run = createAgentPatchedSessionModelRunGuard({ cfg, ...scope });
      await run.fail(new Error("Selected model does not exist"), "model_not_found");
      const restored = getSessionEntry(scope);
      expect(resolveSessionModelRef(cfg, restored, "main")).toEqual({
        provider: "fixture",
        model: "origin",
      });
      expect(restored).toMatchObject({
        modelProvider: "observed-provider",
        model: "observed-model",
      });
      expect(restored?.modelFallback).toBeUndefined();
    });
  });

  it.each([false, true])(
    "keeps provider-only input incomplete after configured preparation; explicit=%s",
    async (explicit) => {
      await withOpenClawTestState(
        { label: "sdk-provider-after-preparation" },
        async (testState) => {
          const scope = {
            agentId: "main",
            sessionKey: "agent:main:sdk",
            storePath: testState.path("sessions.json"),
          };
          const cfg = { agents: { defaults: { model: "fixture/default" } } };
          await upsertSessionEntry({
            ...scope,
            entry: {
              ...entry(false),
              ...(explicit ? { providerOverride: "fixture", modelOverride: "default" } : {}),
            },
          });
          const prepare = async () => {
            const current = loadSessionEntryReadOnly(scope);
            if (!current) {
              throw new Error("Expected the stored session");
            }
            const result = await applySessionExecutionSelection({
              ...scope,
              cfg,
              sessionEntry: current,
              sessionStore: { [scope.sessionKey]: current },
              modelCatalog: [
                { provider: "fixture", id: "default", name: "Default" },
                { provider: "pending", id: "default", name: "Other" },
                { provider: "pending", id: "later", name: "Later" },
              ],
              request: { kind: "initialize" },
            });
            expect(result.status).toBe("applied");
          };
          await prepare();
          const configuredView = getSessionEntry(scope);
          const changedConfig = { agents: { defaults: { model: "fixture/changed" } } };
          expect(resolveSessionModelRef(changedConfig, configuredView, "main")).toEqual({
            provider: "fixture",
            model: "default",
          });
          expect(
            resolveStoredModelOverride({
              sessionEntry: configuredView,
              defaultProvider: "fixture",
              sessionKey: scope.sessionKey,
              parentSessionKey: "agent:main:parent",
              sessionStore: { "agent:main:parent": entry() },
            }),
          ).toMatchObject({ provider: "fixture", model: "default", source: "session" });
          await patchSessionEntry({ ...scope, update: () => ({ providerOverride: "pending" }) });
          await prepare();
          await patchSessionEntry({
            ...scope,
            update: () => ({ modelProvider: "observed", model: "observed-model" }),
          });
          const partial = getSessionEntry(scope);
          expect(partial?.providerOverride).toBe("pending");
          expect(partial?.modelOverride).toBe(explicit ? "default" : undefined);
          expect(resolveSessionModelRef(cfg, partial, "main")).toEqual({
            provider: explicit ? "pending" : "fixture",
            model: "default",
          });
          await patchSessionEntry({ ...scope, update: () => ({ modelOverride: "later" }) });
          await prepare();
          expect(resolveSessionModelRef(cfg, getSessionEntry(scope), "main")).toEqual({
            provider: "pending",
            model: "later",
          });
          expect(
            loadSessionEntryReadOnly(scope)?.executionSelection?.legacyRequest,
          ).toBeUndefined();
        },
      );
    },
  );

  it("clears an accepted model through configured initialization while preserving the provider and runtime", async () => {
    await withOpenClawTestState({ label: "sdk-clear-accepted-model" }, async (testState) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:sdk",
        storePath: testState.path("sessions.json"),
      };
      const cfg = { agents: { defaults: { model: "fixture/default" } } };
      await upsertSessionEntry({ ...scope, entry: entry() });
      await patchSessionEntry({ ...scope, update: () => ({ modelOverride: undefined }) });
      const current = loadSessionEntryReadOnly(scope);
      expect(current?.executionSelection).toMatchObject({
        state: "deferred",
        request: { defaultSelection: "configured", runtime: "openclaw" },
        legacyRequest: { provider: "fixture" },
      });
      if (!current) {
        throw new Error("Expected the reset session");
      }
      const result = await applySessionExecutionSelection({
        ...scope,
        cfg,
        sessionEntry: current,
        sessionStore: { [scope.sessionKey]: current },
        modelCatalog: [{ provider: "fixture", id: "default", name: "Default" }],
        request: { kind: "initialize" },
      });
      expect(result.status).toBe("applied");
      const view = getSessionEntry(scope);
      expect(resolveSessionModelRef(cfg, view, "main")).toEqual({
        provider: "fixture",
        model: "default",
      });
      expect(view?.modelOverride).toBeUndefined();
      expect(view?.providerOverride).toBe("fixture");
      expect(view?.agentRuntimeOverride).toBe("openclaw");
    });
  });

  it.each(["auto", "user"] as const)(
    "prepares and commits a staged %s request through the async API",
    async (source) => {
      await withOpenClawTestState({ label: "sdk-stage-initialize" }, async () => {
        const row = entry();
        applyModelOverrideToSessionEntry({ entry: row, selection, selectionSource: source });
        const sessionKey = "agent:main:sdk";
        const scope = { agentId: "main", sessionKey };
        await upsertSessionEntry({ ...scope, entry: row });
        const canonical = loadSessionEntryReadOnly(scope);
        if (!canonical) {
          throw new Error("Expected staged session");
        }
        const sessionStore = { [sessionKey]: canonical };
        const result = await applySessionExecutionSelection({
          cfg: {
            agents: {
              defaults: {
                model: "fixture/default",
                models: { "fixture/default": {}, "fixture/family/after": {} },
              },
            },
          },
          agentId: "main",
          sessionKey,
          sessionEntry: canonical,
          sessionStore,
          modelCatalog: [{ provider: "fixture", id: "family/after", name: "Requested" }],
          request: { kind: "initialize" },
        });
        expect(result.status).toBe("applied");
        expect(sessionStore[sessionKey].executionSelection).toEqual({
          state: "accepted",
          selection: {
            model: { provider: "fixture", id: "family/after" },
            executor: { kind: "harness", id: "openclaw" },
          },
          fallbackPermission: source === "auto" ? "configured" : "explicit",
        });
      });
    },
  );
});
