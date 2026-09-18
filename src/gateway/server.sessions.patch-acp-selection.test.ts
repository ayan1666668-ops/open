import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, expect, test, vi } from "vitest";
import { AcpSessionManager } from "../acp/control-plane/manager.core.js";
import { disposeAcpSessionManagerInstance } from "../acp/control-plane/manager.lifecycle.js";
import { DEFAULT_DEPS, type AcpSessionManagerDeps } from "../acp/control-plane/manager.types.js";
import { ACP_SELECTION_REPAIR_MESSAGE } from "../acp/control-plane/manager.utils.js";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import { readAcpSessionMeta, upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { createTestAdmittedRunContext } from "../agents/admitted-run-context.test-support.js";
import { createSessionModelCatalogFixture } from "../agents/test-helpers/session-model-catalog.test-support.js";
import { applyMixedDirectives } from "../auto-reply/reply/directive-handling.mixed-inline.test-helpers.js";
import { loadSessionEntry, patchSessionEntryWithKey } from "../config/sessions/session-accessor.js";
import { resolveSessionExecutionControlFailure } from "../model-picker/apply-session-model-selection.js";
import {
  getSessionExecutionSelection,
  getCommittedSessionExecutionSelection,
} from "../model-picker/execution-selection.js";
import { applyModelOverrideToSessionEntry } from "../plugin-sdk/model-session-runtime.js";
import {
  projectPluginSessionEntry,
  projectPluginSessionEntryPatch,
} from "../plugin-sdk/session-store-runtime-internal.js";
import { resolveSessionWorkerPlacementContext } from "./session-worker-placement-context.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  acpRuntimeMocks,
  acpManagerMocks,
  directSessionReq,
  getGatewayConfigModule,
  sessionHookMocks,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const acpKey = "agent:main:acp:selection-proof";
const ordinaryKey = "agent:main:ordinary-proof";
const missingKey = "agent:main:missing-proof";
const managers: AcpSessionManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await disposeAcpSessionManagerInstance(manager, "test-complete");
  }
  vi.restoreAllMocks();
});

async function setupSelection(
  model: string | null = "qa-before",
  modelSelectionLocked = false,
  upsertSessionMeta: AcpSessionManagerDeps["upsertSessionMeta"] = upsertAcpSessionMeta,
) {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      [acpKey]: sessionStoreEntry("acp-selection-session", {
        lifecycleRevision: "acp-selection-generation",
        label: "Original ACP title",
        ...(modelSelectionLocked ? { modelSelectionLocked: true } : {}),
      }),
      [ordinaryKey]: sessionStoreEntry("ordinary-session", { label: "Original ordinary title" }),
    },
  });
  const cfg = (await getGatewayConfigModule()).getRuntimeConfig();
  await upsertAcpSessionMeta({
    cfg,
    sessionKey: acpKey,
    agentId: "main",
    executionSelection: {
      executor: { kind: "acp", backend: "qa-acp", agent: "qa-agent" },
      model: model ? { id: model } : "native-managed",
    },
    mutate: () => ({
      runtimeSessionName: "qa-native-session",
      mode: "persistent",
      state: "idle",
      lastActivityAt: 1,
    }),
  });
  const setConfigOption = vi.fn<NonNullable<AcpRuntime["setConfigOption"]>>(async ({ value }) => ({
    configOptions: [
      {
        id: "model",
        category: "model",
        currentValue: ["qa-next", "qa-staged", "qa-newer"].includes(value) ? "qa-accepted" : value,
      },
    ],
  }));
  const runTurn = vi.fn<AcpRuntime["runTurn"]>(async function* () {
    yield { type: "done" };
  });
  const ensureSession = vi.fn<AcpRuntime["ensureSession"]>(async (input) => ({
    sessionKey: input.sessionKey,
    agentId: input.agentId,
    backend: "qa-acp",
    runtimeSessionName: "qa-native-session",
  }));
  const getCapabilities = vi.fn<NonNullable<AcpRuntime["getCapabilities"]>>(async () => ({
    controls: ["session/set_config_option"],
    configOptionKeys: ["model"],
  }));
  const runtime: AcpRuntime = {
    ownerAwareSessions: 1,
    ensureSession,
    runTurn,
    setConfigOption,
    getCapabilities,
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const backend = { id: "qa-acp", runtime };
  const getRuntimeBackend = (id?: string) => (!id || id === backend.id ? backend : null);
  acpRuntimeMocks.getAcpRuntimeBackend.mockImplementation(getRuntimeBackend);
  const managerDeps: AcpSessionManagerDeps = {
    ...DEFAULT_DEPS,
    upsertSessionMeta,
    getRuntimeBackend,
    requireRuntimeBackend: (id) => {
      const selected = getRuntimeBackend(id);
      if (!selected) {
        throw new AcpRuntimeError("ACP_BACKEND_MISSING", "Unknown fixture backend.");
      }
      return selected;
    },
  };
  const manager = new AcpSessionManager(managerDeps);
  managers.push(manager);
  acpManagerMocks.getManager.mockReturnValue(manager);
  sessionHookMocks.triggerInternalHook.mockClear();
  return {
    cfg,
    storePath,
    manager,
    managerDeps,
    setConfigOption,
    runTurn,
    ensureSession,
    getCapabilities,
    readEntry: (sessionKey = acpKey) =>
      loadSessionEntry({ agentId: "main", sessionKey, storePath }),
    readMeta: () => readAcpSessionMeta({ cfg, agentId: "main", sessionKey: acpKey }),
  };
}

async function applyAcpDirective(state: Awaited<ReturnType<typeof setupSelection>>, body: string) {
  const sessionEntry = state.readEntry();
  if (!sessionEntry) {
    throw new Error("missing ACP fixture entry");
  }
  return applyMixedDirectives({
    body,
    cfg: state.cfg,
    sessionKey: acpKey,
    storePath: state.storePath,
    sessionEntry,
    channel: "webchat",
    provider: "qa-provider",
    model: "qa-before",
    allowedModels: [],
    senderIsOwner: true,
    gatewayClientScopes: ["operator.admin"],
  });
}

test("sessions.patch commits an ACP accepted model and accompanying metadata together", async () => {
  const state = await setupSelection();
  const result = await directSessionReq("sessions.patch", {
    key: acpKey,
    model: "qa-next",
    label: "Changed title",
    pinned: true,
  });
  expect(result).toMatchObject({ ok: true });
  expect(state.readEntry()).toMatchObject({
    label: "Changed title",
    pinnedAt: expect.any(Number),
  });
  expect(getSessionExecutionSelection(state.readEntry())?.model).toEqual({ id: "qa-accepted" });
});

test.each(["/model qa-next", "/model qa-next /verbose on"])(
  "registered directive and acknowledgment delegate an opaque ACP model: %s",
  async (body) => {
    const state = await setupSelection();
    state.setConfigOption.mockImplementationOnce(async () => {
      expect(state.readEntry()?.verboseLevel).toBeUndefined();
      expect(getCommittedSessionExecutionSelection(state.readEntry())?.model).toEqual({
        id: "qa-before",
      });
      return { configOptions: [{ id: "model", category: "model", currentValue: "qa-accepted" }] };
    });
    const { result } = await applyAcpDirective(state, body);
    expect(result).toMatchObject({
      kind: "reply",
      reply: {
        text: expect.stringContaining(
          "Model changed to the selected model. Still using the selected app.",
        ),
      },
    });
    expect(getCommittedSessionExecutionSelection(state.readEntry())?.model).toEqual({
      id: "qa-accepted",
    });
    expect(state.readEntry()?.verboseLevel).toBe(body.includes("/verbose") ? "on" : undefined);
    await runPreparedTurn(state, "after-registered-model-directive");
    expect(state.runTurn).toHaveBeenCalledOnce();
  },
);

test("a refused combined ACP model directive leaves its accompanying settings unchanged", async () => {
  const state = await setupSelection();
  state.setConfigOption.mockRejectedValueOnce(new Error("app refused the requested model"));
  const { result } = await applyAcpDirective(state, "/model qa-next /verbose on");
  expect(result).toMatchObject({
    kind: "reply",
    reply: { text: expect.stringContaining("The model change could not be confirmed.") },
  });
  expect(getCommittedSessionExecutionSelection(state.readEntry())?.model).toEqual({
    id: "qa-before",
  });
  expect(state.readEntry()?.verboseLevel).toBeUndefined();
});

test.each([
  { body: "/model qa-next", submitted: false },
  { body: "/model qa-next", submitted: true },
  { body: "/model qa-next /verbose on", submitted: false },
  { body: "/model qa-next /verbose on", submitted: true },
])(
  "registered ACP refusal reports actual pause state: $body, submitted=$submitted",
  async ({ body, submitted }) => {
    const state = await setupSelection();
    const before = getCommittedSessionExecutionSelection(state.readEntry());
    if (submitted) {
      state.setConfigOption.mockRejectedValueOnce(
        new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", "native model control rejected"),
      );
    } else {
      state.getCapabilities.mockResolvedValue({
        controls: ["session/set_config_option"],
        configOptionKeys: ["reasoning_effort"],
      });
    }
    const { result } = await applyAcpDirective(state, body);
    if (result.kind !== "reply" || !result.reply || Array.isArray(result.reply)) {
      throw new Error("expected directive refusal reply");
    }
    expect(result.reply.text).toContain("This app cannot change that model setting here.");
    expect(
      result.reply.text?.includes("Chat is paused while the app confirms the saved selection."),
    ).toBe(submitted);
    expect(state.setConfigOption).toHaveBeenCalledTimes(submitted ? 1 : 0);
    expect(state.readMeta()?.lastError).toBe(submitted ? ACP_SELECTION_REPAIR_MESSAGE : undefined);
    expect(getCommittedSessionExecutionSelection(state.readEntry())).toEqual(before);
    expect(state.readEntry()?.verboseLevel).toBeUndefined();
    expect(result).not.toHaveProperty("confirmationNotice");
  },
);

test.each(["other-generation", "unreadable"] as const)(
  "control failure does not borrow a pause marker from %s session state",
  async (stateKind) => {
    const state = await setupSelection();
    await upsertAcpSessionMeta({
      cfg: state.cfg,
      agentId: "main",
      sessionKey: acpKey,
      mutate: (meta) => {
        if (!meta) {
          throw new Error("missing ACP fixture lifecycle");
        }
        return { ...meta, state: "error", lastError: ACP_SELECTION_REPAIR_MESSAGE };
      },
    });
    if (stateKind === "unreadable") {
      vi.spyOn(state.manager, "resolveSession").mockImplementation(() => {
        throw new Error("session storage unavailable");
      });
    }
    const result = await resolveSessionExecutionControlFailure(
      new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", "native model control rejected"),
      {
        cfg: state.cfg,
        agentId: "main",
        sessionKey: acpKey,
        sessionId: "acp-selection-session",
        lifecycleRevision:
          stateKind === "other-generation" ? "previous-generation" : "acp-selection-generation",
      },
    );
    expect(result?.confirmationNotice).toBe(
      "The app could not confirm the saved selection. Check the session before continuing.",
    );
    expect(result?.message).not.toContain("Chat is paused");
  },
);

test.each([false, true])(
  "sessions.patch reports actual pause state after unsupported control, submitted=%s",
  async (submitted) => {
    const state = await setupSelection();
    if (submitted) {
      state.setConfigOption.mockRejectedValueOnce(
        new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", "native rejection"),
      );
    } else {
      state.getCapabilities.mockResolvedValue({
        controls: ["session/set_config_option"],
        configOptionKeys: ["reasoning_effort"],
      });
    }
    const result = await directSessionReq("sessions.patch", {
      key: acpKey,
      model: "qa-next",
      pinned: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("This app cannot change that model setting here.");
    expect(result.error?.message?.includes("Chat is paused")).toBe(submitted);
    expect(state.setConfigOption).toHaveBeenCalledTimes(submitted ? 1 : 0);
    expect(state.readEntry()?.pinnedAt).toBeUndefined();
    expect(getCommittedSessionExecutionSelection(state.readEntry())?.model).toEqual({
      id: "qa-before",
    });
  },
);

test.each(["/model qa-next", "/model qa-next /verbose on", "sessions.patch"])(
  "reports the saved ACP selection when confirmation storage fails: %s",
  async (operation) => {
    const state: Awaited<ReturnType<typeof setupSelection>> = await setupSelection(
      "qa-before",
      false,
      async (input) => {
        const accepted = getCommittedSessionExecutionSelection(state.readEntry());
        if (accepted?.model !== "native-managed" && accepted?.model.id === "qa-accepted") {
          throw new Error("confirmation storage unavailable");
        }
        return upsertAcpSessionMeta(input);
      },
    );
    let message: string | undefined;
    if (operation === "sessions.patch") {
      const result = await directSessionReq("sessions.patch", { key: acpKey, model: "qa-next" });
      expect(result.ok).toBe(false);
      message = result.error?.message;
      expect(message).toContain("Session settings were saved.");
    } else {
      const { result } = await applyAcpDirective(state, operation);
      if (result.kind !== "reply" || !result.reply || Array.isArray(result.reply)) {
        throw new Error("expected saved directive acknowledgment");
      }
      message = result.reply.text;
      expect(message).toContain("Model changed to the selected model.");
    }
    expect(message).toContain("Chat is paused while the app confirms the saved selection.");
    expect(message).not.toContain("confirmation storage unavailable");
    expect(getCommittedSessionExecutionSelection(state.readEntry())?.model).toEqual({
      id: "qa-accepted",
    });
    expect(state.readMeta()?.lastError).toBe(ACP_SELECTION_REPAIR_MESSAGE);
  },
);

test("a later ACP actor confirmation failure preserves every committed batch outcome", async () => {
  const state: Awaited<ReturnType<typeof setupSelection>> = await setupSelection(
    "qa-before",
    false,
    async (input) => {
      if (
        input.sessionKey === ordinaryKey &&
        state.readEntry(ordinaryKey)?.pinnedAt !== undefined
      ) {
        throw new Error("inner confirmation storage unavailable");
      }
      return upsertAcpSessionMeta(input);
    },
  );
  await upsertAcpSessionMeta({
    cfg: state.cfg,
    sessionKey: ordinaryKey,
    agentId: "main",
    executionSelection: {
      executor: { kind: "acp", backend: "qa-acp", agent: "qa-agent" },
      model: { id: "qa-before" },
    },
    mutate: () => ({
      runtimeSessionName: "qa-inner-session",
      mode: "persistent",
      state: "idle",
      lastActivityAt: 1,
    }),
  });
  state.ensureSession.mockImplementation(async (input) => ({
    sessionKey: input.sessionKey,
    agentId: input.agentId,
    backend: "qa-acp",
    runtimeSessionName: input.sessionKey === ordinaryKey ? "qa-inner-session" : "qa-native-session",
  }));
  const result = await directSessionReq<{
    outcomes: Array<{ key: string; ok: boolean; error?: { message?: string } }>;
  }>("sessions.patchMany", {
    targets: [{ key: acpKey }, { key: ordinaryKey }],
    patch: { model: "qa-next", pinned: true },
  });
  expect(result.ok).toBe(true);
  expect(result.payload?.outcomes[0]).toMatchObject({ key: acpKey, ok: true });
  expect(result.payload?.outcomes[1]).toMatchObject({
    key: ordinaryKey,
    ok: false,
    error: { message: expect.stringContaining("Session settings were saved.") },
  });
  for (const key of [acpKey, ordinaryKey]) {
    expect(state.readEntry(key)?.pinnedAt).toEqual(expect.any(Number));
    expect(getCommittedSessionExecutionSelection(state.readEntry(key))?.model).toEqual({
      id: "qa-accepted",
    });
  }
  expect(sessionHookMocks.triggerInternalHook).toHaveBeenCalledWith(
    expect.objectContaining({ sessionKey: ordinaryKey }),
  );
});

test("a later batch catalog read does not replay a settled failed ACP model control", async () => {
  const state = await setupSelection();
  state.cfg.models = {
    providers: {
      fixture: {
        api: "openai-completions",
        baseUrl: "https://fixture.example.invalid/v1",
        models: [],
      },
    },
  };
  state.cfg.agents = {
    ...state.cfg.agents,
    defaults: { ...state.cfg.agents?.defaults, model: "fixture/next" },
  };
  const catalog = createSessionModelCatalogFixture();
  const placements = resolveSessionWorkerPlacementContext().workerSessionPlacementService;
  if (!placements) {
    throw new Error("missing placement owner");
  }
  const readPlacements = placements.getMany.bind(placements);
  let failPlacementRead = false;
  vi.spyOn(placements, "getMany").mockImplementation((keys) => {
    if (failPlacementRead) {
      failPlacementRead = false;
      throw new Error("placement storage temporarily unavailable");
    }
    return readPlacements(keys);
  });
  state.setConfigOption.mockImplementationOnce(async () => {
    failPlacementRead = true;
    return { configOptions: [{ id: "model", category: "model", currentValue: "qa-accepted" }] };
  });
  const loadGatewayModelCatalogSnapshot = vi.fn(async () => {
    expect(state.setConfigOption.mock.calls.map(([input]) => input.value)).toEqual([
      "fixture/next",
      "qa-before",
    ]);
    expect(state.readMeta()?.lastError).toBeUndefined();
    const entry = {
      provider: "fixture",
      id: "next",
      name: "Next model",
      api: "openai-completions" as const,
      baseUrl: "https://fixture.example.invalid/v1",
    };
    return catalog.publish({
      config: state.cfg,
      agentId: "main",
      catalog: { entries: [entry], routeVariants: [entry] },
      profiles: {
        "fixture:default": { type: "api_key", provider: "fixture", key: "synthetic-credential" },
      },
    });
  });
  const result = await directSessionReq<{ outcomes: Array<{ key: string; ok: boolean }> }>(
    "sessions.patchMany",
    {
      targets: [{ key: acpKey }, { key: ordinaryKey }],
      patch: { model: "fixture/next", pinned: true },
    },
    { context: { loadGatewayModelCatalogSnapshot } },
  );
  expect(result.ok).toBe(true);
  expect(result.payload?.outcomes).toEqual([
    expect.objectContaining({ key: acpKey, ok: false }),
    expect.objectContaining({ key: ordinaryKey, ok: true }),
  ]);
  expect(state.setConfigOption.mock.calls.map(([input]) => input.value)).toEqual([
    "fixture/next",
    "qa-before",
  ]);
  expect(getSessionExecutionSelection(state.readEntry())?.model).toEqual({ id: "qa-before" });
  expect(state.readEntry()?.pinnedAt).toBeUndefined();
  expect(state.readMeta()?.lastError).toBeUndefined();
  expect(getSessionExecutionSelection(state.readEntry(ordinaryKey))?.model).toEqual({
    provider: "fixture",
    id: "next",
  });
  expect(state.readEntry(ordinaryKey)?.pinnedAt).toEqual(expect.any(Number));
});

test("sessions.patch validates all accompanying metadata before an ACP model control", async () => {
  const state = await setupSelection();
  const before = { entry: state.readEntry(), meta: state.readMeta() };
  const result = await directSessionReq("sessions.patch", {
    key: acpKey,
    model: "qa-next",
    permissionMode: "invalid",
  });
  expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect({ entry: state.readEntry(), meta: state.readMeta() }).toEqual(before);
  expect(state.ensureSession).not.toHaveBeenCalled();
  expect(state.setConfigOption).not.toHaveBeenCalled();
  expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
});

test("sessions.patch rechecks conditional metadata after ACP preparation and before model control", async () => {
  const state = await setupSelection();
  const before = getCommittedSessionExecutionSelection(state.readEntry());
  state.ensureSession.mockImplementationOnce(async (input) => {
    await patchSessionEntryWithKey(
      { agentId: "main", sessionKey: acpKey, storePath: state.storePath },
      () => ({ permissionMode: "read-only" }),
    );
    return {
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      backend: "qa-acp",
      runtimeSessionName: "qa-native-session",
    };
  });
  const result = await directSessionReq("sessions.patch", {
    key: acpKey,
    model: "qa-next",
    label: "Uncommitted title",
    permissionMode: "full",
    expectedPermissionMode: null,
  });
  expect(result).toMatchObject({ ok: false });
  expect(state.setConfigOption).not.toHaveBeenCalled();
  expect(getCommittedSessionExecutionSelection(state.readEntry())).toEqual(before);
  expect(state.readEntry()).toMatchObject({
    label: "Original ACP title",
    permissionMode: "read-only",
  });
  expect(state.readMeta()?.lastError).toBeUndefined();
});

test.each([
  { keys: [acpKey, ordinaryKey] },
  { keys: [ordinaryKey, acpKey] },
  { keys: [missingKey, acpKey] },
])(
  "sessions.patchMany preserves per-target outcomes when an ACP model is accepted: %j",
  async ({ keys }) => {
    const state = await setupSelection();
    const result = await directSessionReq<{ outcomes: Array<{ key: string; ok: boolean }> }>(
      "sessions.patchMany",
      { targets: keys.map((key) => ({ key })), patch: { model: "qa-next" } },
    );
    expect(result.ok).toBe(true);
    expect(result.payload?.outcomes).toEqual(
      keys.map((key) => expect.objectContaining({ key, ok: key === acpKey })),
    );
    expect(getSessionExecutionSelection(state.readEntry())?.model).toEqual({ id: "qa-accepted" });
    expect(state.readEntry(ordinaryKey)?.label).toBe("Original ordinary title");
    expect(state.readEntry(missingKey)).toBeUndefined();
  },
);

test("sessions.patch applies and returns the backend's accepted model before the next turn", async () => {
  const state = await setupSelection();
  const result = await directSessionReq<{ resolved?: { model?: string; modelProvider?: string } }>(
    "sessions.patch",
    {
      key: acpKey,
      model: "qa-next",
      expectedSessionId: "acp-selection-session",
      expectedLifecycleRevision: "acp-selection-generation",
    },
  );
  expect(result).toMatchObject({ ok: true });
  expect(result.payload?.resolved?.model).toBe("qa-accepted");
  expect(result.payload?.resolved?.modelProvider).toBeUndefined();
  expect(getSessionExecutionSelection(state.readEntry())?.model).toEqual({ id: "qa-accepted" });
  expect(state.setConfigOption).toHaveBeenCalledWith(
    expect.objectContaining({ key: "model", value: "qa-next" }),
  );
  const reopened = new AcpSessionManager(state.managerDeps);
  managers.push(reopened);
  await reopened.runTurn({
    cfg: state.cfg,
    sessionKey: acpKey,
    agentId: "main",
    admittedRunContext: createTestAdmittedRunContext("acp-patch-next-turn"),
    provenance: "human",
    text: "continue",
    mode: "prompt",
    requestId: "acp-patch-next-turn",
  });
  expect(state.ensureSession.mock.lastCall?.[0].model).toBe("qa-accepted");
  expect(state.runTurn).toHaveBeenCalledOnce();
  const listed = await directSessionReq<{
    sessions: Array<{ key: string; model?: string; modelProvider?: string }>;
  }>("sessions.list", { agentId: "main", limit: 100 });
  expect(listed.ok).toBe(true);
  const row = listed.payload?.sessions.find((entry) => entry.key === acpKey);
  expect(row?.model).toBe("qa-accepted");
  expect(row?.modelProvider).toBeUndefined();
});

test.each([{ model: null }, { agentRuntime: null }])(
  "sessions.patch accepts an ACP default reset: %j",
  async (patch) => {
    const state = await setupSelection(null);
    const result = await directSessionReq("sessions.patch", { key: acpKey, ...patch });
    expect(result).toMatchObject({ ok: true });
    expect(getSessionExecutionSelection(state.readEntry())?.model).toBe("native-managed");
    expect(state.setConfigOption).not.toHaveBeenCalled();
  },
);

test("sessions.patch keeps a concrete ACP model when clearing its runtime preference", async () => {
  const state = await setupSelection();
  const result = await directSessionReq("sessions.patch", {
    key: acpKey,
    model: "qa-next",
    agentRuntime: null,
  });
  expect(result).toMatchObject({ ok: true });
  expect(state.setConfigOption).toHaveBeenCalledWith(
    expect.objectContaining({ key: "model", value: "qa-next" }),
  );
  expect(getSessionExecutionSelection(state.readEntry())?.model).toEqual({ id: "qa-accepted" });
});

test("sessions.patch preserves ACP runtime ownership", async () => {
  const state = await setupSelection();
  const before = state.readMeta();
  const result = await directSessionReq("sessions.patch", {
    key: acpKey,
    model: "qa-next",
    agentRuntime: "openclaw",
  });
  expect(result).toMatchObject({
    ok: false,
    error: { message: "Runtime selection is owned by this ACP session." },
  });
  expect(state.readMeta()).toEqual(before);
  expect(state.setConfigOption).not.toHaveBeenCalled();
});

test("sessions.patch refuses a locked ACP model before runtime changes", async () => {
  const state = await setupSelection("qa-before", true);
  const before = { entry: state.readEntry(), meta: state.readMeta() };
  const result = await directSessionReq("sessions.patch", { key: acpKey, model: "qa-next" });
  expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect({ entry: state.readEntry(), meta: state.readMeta() }).toEqual(before);
  expect(state.ensureSession).not.toHaveBeenCalled();
  expect(state.setConfigOption).not.toHaveBeenCalled();
});

test("sessions.patch rejects stale ACP targeting controls before runtime changes", async () => {
  const state = await setupSelection();
  const before = { entry: state.readEntry(), meta: state.readMeta() };
  const result = await directSessionReq("sessions.patch", {
    key: acpKey,
    model: "qa-next",
    expectedSessionId: "replaced-session",
  });
  expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect({ entry: state.readEntry(), meta: state.readMeta() }).toEqual(before);
  expect(state.ensureSession).not.toHaveBeenCalled();
  expect(state.setConfigOption).not.toHaveBeenCalled();
});

async function stageLegacyModel(
  state: Awaited<ReturnType<typeof setupSelection>>,
  model: string,
  defaults?: { explicit: boolean },
) {
  await patchSessionEntryWithKey(
    { agentId: "main", sessionKey: acpKey, storePath: state.storePath },
    (entry) => {
      const next = projectPluginSessionEntry(entry);
      applyModelOverrideToSessionEntry({
        entry: next,
        selection: { provider: "qa-provider", model, ...(defaults ? { isDefault: true } : {}) },
        ...(defaults ? { explicitDefaultSelection: defaults.explicit } : {}),
      });
      return { ...entry, ...projectPluginSessionEntryPatch(next, entry) };
    },
    { replaceEntry: true },
  );
}

function runPreparedTurn(state: Awaited<ReturnType<typeof setupSelection>>, requestId: string) {
  return state.manager.runTurn({
    cfg: state.cfg,
    agentId: "main",
    sessionKey: acpKey,
    admittedRunContext: createTestAdmittedRunContext(requestId),
    provenance: "human",
    text: "continue",
    mode: "prompt",
    requestId,
  });
}

test("an implicit legacy default preserves the accepted ACP model on the next turn", async () => {
  const state = await setupSelection();
  const before = state.readEntry()?.executionSelection;
  await stageLegacyModel(state, "qa-configured", { explicit: false });
  expect(state.readEntry()?.executionSelection).toEqual(before);
  await runPreparedTurn(state, "implicit-legacy-default");
  expect(getSessionExecutionSelection(state.readEntry())?.model).toEqual({ id: "qa-before" });
  expect(state.ensureSession.mock.lastCall?.[0].model).toBe("qa-before");
  expect(state.runTurn).toHaveBeenCalledOnce();
});

test("an unsupported staged ACP default remains pending without claiming acceptance", async () => {
  const state = await setupSelection();
  const before = getCommittedSessionExecutionSelection(state.readEntry());
  await stageLegacyModel(state, "qa-configured", { explicit: true });
  expect(state.readEntry()?.executionSelection?.state).toBe("deferred");
  await expect(runPreparedTurn(state, "explicit-legacy-default")).rejects.toThrow(
    "cannot restore its default model",
  );
  expect(state.readEntry()?.executionSelection?.state).toBe("deferred");
  expect(getCommittedSessionExecutionSelection(state.readEntry())).toEqual(before);
  expect(state.setConfigOption).not.toHaveBeenCalled();
  expect(state.runTurn).not.toHaveBeenCalled();
});

test("an unsupported direct ACP reset leaves its accepted pair without staging a request", async () => {
  const state = await setupSelection();
  const before = state.readEntry()?.executionSelection;
  const result = await directSessionReq("sessions.patch", { key: acpKey, agentRuntime: null });
  expect(result).toMatchObject({ ok: false });
  expect(state.readEntry()?.executionSelection).toEqual(before);
  expect(state.readEntry()?.executionSelection?.state).toBe("accepted");
  expect(state.setConfigOption).not.toHaveBeenCalled();
});

test("a legacy SDK model request is accepted by the current ACP app on the next prepared turn", async () => {
  const state = await setupSelection();
  await stageLegacyModel(state, "qa-staged");
  expect(getCommittedSessionExecutionSelection(state.readEntry())?.model).toEqual({
    id: "qa-before",
  });
  await runPreparedTurn(state, "legacy-acp-selection");
  expect(getSessionExecutionSelection(state.readEntry())).toEqual({
    executor: { kind: "acp", backend: "qa-acp", agent: "qa-agent" },
    model: { id: "qa-accepted" },
  });
  expect(state.readEntry()?.executionSelection?.state).toBe("accepted");
  await runPreparedTurn(state, "legacy-acp-selection-next");
  expect(
    state.setConfigOption.mock.calls.filter(([input]) => input.value === "qa-staged"),
  ).toHaveLength(1);
  expect(state.runTurn).toHaveBeenCalledTimes(2);
});

test("accepting a staged ACP model does not erase a newer SDK request", async () => {
  const state = await setupSelection();
  await stageLegacyModel(state, "qa-staged");
  state.setConfigOption.mockImplementationOnce(async () => {
    await stageLegacyModel(state, "qa-newer");
    return { configOptions: [{ id: "model", category: "model", currentValue: "qa-accepted" }] };
  });
  await expect(runPreparedTurn(state, "legacy-acp-race")).rejects.toThrow(
    "session changed while its model selection was being applied",
  );
  expect(state.readEntry()?.executionSelection).toMatchObject({
    state: "deferred",
    request: { model: { id: "qa-newer" } },
  });
  expect(state.runTurn).not.toHaveBeenCalled();
  await runPreparedTurn(state, "legacy-acp-race-next");
  expect(state.setConfigOption.mock.calls.some(([input]) => input.value === "qa-newer")).toBe(true);
  expect(state.readEntry()?.executionSelection?.state).toBe("accepted");
  expect(state.runTurn).toHaveBeenCalledOnce();
});
