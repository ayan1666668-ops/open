import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, expectTypeOf, test, vi } from "vitest";
import * as acpManager from "../acp/control-plane/manager.js";
import { evaluatePublishedModelRuntimeChoice } from "../agents/model-runtime-choice.js";
import type { ModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { admitSessionExecutionFallback } from "../model-picker/apply-session-model-selection.js";
import { getActivePluginRegistryVersion } from "../plugins/runtime.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acceptedModelSelection } from "../test-utils/session-execution-selection.js";
import {
  applySessionModelSelection,
  type ApplySessionModelSelectionParams,
} from "./model-session-runtime.js";
import { projectPluginSessionEntry } from "./session-store-runtime-internal.js";

vi.mock("../agents/model-runtime-choice.js", () => ({
  evaluatePublishedModelRuntimeChoice: vi.fn(),
}));
const scope = { agentId: "main", sessionKey: "agent:main:sdk" };
const ordinary = {
  sessionId: "sdk-session",
  updatedAt: 1,
  executionSelection: acceptedModelSelection("fixture", "before", {
    fallbackPermission: "configured",
  }),
} satisfies SessionEntry;
function request(entry: SessionEntry = ordinary): ApplySessionModelSelectionParams {
  const publicEntry = projectPluginSessionEntry(entry);
  return {
    cfg: { agents: { defaults: { model: "fixture/before" } } },
    ...scope,
    sessionEntry: publicEntry,
    sessionStore: { [scope.sessionKey]: publicEntry },
    defaultProvider: "fixture",
    defaultModel: "before",
    currentProvider: "fixture",
    currentModel: "before",
    modelCatalog: [
      { provider: "fixture", id: "requested", name: "Requested", contextTokens: 4096 },
    ],
    request: {
      provider: "fixture",
      model: "requested",
      isDefault: false,
      runtime: { kind: "unchanged" },
    },
    markLiveSwitchPending: true,
  };
}
beforeEach(() => {
  vi.mocked(evaluatePublishedModelRuntimeChoice)
    .mockReset()
    .mockImplementation(async () => {
      const generation = getActivePluginRegistryVersion();
      return {
        kind: "ready",
        entry: { provider: "fixture", id: "requested", name: "Requested", contextTokens: 4096 },
        validate: () =>
          generation === getActivePluginRegistryVersion()
            ? undefined
            : "Prepared selection is no longer current.",
      };
    });
});
afterEach(() => vi.restoreAllMocks());

test("the released operation returns all flat fields for a caller absent from the map", async () => {
  await withOpenClawTestState({ label: "sdk-flat-selection" }, async () => {
    const params = request();
    delete params.sessionStore[scope.sessionKey];
    const result = await applySessionModelSelection(params);
    expect(result).toMatchObject({
      status: "applied",
      provider: "fixture",
      model: "requested",
      effectiveModelRef: "fixture/requested",
      agentRuntime: "openclaw",
      contextTokens: 4096,
    });
    expect(params.sessionEntry).toMatchObject({
      providerOverride: "fixture",
      modelOverride: "requested",
      agentRuntimeOverride: "openclaw",
    });
    expect(params.sessionStore[scope.sessionKey]).toEqual(params.sessionEntry);
    if (result.status !== "applied") {
      throw new Error("Expected accepted ordinary selection");
    }
    expectTypeOf(result.provider).toEqualTypeOf<string>();
    expectTypeOf(result.model).toEqualTypeOf<string>();
    expectTypeOf(result.effectiveModelRef).toEqualTypeOf<string>();
    expectTypeOf(result.agentRuntime).toEqualTypeOf<string>();
    expectTypeOf(result.contextTokens).toEqualTypeOf<number>();
    expectTypeOf<ApplySessionModelSelectionParams["modelPolicy"]>().toEqualTypeOf<
      ModelVisibilityPolicy | undefined
    >();
  });
});

test("keeps accepted memory-only selections idempotent", async () => {
  await withOpenClawTestState({ label: "sdk-memory-selection" }, async () => {
    const selected = acceptedModelSelection("fixture", "requested");
    const params = request({ ...ordinary, executionSelection: selected });
    params.currentModel = "requested";
    const events: string[] = [];
    const unsubscribe = onSessionLifecycleEvent((event) => events.push(event.reason));
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await applySessionModelSelection(params)).toMatchObject({
          status: "applied",
          changed: false,
        });
        expect(params.sessionEntry.executionSelection).toEqual(selected);
        expect(params.sessionEntry.liveModelSwitchPending).toBeUndefined();
      }
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
    }
  });
});

test.each([
  { change: "model", legacy: false },
  { change: "account", legacy: false },
  { change: "metadata", legacy: false },
  { change: "model", legacy: true },
] as const)(
  "preserves a same-lifecycle persisted $change change against an older SDK snapshot (legacy=$legacy)",
  async ({ change, legacy }) => {
    await withOpenClawTestState({ label: "sdk-stale-selection" }, async () => {
      await replaceSessionEntry(scope, ordinary);
      const original = expectDefined(loadSessionEntryReadOnly(scope), "SDK caller snapshot");
      const params = request(original);
      if (legacy) {
        delete params.sessionEntry.executionSelection;
      }
      params.storePath = resolveSessionStorePathCore(undefined, { agentId: scope.agentId });
      const latest = {
        ...original,
        ...(change === "model"
          ? { executionSelection: acceptedModelSelection("fixture", "newer") }
          : change === "account"
            ? { authProfileOverride: "fixture:newer", authProfileOverrideSource: "user" as const }
            : { label: "newer metadata" }),
      };
      await replaceSessionEntry(scope, latest);
      const persisted = loadSessionEntryReadOnly(scope);
      const before = structuredClone(params.sessionEntry);
      const result = await applySessionModelSelection(params);
      if (change === "metadata") {
        expect(result.status).toBe("applied");
        expect(loadSessionEntryReadOnly(scope)?.label).toBe("newer metadata");
      } else {
        expect(result.status).toBe("conflict");
        expect(params.sessionEntry).toEqual(before);
        expect(loadSessionEntryReadOnly(scope)).toEqual(persisted);
      }
    });
  },
);

test.each([false, true])(
  "preserves caller default authorization=%s for a concrete primary",
  async (isDefault) => {
    await withOpenClawTestState({ label: "sdk-primary-authorization" }, async () => {
      const params = request();
      params.cfg = { agents: { defaults: { model: "fixture/requested" } } };
      params.defaultModel = "requested";
      params.request.isDefault = isDefault;
      expect(await applySessionModelSelection(params)).toMatchObject({ status: "applied" });
      expect(params.sessionEntry.executionSelection).toEqual(
        acceptedModelSelection("fixture", "requested", {
          fallbackPermission: isDefault ? "configured" : "explicit",
        }),
      );
      expect(
        admitSessionExecutionFallback({
          entry: { executionSelection: params.sessionEntry.executionSelection },
          candidate: {
            model: { provider: "fixture", id: "backup" },
            executor: { kind: "harness", id: "openclaw" },
          },
        }).status,
      ).toBe(isDefault ? "accepted" : "rejected");
    });
  },
);

test.each([
  { name: "set", before: "cli", runtime: { kind: "set", runtime: "openclaw" }, changed: true },
  {
    name: "set idempotently",
    before: "harness",
    runtime: { kind: "set", runtime: "openclaw" },
    changed: false,
  },
  { name: "clear", before: "cli", runtime: { kind: "clear" }, changed: true },
  { name: "clear idempotently", before: "harness", runtime: { kind: "clear" }, changed: false },
  { name: "leave unchanged", before: "harness", runtime: { kind: "unchanged" }, changed: false },
] as const)(
  "preserves the released runtime result when asked to $name",
  async ({ before, runtime, changed }) => {
    await withOpenClawTestState({ label: "sdk-runtime-result" }, async () => {
      const entry: SessionEntry = {
        ...ordinary,
        executionSelection: acceptedModelSelection("fixture", "requested", {
          executor:
            before === "cli"
              ? { kind: "cli", id: "fixture-cli" }
              : { kind: "harness", id: "openclaw" },
        }),
      };
      await replaceSessionEntry(scope, entry);
      const params = request(entry);
      params.storePath = resolveSessionStorePathCore(undefined, { agentId: scope.agentId });
      params.request.runtime = runtime;
      if (runtime.kind === "unchanged") {
        delete params.sessionEntry.executionSelection;
      }
      const result = await applySessionModelSelection(params);
      expect(result).toMatchObject({
        status: "applied",
        agentRuntime: "openclaw",
        provider: "fixture",
        model: "requested",
        changed,
      });
      expect(result.status === "applied" && result.runtimeChange).toEqual(
        runtime.kind === "unchanged" ? undefined : runtime,
      );
      expect(loadSessionEntryReadOnly(scope)?.executionSelection).toMatchObject({
        state: "accepted",
        selection: {
          model: { provider: "fixture", id: "requested" },
          executor: { kind: "harness", id: "openclaw" },
        },
      });
    });
  },
);

test.each(["native-managed", { id: "opaque" }] as const)(
  "rejects ACP %j before backend or storage effects",
  async (model) => {
    await withOpenClawTestState({ label: "sdk-flat-acp" }, async () => {
      const entry: SessionEntry = {
        ...ordinary,
        executionSelection: {
          state: "accepted",
          selection: {
            executor: { kind: "acp", backend: "fixture-backend", agent: "fixture-agent" },
            model,
          },
          fallbackPermission: "explicit",
        },
        acp: {
          runtimeSessionName: "fixture-native",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 1,
        },
      };
      await replaceSessionEntry(scope, entry);
      const params = request(entry);
      const before = structuredClone(params.sessionEntry);
      const backend = vi.spyOn(acpManager, "getAcpSessionManagerCore");
      expect(await applySessionModelSelection(params)).toMatchObject({
        status: "rejected",
        reason: "invalid-runtime",
      });
      expect(backend).not.toHaveBeenCalled();
      expect(evaluatePublishedModelRuntimeChoice).not.toHaveBeenCalled();
      expect(params.sessionEntry).toEqual(before);
      expect(loadSessionEntryReadOnly(scope)).toMatchObject(entry);
    });
  },
);

test("rejects a released ACP-only view before backend work without a store path", async () => {
  await withOpenClawTestState({ label: "sdk-legacy-acp-view" }, async () => {
    const params = request();
    const legacyEntry: ApplySessionModelSelectionParams["sessionEntry"] = {
      sessionId: "legacy-acp",
      updatedAt: 1,
      acp: {
        backend: "fixture-backend",
        agent: "fixture-agent",
        runtimeSessionName: "fixture-native",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 1,
        runtimeOptions: { model: "opaque" },
      },
    };
    params.sessionEntry = legacyEntry;
    params.sessionStore[scope.sessionKey] = legacyEntry;
    const before = structuredClone(legacyEntry);
    const backend = vi.spyOn(acpManager, "getAcpSessionManagerCore");
    expect(await applySessionModelSelection(params)).toMatchObject({
      status: "rejected",
      reason: "invalid-runtime",
    });
    expect(backend).not.toHaveBeenCalled();
    expect(evaluatePublishedModelRuntimeChoice).not.toHaveBeenCalled();
    expect(legacyEntry).toEqual(before);
  });
});

test.each(["replaced", "deleted"] as const)(
  "rechecks released caller custody after its entry is %s during preparation",
  async (change) => {
    await withOpenClawTestState({ label: "sdk-flat-custody" }, async () => {
      await replaceSessionEntry(scope, ordinary);
      const params = request();
      params.storePath = resolveSessionStorePathCore(undefined, { agentId: scope.agentId });
      const persistedBefore = loadSessionEntryReadOnly(scope);
      vi.mocked(evaluatePublishedModelRuntimeChoice).mockImplementationOnce(async () => {
        const generation = getActivePluginRegistryVersion();
        if (change === "deleted") {
          delete params.sessionStore[scope.sessionKey];
        } else {
          params.sessionStore[scope.sessionKey] = projectPluginSessionEntry({
            ...ordinary,
            executionSelection: {
              state: "accepted",
              selection: {
                executor: { kind: "acp", backend: "fixture-backend", agent: "fixture-agent" },
                model: "native-managed",
              },
              fallbackPermission: "explicit",
            },
          });
        }
        return {
          kind: "ready",
          entry: { provider: "fixture", id: "requested", name: "Requested" },
          validate: () =>
            generation === getActivePluginRegistryVersion()
              ? undefined
              : "Prepared selection is no longer current.",
        };
      });
      const before = structuredClone(params.sessionEntry);
      expect(await applySessionModelSelection(params)).toMatchObject({
        status: "rejected",
        reason: "not-allowed",
        message: "The session changed. Retry the model selection.",
      });
      expect(params.sessionEntry).toEqual(before);
      expect(loadSessionEntryReadOnly(scope)).toEqual(persistedBefore);
      if (change === "deleted") {
        expect(Object.hasOwn(params.sessionStore, scope.sessionKey)).toBe(false);
      } else {
        expect(params.sessionStore[scope.sessionKey]?.executionSelection).toMatchObject({
          selection: { executor: { kind: "acp" } },
        });
      }
    });
  },
);

test.each(["unknown", "unavailable", "unsupported"] as const)(
  "keeps the stable rejection union for %s",
  async (kind) => {
    await withOpenClawTestState({ label: "sdk-flat-refusal" }, async () => {
      vi.mocked(evaluatePublishedModelRuntimeChoice).mockResolvedValue({
        kind,
        message: "The app cannot accept this selection.",
        validate: () => undefined,
      });
      const params = request();
      const before = structuredClone(params.sessionEntry);
      expect(await applySessionModelSelection(params)).toMatchObject({
        status: "rejected",
        reason: "invalid-runtime",
      });
      expect(params.sessionEntry).toEqual(before);
    });
  },
);

test("released runtime reader preserves legacy ownership and pin priority", async () => {
  const { resolvePersistedSessionRuntimeId } = await import("./model-session-runtime.js");
  expect(
    resolvePersistedSessionRuntimeId({
      agentHarnessId: "native-app",
      agentRuntimeOverride: "openclaw",
      modelSelectionLocked: true,
    }),
  ).toBe("native-app");
  expect(
    resolvePersistedSessionRuntimeId({
      agentHarnessId: "native-app",
      agentRuntimeOverride: "openclaw",
      modelSelectionLocked: true,
      pluginOwnerId: "model-owner",
    }),
  ).toBe("openclaw");
  expect(
    resolvePersistedSessionRuntimeId({
      agentHarnessId: "native-app",
      agentRuntimeOverride: "default",
    }),
  ).toBe("native-app");
  expect(
    resolvePersistedSessionRuntimeId({
      ...ordinary,
      agentHarnessId: "native-app",
      modelSelectionLocked: true,
    }),
  ).toBe("openclaw");
});
