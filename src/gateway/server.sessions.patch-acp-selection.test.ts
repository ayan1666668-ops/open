import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, expect, test, vi } from "vitest";
import { AcpSessionManager } from "../acp/control-plane/manager.core.js";
import * as acpManagerModule from "../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../acp/control-plane/manager.lifecycle.js";
import { readAcpSessionMeta, upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { createTestAdmittedRunContext } from "../agents/admitted-run-context.test-support.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { readAcpExecutionSelection } from "../model-picker/execution-selection-codec.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  acpRuntimeMocks,
  directSessionReq,
  getGatewayConfigModule,
  sessionHookMocks,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const acpKey = "agent:main:acp:selection-proof";
const ordinaryKey = "agent:main:ordinary-proof";
const managers: AcpSessionManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0))
    await disposeAcpSessionManagerInstance(manager, "test-complete");
  vi.restoreAllMocks();
});

async function setupSelection(model: string | null = "qa-before", modelSelectionLocked = false) {
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
    mutate: () => ({
      backend: "qa-acp",
      agent: "qa-agent",
      runtimeSessionName: "qa-native-session",
      mode: "persistent",
      state: "idle",
      lastActivityAt: 1,
      ...(model ? { runtimeOptions: { model } } : {}),
    }),
  });
  const setConfigOption = vi.fn<NonNullable<AcpRuntime["setConfigOption"]>>(async () => ({
    configOptions: [{ id: "model", category: "model", currentValue: "qa-accepted" }],
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
  const runtime: AcpRuntime = {
    ownerAwareSessions: 1,
    ensureSession,
    runTurn,
    setConfigOption,
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue({ id: "qa-acp", runtime });
  const manager = new AcpSessionManager();
  managers.push(manager);
  vi.spyOn(acpManagerModule, "getAcpSessionManager").mockReturnValue(manager);
  sessionHookMocks.triggerInternalHook.mockClear();
  return {
    cfg,
    storePath,
    manager,
    setConfigOption,
    runTurn,
    ensureSession,
    readEntry: (sessionKey = acpKey) =>
      loadSessionEntry({ agentId: "main", sessionKey, storePath }),
    readMeta: () => readAcpSessionMeta({ cfg, agentId: "main", sessionKey: acpKey }),
  };
}

test.each([
  { model: "qa-next", label: "Changed title" },
  { model: null, thinkingLevel: "high" },
  { agentRuntime: null, pinned: true },
])("sessions.patch refuses compound ACP selection before writes: %j", async (patch) => {
  const state = await setupSelection();
  const before = { entry: state.readEntry(), meta: state.readMeta() };
  const result = await directSessionReq("sessions.patch", { key: acpKey, ...patch });
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "Change the model in its own request for this session",
    },
  });
  expect({ entry: state.readEntry(), meta: state.readMeta() }).toEqual(before);
  expect(state.ensureSession).not.toHaveBeenCalled();
  expect(state.setConfigOption).not.toHaveBeenCalled();
  expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
});

test.each([
  [acpKey, ordinaryKey],
  [ordinaryKey, acpKey],
])("sessions.patchMany refuses mixed ACP selection before any target changes: %j", async (keys) => {
  const state = await setupSelection();
  const before = {
    acp: state.readEntry(),
    ordinary: state.readEntry(ordinaryKey),
    meta: state.readMeta(),
  };
  const result = await directSessionReq("sessions.patchMany", {
    targets: keys.map((key) => ({ key })),
    patch: { model: "qa-next" },
  });
  expect(result).toMatchObject({
    ok: false,
    error: { message: "Change the model in its own request for this session" },
  });
  expect({
    acp: state.readEntry(),
    ordinary: state.readEntry(ordinaryKey),
    meta: state.readMeta(),
  }).toEqual(before);
  expect(state.ensureSession).not.toHaveBeenCalled();
  expect(state.setConfigOption).not.toHaveBeenCalled();
  expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
});

test("sessions.patch applies and returns the backend's accepted model before the next turn", async () => {
  const state = await setupSelection();
  const result = await directSessionReq("sessions.patch", {
    key: acpKey,
    model: "qa-next",
    expectedSessionId: "acp-selection-session",
    expectedLifecycleRevision: "acp-selection-generation",
  });
  expect(result).toMatchObject({ ok: true });
  expect(readAcpExecutionSelection(state.readMeta())?.model).toEqual({ id: "qa-accepted" });
  expect(state.setConfigOption).toHaveBeenCalledWith(
    expect.objectContaining({ key: "model", value: "qa-next" }),
  );
  const reopened = new AcpSessionManager();
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
});

test.each([{ model: null }, { agentRuntime: null }])(
  "sessions.patch accepts a dedicated ACP default reset: %j",
  async (patch) => {
    const state = await setupSelection(null);
    const result = await directSessionReq("sessions.patch", { key: acpKey, ...patch });
    expect(result).toMatchObject({ ok: true });
    expect(readAcpExecutionSelection(state.readMeta())?.model).toBeNull();
    expect(state.setConfigOption).not.toHaveBeenCalled();
  },
);

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
