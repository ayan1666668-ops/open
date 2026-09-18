import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
/** Tests ACP manager session initialization and persisted runtime options. */
import { getAcpSessionResetControls } from "./manager.reset-controls.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectRecordFields,
  extractRuntimeOptionsFromUpserts,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockCallArg,
  installAcpSessionStoreFixture,
} from "./manager.test-helpers.js";

describe("AcpSessionManager initializeSession", () => {
  installAcpSessionManagerTestLifecycle();

  it("persists runtime options provided during initializeSession", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const store = installAcpSessionStoreFixture({
      sessionKey: "agent:codex:acp:session-a",
      agentId: "codex",
    });

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-a",
      agent: "codex",
      mode: "persistent",
      runtimeOptions: {
        model: "fixture/qa-model",
        thinking: "high",
      },
    });

    expect(extractRuntimeOptionsFromUpserts()).toEqual([{ thinking: "high" }]);
    expect(store.readSelection().model).toEqual({ id: "fixture/qa-model" });
    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey: "agent:codex:acp:session-a",
      model: "fixture/qa-model",
      thinking: "high",
    });
  });

  it("forwards inherited thinking provenance and omits thinking dropped by the backend", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValueOnce({
      sessionKey: "agent:codex:acp:session-inherited-max",
      backend: "acpx",
      runtimeSessionName: "codex",
      appliedThinking: { kind: "dropped" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    installAcpSessionStoreFixture({
      sessionKey: "agent:codex:acp:session-inherited-max",
      agentId: "codex",
    });

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-inherited-max",
      agent: "codex",
      mode: "persistent",
      runtimeOptions: { thinking: "max" },
      thinkingExplicit: false,
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      thinking: "max",
      thinkingExplicit: false,
    });
    expect(extractRuntimeOptionsFromUpserts()).toEqual([undefined]);
  });

  it("preserves runtimeOptions cwd when initializeSession cwd is omitted", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    installAcpSessionStoreFixture({
      sessionKey: "agent:codex:acp:session-cwd-runtime-options",
      agentId: "codex",
    });

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-cwd-runtime-options",
      agent: "codex",
      mode: "persistent",
      runtimeOptions: {
        cwd: "/workspace/from-runtime-options",
      },
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey: "agent:codex:acp:session-cwd-runtime-options",
      cwd: "/workspace/from-runtime-options",
    });
    expect(extractRuntimeOptionsFromUpserts()).toEqual([
      {
        cwd: "/workspace/from-runtime-options",
      },
    ]);
  });

  it("rolls back ensured runtime sessions when metadata persistence fails", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockRejectedValueOnce(new Error("disk full"));

    const manager = new AcpSessionManager();
    await expect(
      manager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        agent: "codex",
        mode: "persistent",
      }),
    ).rejects.toThrow("disk full");
    const closeInput = mockCallArg(runtimeState.close);
    expectRecordFields(closeInput, {
      reason: "init-meta-failed",
    });
    expectRecordFields(closeInput.handle, {
      sessionKey: "agent:codex:acp:session-1",
    });
  });

  it("does not let reset-superseded initialization republish a stale runtime handle", async () => {
    const runtimeState = createRuntime();
    const releaseOldInit = createDeferred();
    let ensureCount = 0;
    runtimeState.ensureSession.mockImplementation(async (input) => {
      const callNumber = ++ensureCount;
      if (callNumber === 1) {
        await releaseOldInit.promise;
      }
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `runtime-${callNumber}`,
        backendSessionId: `backend-${callNumber}`,
      };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    const sessionKey = "agent:codex:acp:child-1";
    const store = installAcpSessionStoreFixture({ sessionKey, agentId: "codex" });

    const manager = new AcpSessionManager();
    const staleInitialization = manager.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "codex",
      mode: "persistent",
    });
    await vi.waitFor(() => {
      expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    });

    await getAcpSessionResetControls(manager).forceDiscardSessionRuntime({
      cfg: baseCfg,
      sessionKey,
      reason: "session-reset",
    });
    const fresh = await manager.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "codex",
      mode: "persistent",
    });
    expect(fresh.handle.runtimeSessionName).toBe("runtime-2");

    releaseOldInit.resolve();
    await expect(staleInitialization).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      detailCode: "SESSION_ACTOR_SUPERSEDED",
    });
    expect(store.readMeta()?.runtimeSessionName).toBe("runtime-2");
    expectRecordFields(mockCallArg(runtimeState.close), {
      handle: expect.objectContaining({ runtimeSessionName: "runtime-1" }),
      reason: "session-actor-superseded",
      discardPersistentState: true,
    });

    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "follow-up turn",
      mode: "prompt",
      requestId: "follow-up-turn",
    });
    expect(ensureCount).toBe(2);
    expectRecordFields(mockCallArg(runtimeState.runTurn), {
      handle: expect.objectContaining({ runtimeSessionName: "runtime-2" }),
    });
  });
});
