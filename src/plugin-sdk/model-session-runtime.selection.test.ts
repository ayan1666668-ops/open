import { afterEach, beforeEach, expect, expectTypeOf, test, vi } from "vitest";
import * as acpManager from "../acp/control-plane/manager.js";
import { evaluatePublishedModelRuntimeChoice } from "../agents/model-runtime-choice.js";
import type { ModelVisibilityPolicy } from "../agents/model-selection.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  applySessionModelSelection,
  type ApplySessionModelSelectionParams,
} from "./model-session-runtime.js";
import { projectPluginSessionEntry } from "./session-store-runtime-internal.js";

vi.mock("../agents/model-runtime-choice.js", () => ({
  evaluatePublishedModelRuntimeChoice: vi.fn(),
}));
const scope = { agentId: "main", sessionKey: "agent:main:sdk" };
const ordinary: SessionEntry = {
  sessionId: "sdk-session",
  updatedAt: 1,
  executionSelection: {
    state: "accepted",
    selection: {
      model: { provider: "fixture", id: "before" },
      executor: { kind: "harness", id: "openclaw" },
    },
    fallbackPermission: "configured",
  },
};
function request(entry = ordinary): ApplySessionModelSelectionParams {
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
    .mockResolvedValue({
      kind: "ready",
      entry: { provider: "fixture", id: "requested", name: "Requested", contextTokens: 4096 },
      validate: () => undefined,
    });
});
afterEach(() => vi.restoreAllMocks());

test("the released operation returns all flat fields and a matching public entry", async () => {
  await withOpenClawTestState({ label: "sdk-flat-selection" }, async () => {
    const params = request();
    const result = await applySessionModelSelection(params);
    expect(result).toMatchObject({
      status: "applied",
      provider: "fixture",
      model: "requested",
      effectiveModelRef: "fixture/requested",
      agentRuntime: "openclaw",
      contextTokens: 4096,
      message: "Model changed to Requested. Still using OpenClaw.",
    });
    expect(params.sessionEntry).toMatchObject({
      providerOverride: "fixture",
      modelOverride: "requested",
      agentRuntimeOverride: "openclaw",
    });
    if (result.status !== "applied") throw new Error("Expected accepted ordinary selection");
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
      const backend = vi.spyOn(acpManager, "getAcpSessionManager");
      expect(await applySessionModelSelection(params)).toMatchObject({
        status: "rejected",
        reason: "invalid-runtime",
        message: expect.stringContaining("Use applySessionExecutionSelection"),
      });
      expect(backend).not.toHaveBeenCalled();
      expect(evaluatePublishedModelRuntimeChoice).not.toHaveBeenCalled();
      expect(params.sessionEntry).toEqual(before);
      expect(loadSessionEntryReadOnly(scope)).toMatchObject(entry);
    });
  },
);

test("rechecks released caller custody after preparation", async () => {
  await withOpenClawTestState({ label: "sdk-flat-custody" }, async () => {
    const params = request();
    vi.mocked(evaluatePublishedModelRuntimeChoice).mockImplementationOnce(async () => {
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
      return {
        kind: "ready",
        entry: { provider: "fixture", id: "requested", name: "Requested" },
        validate: () => undefined,
      };
    });
    const before = structuredClone(params.sessionEntry);
    expect(await applySessionModelSelection(params)).toMatchObject({
      status: "rejected",
      reason: "not-allowed",
      message: expect.stringContaining("Use applySessionExecutionSelection"),
    });
    expect(params.sessionEntry).toEqual(before);
    expect(params.sessionStore[scope.sessionKey]?.executionSelection).toMatchObject({
      selection: { executor: { kind: "acp" } },
    });
  });
});

test.each(["unknown", "unavailable", "unsupported"] as const)(
  "keeps the stable rejection union for %s",
  async (kind) => {
    await withOpenClawTestState({ label: "sdk-flat-refusal" }, async () => {
      vi.mocked(evaluatePublishedModelRuntimeChoice).mockResolvedValue({
        kind,
        message: "The app cannot accept this selection.",
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
