/** Tests configured binding controls against the real ACP manager lifecycle. */
import { describe, expect, it, vi } from "vitest";
import { buildConfiguredAcpSessionKey } from "../persistent-bindings.types.js";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  installAcpSessionStoreFixture,
} from "./manager.test-helpers.js";

describe("AcpSessionManager configured bindings", () => {
  installAcpSessionManagerTestLifecycle();

  it("keeps startup omission but rejects live binding changes before overwriting accepted thinking", async () => {
    const managerModule = await import("./manager.js");
    const { ensureConfiguredAcpBindingSession } =
      await import("../persistent-bindings.lifecycle.js");
    const runtimeState = createRuntime();
    runtimeState.setConfigOption.mockImplementation(async ({ key, value }) => {
      if (value === "off") {
        throw new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", "Live off is unsupported");
      }
      return {
        configOptions: [{ id: "thinking", currentValue: key === "model" ? "medium" : value }],
      };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const spec = {
      channel: "discord" as const,
      accountId: "default",
      conversationId: "configured-thinking",
      agentId: "codex",
      mode: "persistent" as const,
      thinking: "off",
    };
    const sessionKey = buildConfiguredAcpSessionKey(spec);
    const store = installAcpSessionStoreFixture({ sessionKey, agentId: spec.agentId });
    const manager = new AcpSessionManager();
    const getManager = vi.spyOn(managerModule, "getAcpSessionManagerCore").mockReturnValue(manager);
    const ensure = (thinking?: string) =>
      ensureConfiguredAcpBindingSession({ cfg: baseCfg, spec: { ...spec, thinking } });
    const runTurn = (requestId: string) =>
      manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey,
        text: requestId,
        mode: "prompt",
        requestId,
      });
    try {
      expect(await ensure("off")).toEqual({ ok: true, sessionKey });
      await runTurn("first");
      await runTurn("second");
      expect(store.readMeta()?.runtimeOptions?.thinking).toBe("off");

      expect(await ensure("high")).toEqual({ ok: true, sessionKey });
      await runTurn("third");
      const acceptedMeta = store.readMeta();
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await ensure("off")).toEqual({
          ok: false,
          sessionKey,
          error: "Live off is unsupported",
        });
        expect(store.readMeta()).toEqual(acceptedMeta);
      }
      expect(await ensure()).toEqual({ ok: true, sessionKey });
      await runTurn("fourth");
      expect(store.readMeta()?.runtimeOptions?.thinking).toBe("high");
      expect(runtimeState.ensureSession).toHaveBeenCalledOnce();
      expect(runtimeState.close).not.toHaveBeenCalled();
      expect(runtimeState.runTurn).toHaveBeenCalledTimes(4);
      runtimeState.setConfigOption.mockClear();
      expect(
        await ensureConfiguredAcpBindingSession({
          cfg: baseCfg,
          spec: { ...spec, model: "fixture/qa-other", thinking: "high" },
        }),
      ).toEqual({ ok: true, sessionKey });
      expect(
        runtimeState.setConfigOption.mock.calls.map(([input]) => [input.key, input.value]),
      ).toEqual([]);
      expect(store.readMeta()?.runtimeOptions).toEqual({ thinking: "high" });
      expect(
        await ensureConfiguredAcpBindingSession({
          cfg: { ...baseCfg, acp: { ...baseCfg.acp, backend: "qa-other-default" } },
          spec: { ...spec, thinking: "high" },
        }),
      ).toEqual({ ok: true, sessionKey });
      expect(runtimeState.ensureSession).toHaveBeenCalledOnce();
      expect(runtimeState.close).not.toHaveBeenCalled();
    } finally {
      getManager.mockRestore();
    }
  });
});
