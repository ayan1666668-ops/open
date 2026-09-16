import { describe, expect, it, vi } from "vitest";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  applyModelOverrideToSessionEntry,
  applyModelOverrideWithAuthProfileCompatibility,
  applySessionExecutionSelection,
  ModelSelectionLockedError,
} from "../plugin-sdk/model-session-runtime.js";
import { projectPluginSessionEntry } from "../plugin-sdk/session-store-runtime-internal.js";
import { patchSessionEntry, type SessionEntry } from "../plugin-sdk/session-store-runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

vi.mock("../agents/model-runtime-choice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/model-runtime-choice.js")>()),
  evaluatePublishedModelRuntimeChoice: vi.fn(
    async (params: { runtimeId: string; provider: string; model: string }) => ({
      kind: "ready" as const,
      entry: { provider: params.provider, id: params.model, name: "Requested" },
      validate: () => undefined,
    }),
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

  it.each(["auto", "user"] as const)(
    "prepares and commits a staged %s request through the async API",
    async (source) => {
      const row = entry();
      applyModelOverrideToSessionEntry({ entry: row, selection, selectionSource: source });
      const sessionKey = "agent:main:sdk";
      // The host loads the canonical entry after the public setter has staged its request.
      const { acp: _acp, modelFallback: _fallback, ...canonical } = row;
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
    },
  );
});
