/** Tests ACP runtime config validation and backend-applied model persistence. */
import { describe, expect, it } from "vitest";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectMockCallFields,
  expectNoMockCallFields,
  expectRejectedRecord,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  installAcpSessionStoreFixture,
  installReadyAcpSessionStoreFixture,
} from "./manager.test-helpers.js";

describe("AcpSessionManager runtime config validation", () => {
  installAcpSessionManagerTestLifecycle();

  it("rejects invalid runtime option values before backend controls run", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    installReadyAcpSessionStoreFixture("agent:codex:acp:session-1");

    const manager = new AcpSessionManager();
    await expectRejectedRecord(
      manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        key: "timeout",
        value: "not-a-number",
      }),
      { code: "ACP_INVALID_RUNTIME_OPTION" },
    );
    expect(runtimeState.setConfigOption).not.toHaveBeenCalled();

    await expectRejectedRecord(
      manager.updateSessionRuntimeOptions({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        patch: { cwd: "relative/path" },
      }),
      { code: "ACP_INVALID_RUNTIME_OPTION" },
    );
  });

  it("never replays an inherited foreign default that the backend dropped at session init", async () => {
    const sessionKey = "agent:codex:acp:session-dropped-default";
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockImplementation(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `${input.sessionKey}:runtime`,
      appliedModel: { kind: "dropped" as const },
    }));
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    const store = installAcpSessionStoreFixture({ sessionKey, agentId: "codex" });

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "codex",
      mode: "persistent",
      runtimeOptions: {
        model: "foreign/qa-default",
        thinking: "low",
      },
    });

    expect(store.readMeta()?.runtimeOptions).toEqual({ thinking: "low" });

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "do work",
      mode: "prompt",
      requestId: "run-dropped-default",
      provenance: "system",
    });

    expectNoMockCallFields(runtimeState.setConfigOption, { key: "model" });
    expectMockCallFields(runtimeState.setConfigOption, { key: "thinking", value: "low" });
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
  });

  it("persists and replays a supported model the backend applied at session init", async () => {
    const sessionKey = "agent:codex:acp:session-applied-model";
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockImplementation(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `${input.sessionKey}:runtime`,
      appliedModel: { kind: "applied" as const, model: input.model ?? "" },
    }));
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    const store = installAcpSessionStoreFixture({ sessionKey, agentId: "codex" });

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "codex",
      mode: "persistent",
      runtimeOptions: {
        model: "fixture/qa-model",
      },
    });

    expect(store.readSelection().model).toEqual({ id: "fixture/qa-model" });
    expect(store.readMeta()?.runtimeOptions).toBeUndefined();

    await manager.runTurn({
      cfg: baseCfg,
      sessionKey,
      text: "do work",
      mode: "prompt",
      requestId: "run-applied-model",
      provenance: "system",
    });

    expectMockCallFields(runtimeState.setConfigOption, {
      key: "model",
      value: "fixture/qa-model",
    });
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
  });

  it.each(["Invalid value for config option effort: off", "Unknown config option: effort"])(
    "continues turns when adapters reject automatic thinking: %s",
    async (details) => {
      const runtimeState = createRuntime();
      runtimeState.getCapabilities.mockResolvedValue({
        controls: ["session/set_mode", "session/set_config_option", "session/status"],
        configOptionKeys: ["mode", "model", "effort"],
      });
      runtimeState.setConfigOption.mockImplementation(async (input: { key: string }) => {
        if (input.key === "effort") {
          throw Object.assign(new Error("Internal error"), {
            name: "RequestError",
            code: -32603,
            data: { details },
          });
        }
      });
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      installAcpSessionStoreFixture({
        sessionKey: "agent:claude:acp:session-1",
        agentId: "claude",
        selection: {
          executor: { kind: "acp", backend: "acpx", agent: "claude" },
          model: "native-managed",
        },
        meta: {
          runtimeSessionName: "runtime-1",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 1,
          runtimeOptions: { thinking: "off" },
        },
      });

      const manager = new AcpSessionManager();
      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:claude:acp:session-1",
        text: "do work",
        mode: "prompt",
        requestId: "run-1",
      });

      expectMockCallFields(runtimeState.setConfigOption, {
        key: "effort",
        value: "off",
      });
      expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
    },
  );

  it("fails turns when thinking config writes hit runtime failures", async () => {
    const runtimeState = createRuntime();
    runtimeState.getCapabilities.mockResolvedValue({
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
      configOptionKeys: ["mode", "model", "effort"],
    });
    runtimeState.setConfigOption.mockImplementation(async (input: { key: string }) => {
      if (input.key === "effort") {
        throw Object.assign(new Error("Internal error"), {
          name: "RequestError",
          code: -32603,
          data: { details: "unsupported transport protocol" },
        });
      }
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    installAcpSessionStoreFixture({
      sessionKey: "agent:claude:acp:session-1",
      agentId: "claude",
      selection: {
        executor: { kind: "acp", backend: "acpx", agent: "claude" },
        model: "native-managed",
      },
      meta: {
        runtimeSessionName: "runtime-1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 1,
        runtimeOptions: { thinking: "off" },
      },
    });

    const manager = new AcpSessionManager();
    await expectRejectedRecord(
      manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:claude:acp:session-1",
        text: "do work",
        mode: "prompt",
        requestId: "run-1",
      }),
      {
        code: "ACP_TURN_FAILED",
      },
    );

    expect(runtimeState.runTurn).not.toHaveBeenCalled();
  });
});
