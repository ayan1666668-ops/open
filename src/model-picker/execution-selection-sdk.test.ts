import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  applyModelOverrideToSessionEntry,
  applyModelOverrideWithAuthProfileCompatibility,
  ModelSelectionLockedError,
} from "../plugin-sdk/model-session-runtime.js";
import {
  prepareSessionExecutionSelection,
  commitSessionExecutionSelection,
} from "./apply-session-model-selection.js";
import {
  admitSessionExecutionFallback,
  decodeSessionExecutionSelection,
  encodeSessionExecutionSelection,
  encodeAcpExecutionSelection,
  consumeLegacySessionExecutionSeed,
} from "./execution-selection-codec.js";

vi.mock("../agents/model-runtime-choice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/model-runtime-choice.js")>()),
  evaluatePublishedModelRuntimeChoice: vi.fn(
    async (params: { runtimeId: string; provider: string; model: string }) =>
      params.runtimeId === "openclaw"
        ? {
            kind: "ready" as const,
            entry: { provider: params.provider, id: params.model, name: "Requested" },
            validate: () => undefined,
          }
        : { kind: "unknown" as const, message: "No prepared executor" },
  ),
}));

import type { ModelExecutionSelection } from "./execution-selection.js";

const metadata = {
  defaultProvider: "qa-route",
  classifyExecutor: (id: string) => (id === "openclaw" ? ("harness" as const) : undefined),
};
const initial: ModelExecutionSelection = {
  model: { provider: "qa-route", id: "qa-original" },
  executor: { kind: "harness", id: "openclaw" },
};
const nextModel = { provider: "qa-route", id: "qa-route/family/qa-selected" };
const fallback: ModelExecutionSelection = {
  model: { provider: "qa-backup", id: "qa-fallback" },
  executor: { kind: "harness", id: "openclaw" },
};
function entry(): SessionEntry {
  return { sessionId: "qa-sdk", updatedAt: 1, delivery: { kind: "none" } };
}

describe("released model-selection SDK compatibility adapters", () => {
  it.each([false, true])(
    "stages an exact model with existing pin=%s without accepting an executor",
    (pinned) => {
      const row = entry();
      if (pinned) {
        encodeSessionExecutionSelection(row, initial, { kind: "user" });
      }
      const result = applyModelOverrideToSessionEntry({
        entry: row,
        selection: { provider: nextModel.provider, model: nextModel.id },
        markLiveSwitchPending: true,
      });
      expect(result).toEqual({ updated: true });
      expect(decodeSessionExecutionSelection(row, metadata)).toEqual({
        kind: "uninitialized",
        model: nextModel,
        ...(pinned ? { executor: initial.executor } : {}),
      });
      expect(row.agentRuntimeOverride).toBe(pinned ? "openclaw" : undefined);
      expect(row.liveModelSwitchPending).toBe(true);
      expect(admitSessionExecutionFallback({ entry: row, candidate: fallback, metadata })).toEqual({
        status: "rejected",
        reason: "user-model-selection",
      });
      expect(
        applyModelOverrideToSessionEntry({
          entry: row,
          selection: { provider: nextModel.provider, model: nextModel.id },
        }),
      ).toEqual({ updated: false });
    },
  );

  it("retains automatic permission while preparing the pinned executor for the next turn", () => {
    const row = entry();
    encodeSessionExecutionSelection(row, initial, { kind: "initialize" });
    applyModelOverrideToSessionEntry({
      entry: row,
      selection: { provider: nextModel.provider, model: nextModel.id },
      selectionSource: "auto",
    });
    expect(decodeSessionExecutionSelection(row, metadata)).toEqual({
      kind: "uninitialized",
      model: nextModel,
      executor: initial.executor,
    });
    expect(admitSessionExecutionFallback({ entry: row, candidate: fallback, metadata })).toEqual({
      status: "admitted",
      selection: fallback,
    });
  });

  it.each([false, true])(
    "retains the runtime pin when clearing the model with explicitDefault=%s",
    (explicitDefaultSelection) => {
      const row = entry();
      encodeSessionExecutionSelection(row, initial, { kind: "user" });
      applyModelOverrideToSessionEntry({
        entry: row,
        selection: { provider: "qa-route", model: "qa-default", isDefault: true },
        explicitDefaultSelection,
      });
      expect(decodeSessionExecutionSelection(row, metadata)).toEqual({
        kind: "uninitialized",
        executor: initial.executor,
      });
      expect(row.agentRuntimeOverride).toBe("openclaw");
      expect(row.modelOverride).toBeUndefined();
      expect(row.providerOverride).toBeUndefined();
    },
  );

  it("retains compatible account intent through the auth-aware SDK entry point", () => {
    const row = {
      ...entry(),
      authProfileOverride: "qa-account",
      authProfileOverrideSource: "user" as const,
    };
    applyModelOverrideWithAuthProfileCompatibility({
      cfg: { auth: { profiles: { "qa-account": { provider: "qa-route", mode: "api_key" } } } },
      agentDir: "/nonexistent/qa-sdk-agent",
      currentProvider: "qa-route",
      entry: row,
      selection: { provider: nextModel.provider, model: nextModel.id },
      metadataSnapshot: { plugins: [] },
    });
    expect(row.authProfileOverride).toBe("qa-account");
    expect(decodeSessionExecutionSelection(row, metadata)).toEqual({
      kind: "uninitialized",
      model: nextModel,
    });
  });

  it("preserves the released lock error and performs no partial mutation", () => {
    const row = { ...entry(), modelSelectionLocked: true };
    const before = structuredClone(row);
    expect(() =>
      applyModelOverrideToSessionEntry({
        entry: row,
        selection: { provider: nextModel.provider, model: nextModel.id },
      }),
    ).toThrow(ModelSelectionLockedError);
    expect(row).toEqual(before);
  });
  it("stages ACP model input without replacing its binding, then clears only the consumed request", () => {
    const binding = { kind: "acp" as const, backend: "qa-backend", agent: "qa-agent" };
    const row = entry();
    row.acp = encodeAcpExecutionSelection(
      { runtimeSessionName: "qa-native", mode: "persistent", state: "idle", lastActivityAt: 1 },
      { executor: binding, model: { id: "qa-old" } },
    );
    applyModelOverrideToSessionEntry({
      entry: row,
      selection: { provider: nextModel.provider, model: nextModel.id },
    });
    expect(decodeSessionExecutionSelection(row, metadata)).toEqual({
      kind: "uninitialized",
      executor: binding,
      model: nextModel,
    });
    const captured = structuredClone(row);
    const newer = structuredClone(row);
    applyModelOverrideToSessionEntry({
      entry: newer,
      selection: { provider: "qa-route", model: "qa-newer" },
    });
    expect(consumeLegacySessionExecutionSeed(newer, captured)).toBe(false);
    expect(newer.modelOverride).toBe("qa-newer");
    expect(consumeLegacySessionExecutionSeed(row, captured)).toBe(true);
    expect(row.acp).toEqual(captured.acp);
  });

  it.each([false, true])(
    "preserves ACP default semantics with explicitDefault=%s",
    (explicitDefaultSelection) => {
      const binding = { kind: "acp" as const, backend: "qa-backend", agent: "qa-agent" };
      const pair = { executor: binding, model: { id: "qa-native-model" } };
      const row = entry();
      row.acp = encodeAcpExecutionSelection(
        { runtimeSessionName: "qa-native", mode: "persistent", state: "idle", lastActivityAt: 1 },
        pair,
      );
      applyModelOverrideToSessionEntry({
        entry: row,
        selection: { provider: "qa-route", model: "qa-default", isDefault: true },
        explicitDefaultSelection,
      });
      expect(decodeSessionExecutionSelection(row, metadata)).toEqual(
        explicitDefaultSelection
          ? { kind: "uninitialized", executor: binding }
          : { kind: "initialized", selection: pair },
      );
    },
  );
  it.each(["user", "auto"] as const)(
    "prepares a staged %s model with its retained pin, then commits one accepted pair",
    async (selectionSource) => {
      const stagedModel = { provider: "qa-route", id: "qa-next" };
      const row = entry();
      encodeSessionExecutionSelection(row, initial, { kind: "user" });
      applyModelOverrideToSessionEntry({
        entry: row,
        selection: { provider: stagedModel.provider, model: stagedModel.id },
        selectionSource,
      });
      const prepared = await prepareSessionExecutionSelection({
        cfg: {
          agents: {
            defaults: {
              model: "qa-config/qa-default",
              models: {
                "qa-config/qa-default": {},
                [`${stagedModel.provider}/${stagedModel.id}`]: { agentRuntime: { id: "qa-other" } },
              },
            },
          },
        },
        agentId: "main",
        sessionEntry: row,
        modelCatalog: [{ provider: stagedModel.provider, id: stagedModel.id, name: "Requested" }],
        request: { kind: "initialize" },
      });
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") {
        throw new Error(prepared.message);
      }
      expect(prepared.selection).toEqual({ model: stagedModel, executor: initial.executor });
      commitSessionExecutionSelection(row, prepared.selection, { cause: { kind: "initialize" } });
      expect(decodeSessionExecutionSelection(row, metadata)).toEqual({
        kind: "initialized",
        selection: prepared.selection,
      });
      expect(
        admitSessionExecutionFallback({ entry: row, candidate: fallback, metadata }).status,
      ).toBe(selectionSource === "auto" ? "admitted" : "rejected");
    },
  );
});
