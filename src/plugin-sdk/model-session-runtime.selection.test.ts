import { afterEach, beforeEach, expect, expectTypeOf, test, vi } from "vitest";
import * as acpManager from "../acp/control-plane/manager.js";
import * as acpStore from "../acp/runtime/session-meta.js";
import type { ModelVisibilityPolicy } from "../agents/model-selection.js";
import * as sessionStore from "../config/sessions/session-accessor.js";
import * as selectionOwner from "../model-picker/apply-session-model-selection.js";
import {
  applySessionModelSelection,
  type ApplySessionModelSelectionParams,
} from "./model-session-runtime.js";

function request(): ApplySessionModelSelectionParams {
  const entry = { sessionId: "sdk-session", updatedAt: 1 };
  return {
    cfg: {},
    agentId: "main",
    sessionKey: "agent:main:sdk",
    sessionEntry: entry,
    sessionStore: { "agent:main:sdk": entry },
    defaultProvider: "fixture",
    defaultModel: "default",
    currentProvider: "fixture",
    currentModel: "before",
    modelCatalog: [],
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
  vi.spyOn(acpStore, "readAcpSessionMetaForEntry").mockReturnValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

test("projects all published flat fields from the one accepted ordinary pair", async () => {
  const owner = vi.spyOn(selectionOwner, "applySessionModelSelection").mockResolvedValue({
    status: "applied",
    selection: {
      model: { provider: "fixture", id: "accepted" },
      executor: { kind: "harness", id: "openclaw" },
    },
    message: "Model changed to QA. Still using OpenClaw.",
    changed: true,
    contextTokens: 4096,
  });
  const params = request();
  const result = await applySessionModelSelection(params);
  expect(owner).toHaveBeenCalledOnce();
  expect(owner.mock.calls[0]?.[0].request).toEqual(params.request);
  expect(result).toMatchObject({
    status: "applied",
    provider: "fixture",
    model: "accepted",
    effectiveModelRef: "fixture/accepted",
    agentRuntime: "openclaw",
    contextTokens: 4096,
    selection: {
      model: { provider: "fixture", id: "accepted" },
      executor: { kind: "harness", id: "openclaw" },
    },
  });
  if (result.status !== "applied") throw new Error("expected accepted ordinary selection");
  expectTypeOf(result.provider).toEqualTypeOf<string>();
  expectTypeOf(result.model).toEqualTypeOf<string>();
  expectTypeOf(result.effectiveModelRef).toEqualTypeOf<string>();
  expectTypeOf(result.agentRuntime).toEqualTypeOf<string>();
  expectTypeOf(result.contextTokens).toEqualTypeOf<number>();
  expectTypeOf<ApplySessionModelSelectionParams["modelPolicy"]>().toEqualTypeOf<
    ModelVisibilityPolicy | undefined
  >();
});

test.each([undefined, "qa-opaque-model"])(
  "rejects ACP %s before owner, backend, or store mutation",
  async (model) => {
    vi.mocked(acpStore.readAcpSessionMetaForEntry).mockReturnValue({
      backend: "qa-backend",
      agent: "qa-agent",
      runtimeSessionName: "qa-native",
      mode: "persistent",
      state: "idle",
      lastActivityAt: 1,
      ...(model ? { runtimeOptions: { model } } : {}),
    });
    const owner = vi.spyOn(selectionOwner, "applySessionModelSelection");
    const backend = vi.spyOn(acpManager, "getAcpSessionManager");
    const acpWrite = vi.spyOn(acpStore, "upsertAcpSessionMeta");
    const ordinaryWrite = vi.spyOn(sessionStore, "patchSessionEntryCore");
    const params = request();
    const before = structuredClone(params.sessionEntry);
    await expect(applySessionModelSelection(params)).resolves.toMatchObject({
      status: "rejected",
      reason: "invalid-runtime",
      message: expect.stringContaining("dedicated session model request"),
    });
    expect(owner).not.toHaveBeenCalled();
    expect(backend).not.toHaveBeenCalled();
    expect(acpWrite).not.toHaveBeenCalled();
    expect(ordinaryWrite).not.toHaveBeenCalled();
    expect(params.sessionEntry).toEqual(before);
  },
);

test("rechecks ACP binding before a delegate can mutate after awaited preparation", async () => {
  const owner = vi
    .spyOn(selectionOwner, "applySessionModelSelection")
    .mockImplementation(async (params) => {
      vi.mocked(acpStore.readAcpSessionMetaForEntry).mockReturnValue({
        backend: "qa-backend",
        agent: "qa-agent",
        runtimeSessionName: "qa-native",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 1,
      });
      const message = params.validateAuthProfileSelection?.();
      if (!message) throw new Error("ACP binding should invalidate ordinary selection");
      return { status: "rejected", reason: "invalid-runtime", message };
    });
  const validate = vi.fn(() => undefined);
  await expect(
    applySessionModelSelection({ ...request(), validateAuthProfileSelection: validate }),
  ).resolves.toMatchObject({ status: "rejected", reason: "invalid-runtime" });
  expect(owner).toHaveBeenCalledOnce();
  expect(validate).toHaveBeenCalled();
});

test.each(["unknown", "unavailable", "unsupported"] as const)(
  "keeps the stable rejection union for %s",
  async (reason) => {
    vi.spyOn(selectionOwner, "applySessionModelSelection").mockResolvedValue({
      status: "rejected",
      reason,
      message: "The app cannot accept this selection.",
    });
    await expect(applySessionModelSelection(request())).resolves.toEqual({
      status: "rejected",
      reason: "invalid-runtime",
      message: "The app cannot accept this selection.",
    });
  },
);
