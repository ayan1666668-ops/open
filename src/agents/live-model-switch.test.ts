import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { encodeSessionExecutionSelection } from "../model-picker/execution-selection-codec.js";
import type { ModelExecutionSelection } from "../model-picker/execution-selection.js";
import {
  clearLiveModelSwitchPending,
  consolidateLiveModelSwitchAfterRun,
  shouldSwitchToLiveModel,
} from "./live-model-switch.js";

const state = vi.hoisted(() => ({
  entry: undefined as SessionEntry | undefined,
  beforePatch: undefined as (() => void) | undefined,
  read: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("../model-picker/execution-selection-state.js", async () => {
  const { decodeSessionExecutionSelection } =
    await import("../model-picker/execution-selection-codec.js");
  return {
    getSessionExecutionSelection: (entry: SessionEntry | undefined) => {
      const decoded = decodeSessionExecutionSelection(entry, {
        classifyExecutor: (id) =>
          id === "openclaw" || id === "fixture-app"
            ? "harness"
            : id === "fixture-cli"
              ? "cli"
              : undefined,
      });
      return decoded.kind === "initialized" ? decoded.selection : undefined;
    },
  };
});

vi.mock("../config/sessions/session-accessor.js", () => ({
  loadSessionEntryReadOnly: (...args: unknown[]) => {
    state.read(...args);
    return state.entry;
  },
  patchSessionEntryCore: async (
    _scope: unknown,
    update: (entry: SessionEntry) => SessionEntry | null,
  ) => {
    state.patch();
    state.beforePatch?.();
    if (!state.entry) {
      return null;
    }
    const next = update(state.entry);
    if (next) {
      state.entry = next;
    }
    return state.entry;
  },
}));
vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: () => "/fixture/store.sqlite",
}));

const selection: ModelExecutionSelection = {
  model: { provider: "fixture", id: "first" },
  executor: { kind: "harness", id: "openclaw" },
};
const cfg = { session: { store: "/fixture/store.sqlite" } };
const scope = { cfg, sessionKey: "agent:reply:main", agentId: "reply" };
const current = {
  ...scope,
  currentExecution: selection,
};
function storeSelection(pair = selection, fields: Partial<SessionEntry> = {}) {
  const entry: SessionEntry = {
    sessionId: "session",
    updatedAt: 1,
    liveModelSwitchPending: true,
    ...fields,
  };
  encodeSessionExecutionSelection(entry, pair, { kind: "user" });
  state.entry = entry;
  return entry;
}

beforeEach(() => {
  state.entry = undefined;
  state.beforePatch = undefined;
  state.read.mockClear();
  state.patch.mockClear();
});

describe("pending live selection", () => {
  it("returns the accepted pair instead of defaults or observed history", () => {
    const selected: ModelExecutionSelection = {
      ...selection,
      model: { provider: "alternate", id: "nested/model" },
    };
    storeSelection(selected, { modelProvider: "historical", model: "past" });
    expect(shouldSwitchToLiveModel(current)).toEqual({
      selection: selected,
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("restarts when only the accepted executor changes", () => {
    const selected: ModelExecutionSelection = {
      ...selection,
      executor: { kind: "cli", id: "fixture-cli" },
    };
    storeSelection(selected);
    expect(shouldSwitchToLiveModel(current)?.selection).toEqual(selected);
  });

  it("restarts when the account pin or its source changes", () => {
    storeSelection(selection, {
      authProfileOverride: "account-a",
      authProfileOverrideSource: "user",
    });
    expect(
      shouldSwitchToLiveModel({
        ...current,
        currentAuthProfileId: "account-a",
        currentAuthProfileIdSource: "auto",
      }),
    ).toMatchObject({ selection, authProfileId: "account-a", authProfileIdSource: "user" });
  });

  it("consumes the pending flag when the accepted pair and account already run", async () => {
    storeSelection();
    expect(
      shouldSwitchToLiveModel({ ...current, currentAuthProfileIdSource: "auto" }),
    ).toBeUndefined();
    await vi.waitFor(() => expect(state.patch).toHaveBeenCalledOnce());
    expect(state.entry?.liveModelSwitchPending).toBeUndefined();
  });

  it("does not infer an accepted pair from a partial row or observed executor", () => {
    state.entry = {
      sessionId: "session",
      updatedAt: 1,
      liveModelSwitchPending: true,
      providerOverride: "fixture",
      modelOverride: "second",
      agentHarnessId: "fixture-app",
    };
    expect(shouldSwitchToLiveModel(current)).toBeUndefined();
    expect(state.patch).not.toHaveBeenCalled();
  });

  it("does not restart without a pending command", () => {
    storeSelection(
      { ...selection, model: { provider: "fixture", id: "second" } },
      { liveModelSwitchPending: false },
    );
    expect(shouldSwitchToLiveModel(current)).toBeUndefined();
    expect(state.patch).not.toHaveBeenCalled();
  });

  it.each([
    { sessionKey: undefined },
    { sessionPersistence: "detached" as const },
    { cfg: undefined },
  ])("does not consume another session's live switch: %j", (overrides) => {
    storeSelection();
    expect(shouldSwitchToLiveModel({ ...current, ...overrides })).toBeUndefined();
    expect(state.read).not.toHaveBeenCalled();
    expect(state.patch).not.toHaveBeenCalled();
  });

  it("reads the latest authoritative row", () => {
    storeSelection({ ...selection, model: { provider: "fixture", id: "second" } });
    shouldSwitchToLiveModel(current);
    expect(state.read).toHaveBeenCalledWith({
      sessionKey: scope.sessionKey,
      storePath: "/fixture/store.sqlite",
      hydrateSkillPromptRefs: false,
      clone: false,
      readConsistency: "latest",
    });
  });
});

describe("completed live selection", () => {
  it("clears the pending flag after the accepted model ran", async () => {
    storeSelection(selection, {
      authProfileOverride: "account-a",
      authProfileOverrideSource: "user",
    });
    await consolidateLiveModelSwitchAfterRun({
      ...scope,
      providerUsed: "fixture",
      modelUsed: "first",
    });
    expect(state.entry?.liveModelSwitchPending).toBeUndefined();
    expect(state.entry?.authProfileOverride).toBe("account-a");
  });

  it("keeps the flag when a fallback model ran", async () => {
    storeSelection();
    await consolidateLiveModelSwitchAfterRun({
      ...scope,
      providerUsed: "fixture",
      modelUsed: "fallback",
    });
    expect(state.entry?.liveModelSwitchPending).toBe(true);
  });

  it("does not consume a newer selection committed before consolidation", async () => {
    storeSelection();
    state.beforePatch = () => {
      storeSelection({ ...selection, model: { provider: "fixture", id: "newer" } });
    };
    await consolidateLiveModelSwitchAfterRun({
      ...scope,
      providerUsed: "fixture",
      modelUsed: "first",
    });
    expect(state.entry?.liveModelSwitchPending).toBe(true);
    expect(state.entry?.modelOverride).toBe("newer");
  });

  it("clears a default reset using its committed pair even after config changes", async () => {
    storeSelection();
    await consolidateLiveModelSwitchAfterRun({
      ...scope,
      cfg: { ...cfg, agents: { defaults: { model: "other/configured" } } },
      providerUsed: "fixture",
      modelUsed: "first",
    });
    expect(state.entry?.liveModelSwitchPending).toBeUndefined();
  });

  it("leaves the row untouched when no flag exists", async () => {
    const entry = storeSelection(selection, { liveModelSwitchPending: undefined });
    await consolidateLiveModelSwitchAfterRun({
      ...scope,
      providerUsed: "fixture",
      modelUsed: "first",
    });
    expect(state.entry).toBe(entry);
  });

  it("clears a requested flag without changing the accepted pair", async () => {
    storeSelection();
    await clearLiveModelSwitchPending(scope);
    expect(state.entry?.liveModelSwitchPending).toBeUndefined();
    expect(state.entry?.modelOverride).toBe("first");
    expect(state.entry?.agentRuntimeOverride).toBe("openclaw");
  });
});
