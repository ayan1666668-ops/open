/** Accepted backend controls, not stale requests, own subsequent session replay. */
import { describe, expect, it, vi } from "vitest";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

const sessionKey = "agent:main:acp:accepted-controls";
const model = "fixture/qa-model";

function acceptedOptions(thinking?: string, choices = thinking ? [thinking] : [], grouped = false) {
  const options = choices.map((value) => ({ value, name: value }));
  return {
    configOptions: [
      { id: "model", category: "model", currentValue: model },
      ...(thinking
        ? [
            {
              id: "reasoning_effort",
              category: "thought_level",
              currentValue: thinking,
              options: grouped ? [{ group: "effort", name: "Effort", options }] : options,
            },
          ]
        : []),
      { id: "approval_policy", currentValue: "default" },
    ],
  };
}

function setupSession(thinking?: string, initialModel: string | null = model) {
  const runtimeState = createRuntime();
  let meta = readySessionMeta({
    runtimeOptions: {
      ...(initialModel ? { model: initialModel } : {}),
      ...(thinking ? { thinking } : {}),
    },
  });
  hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
    id: "acpx",
    runtime: runtimeState.runtime,
  });
  hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
    sessionKey,
    storeSessionKey: sessionKey,
    cfg: baseCfg,
    agentId: "main",
    entry: { sessionId: "accepted-controls", updatedAt: Date.now() },
    acp: meta,
  }));
  hoisted.upsertAcpSessionMetaMock.mockImplementation(
    async (params: {
      assertCommitAllowed?: () => void;
      mutate: (
        current: SessionAcpMeta,
        entry: { acp: SessionAcpMeta },
      ) => SessionAcpMeta | null | undefined;
    }) => {
      const next = params.mutate(meta, { acp: meta });
      params.assertCommitAllowed?.();
      meta = next ?? meta;
      return { sessionId: "accepted-controls", updatedAt: Date.now(), acp: meta };
    },
  );
  runtimeState.getCapabilities.mockResolvedValue({
    controls: ["session/set_config_option", "session/status"],
    configOptionKeys: ["model", "reasoning_effort"],
  });
  return { ...runtimeState, readMeta: () => meta, manager: new AcpSessionManager() };
}

async function runTurn(manager: AcpSessionManager, requestId: string) {
  await manager.runTurn({
    cfg: baseCfg,
    sessionKey,
    text: "continue",
    mode: "prompt",
    requestId,
    provenance: "system",
  });
}

describe("AcpSessionManager accepted controls", () => {
  installAcpSessionManagerTestLifecycle();

  it("returns the accepted model and uses it after reopening", async () => {
    const state = setupSession();
    state.setConfigOption.mockResolvedValue({
      configOptions: [{ id: "model", category: "model", currentValue: "qa-normalized" }],
    });
    const selection = await state.manager.setExecutionSelection({
      cfg: baseCfg,
      sessionKey,
      selection: {
        executor: { kind: "acp", backend: "acpx", agent: state.readMeta().agent },
        model: { id: "qa-requested" },
      },
    });
    expect(selection.model).toEqual({ id: "qa-normalized" });
    await runTurn(new AcpSessionManager(), "accepted-model-reopen");
    expect(state.ensureSession.mock.lastCall?.[0].model).toBe("qa-normalized");
  });

  it("accepts an empty backend snapshot as its agent-managed default", async () => {
    const state = setupSession();
    state.setConfigOption.mockResolvedValue({ configOptions: [] });
    const selection = await state.manager.setExecutionSelection({
      cfg: baseCfg,
      sessionKey,
      selection: {
        executor: { kind: "acp", backend: "acpx", agent: state.readMeta().agent },
        model: { id: "qa-requested" },
      },
    });
    expect(selection.model).toBeNull();
    await runTurn(new AcpSessionManager(), "accepted-default-reopen");
    expect(state.ensureSession.mock.lastCall?.[0].model).toBeUndefined();
  });

  it("keeps the next turn behind an outstanding control", async () => {
    const state = setupSession();
    let resolveControl: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolveControl = resolve;
    });
    state.setConfigOption.mockImplementationOnce(async () => await pending);
    const change = state.manager.setSessionConfigOption({
      cfg: baseCfg,
      sessionKey,
      key: "model",
      value: "qa-next",
    });
    await vi.waitFor(() => expect(state.setConfigOption).toHaveBeenCalledOnce());
    const next = runTurn(state.manager, "queued-after-control");
    await expect(runTurn(new AcpSessionManager(), "reopened-during-control")).rejects.toThrow(
      "app did not confirm the last change",
    );
    expect(state.runTurn).not.toHaveBeenCalled();
    resolveControl?.();
    await change;
    await next;
    expect(state.runTurn).toHaveBeenCalledOnce();
  });

  it("pauses both this manager and a reopened manager after unconfirmed application", async () => {
    const state = setupSession();
    state.setConfigOption.mockRejectedValueOnce(new Error("control result lost"));
    await expect(
      state.manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey,
        key: "model",
        value: "qa-next",
      }),
    ).rejects.toThrow("control result lost");
    expect(state.readMeta().runtimeOptions?.model).toBe(model);
    await expect(runTurn(state.manager, "paused-current")).rejects.toThrow(
      "app did not confirm the last change",
    );
    await expect(runTurn(new AcpSessionManager(), "paused-reopened")).rejects.toThrow(
      "app did not confirm the last change",
    );
    expect(state.runTurn).not.toHaveBeenCalled();
  });

  it("restores the committed model when application succeeded but persistence failed", async () => {
    const state = setupSession();
    const persist = hoisted.upsertAcpSessionMetaMock.getMockImplementation()!;
    hoisted.upsertAcpSessionMetaMock.mockImplementation(
      async (params) =>
        await persist({
          ...params,
          mutate: (current: SessionAcpMeta, entry: { acp: SessionAcpMeta }) => {
            const next = params.mutate(current, entry);
            if (next?.runtimeOptions?.model === "qa-next")
              throw new Error("selection commit failed");
            return next;
          },
        }),
    );
    await expect(
      state.manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey,
        key: "model",
        value: "qa-next",
      }),
    ).rejects.toThrow("selection commit failed");
    expect(state.setConfigOption.mock.calls.map(([input]) => input.value)).toEqual([
      "qa-next",
      model,
    ]);
    expect(state.readMeta().runtimeOptions?.model).toBe(model);
    expect(state.readMeta().state).toBe("idle");
    await runTurn(new AcpSessionManager(), "restored-model-reopen");
    expect(state.ensureSession.mock.lastCall?.[0].model).toBe(model);
  });

  it("does not publish or restore with caller authority lost during a remote control", async () => {
    const state = setupSession();
    let active = true;
    state.setConfigOption.mockImplementationOnce(async () => {
      active = false;
    });
    await expect(
      state.manager.setExecutionSelection({
        cfg: baseCfg,
        sessionKey,
        selection: {
          executor: { kind: "acp", backend: "acpx", agent: state.readMeta().agent },
          model: { id: "qa-next" },
        },
        assertActive: () => {
          if (!active) throw new Error("selection authority ended");
        },
      }),
    ).rejects.toThrow("selection authority ended");
    expect(state.readMeta().runtimeOptions?.model).toBe(model);
    expect(state.setConfigOption).toHaveBeenCalledOnce();
    await expect(runTurn(new AcpSessionManager(), "lost-selection-authority")).rejects.toThrow(
      "app did not confirm the last change",
    );
  });

  it("keeps the default selection paused when failed persistence cannot be restored", async () => {
    const state = setupSession(undefined, null);
    const persist = hoisted.upsertAcpSessionMetaMock.getMockImplementation()!;
    hoisted.upsertAcpSessionMetaMock.mockImplementation(
      async (params) =>
        await persist({
          ...params,
          mutate: (current: SessionAcpMeta, entry: { acp: SessionAcpMeta }) => {
            const next = params.mutate(current, entry);
            if (next?.runtimeOptions?.model === "qa-next")
              throw new Error("selection commit failed");
            return next;
          },
        }),
    );
    await expect(
      state.manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey,
        key: "model",
        value: "qa-next",
      }),
    ).rejects.toThrow("selection commit failed");
    expect(state.readMeta().runtimeOptions?.model).toBeUndefined();
    expect(state.setConfigOption).toHaveBeenCalledOnce();
    await expect(runTurn(new AcpSessionManager(), "default-restore-unavailable")).rejects.toThrow(
      "app did not confirm the last change",
    );
    expect(state.runTurn).not.toHaveBeenCalled();
  });

  it("refuses a default reset before mutating a conversation with an explicit model", async () => {
    const state = setupSession();
    await expect(
      state.manager.resetSessionRuntimeOptions({ cfg: baseCfg, sessionKey }),
    ).rejects.toThrow("cannot restore its default model");
    expect(state.setConfigOption).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
    expect(state.readMeta().runtimeOptions?.model).toBe(model);
  });

  it.each([
    { name: "clamped thinking", selected: "high", accepted: "medium", expected: "medium" },
    {
      name: "removed thinking control",
      selected: "high",
      accepted: undefined,
      expected: undefined,
    },
    {
      name: "unselected backend defaults",
      selected: undefined,
      accepted: "medium",
      expected: undefined,
    },
  ])("persists $name after an explicit model change", async ({ selected, accepted, expected }) => {
    const state = setupSession(selected, "fixture/qa-original");
    state.setConfigOption.mockResolvedValue(acceptedOptions(accepted, ["low", "medium", "high"]));
    const result = await state.manager.setSessionConfigOption({
      cfg: baseCfg,
      sessionKey,
      key: "model",
      value: model,
    });
    const expectedOptions = { model, ...(expected ? { thinking: expected } : {}) };
    expect(result).toEqual(expectedOptions);
    expect(state.readMeta().runtimeOptions).toEqual(expectedOptions);
    await runTurn(state.manager, "after-selection");
    expect(
      state.setConfigOption.mock.calls.some(
        ([input]) => input.key === "reasoning_effort" && input.value === "high",
      ),
    ).toBe(false);
  });

  it.each(["thinking", "effort", "reasoning_effort", "thought_level"])(
    "persists the accepted value of an explicit %s selection",
    async (key) => {
      const state = setupSession();
      state.setConfigOption.mockResolvedValue(acceptedOptions("medium", ["low", "medium", "high"]));
      await expect(
        state.manager.setSessionConfigOption({ cfg: baseCfg, sessionKey, key, value: "high" }),
      ).resolves.toEqual({ model, thinking: "medium" });
      expect(state.readMeta().runtimeOptions).toEqual({ model, thinking: "medium" });
    },
  );

  it.each(["medium", undefined])(
    "reconciles automatic model acknowledgement before effort replay: %s",
    async (accepted) => {
      const state = setupSession("high");
      state.setConfigOption.mockResolvedValue(acceptedOptions(accepted));
      const expectedOptions = { model, ...(accepted ? { thinking: accepted } : {}) };
      state.runTurn.mockImplementation(async function* () {
        expect(state.readMeta().runtimeOptions).toEqual(expectedOptions);
        yield { type: "done" };
      });
      await runTurn(state.manager, "first");
      expect(state.setConfigOption.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
        ["model", model],
        ...(accepted ? [["reasoning_effort", accepted]] : []),
      ]);
      const controlCalls = state.setConfigOption.mock.calls.length;
      await runTurn(state.manager, "cached");
      expect(state.setConfigOption).toHaveBeenCalledTimes(controlCalls);
      await runTurn(new AcpSessionManager(), "reopened");
      expect(state.ensureSession.mock.lastCall?.[0]).toMatchObject(expectedOptions);
      expect(state.ensureSession.mock.lastCall?.[0].thinking).toBe(accepted);
    },
  );

  it("retains requested preferences for a shipped void-returning backend", async () => {
    const state = setupSession("high");
    await expect(
      state.manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey,
        key: "model",
        value: model,
      }),
    ).resolves.toEqual({ model, thinking: "high" });
    await runTurn(state.manager, "legacy-backend");
    expect(
      state.setConfigOption.mock.calls.map(([input]) => [input.key, input.value]),
    ).toContainEqual(["reasoning_effort", "high"]);
  });

  it.each(["fresh", "updated"])(
    "applies valid pending thinking with a %s handle instead of accepting the old model effort",
    async (lifecycle) => {
      const state = setupSession(lifecycle === "fresh" ? "high" : "low");
      let backendThinking = "low";
      state.setConfigOption.mockImplementation(async ({ key, value }) => {
        if (key === "reasoning_effort") {
          backendThinking = value;
        }
        return acceptedOptions(backendThinking, ["low", "medium", "high"], lifecycle === "updated");
      });
      if (lifecycle === "updated") {
        await runTurn(state.manager, "initial-low");
        await state.manager.updateSessionRuntimeOptions({
          cfg: baseCfg,
          sessionKey,
          patch: { thinking: "high" },
        });
        state.setConfigOption.mockClear();
      }
      await runTurn(state.manager, "pending-high");
      expect(backendThinking).toBe("high");
      expect(state.readMeta().runtimeOptions).toEqual({ model, thinking: "high" });
      expect(state.setConfigOption.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
        ["model", model],
        ["reasoning_effort", "high"],
      ]);
      await runTurn(state.manager, "cached-high");
      expect(state.setConfigOption).toHaveBeenCalledTimes(2);
      backendThinking = "low";
      await runTurn(new AcpSessionManager(), "reopened-high");
      expect(backendThinking).toBe("high");
    },
  );

  it("keeps accepted thinking when a later automatic control fails", async () => {
    const state = setupSession("high");
    await state.manager.updateSessionRuntimeOptions({
      cfg: baseCfg,
      sessionKey,
      patch: { permissionProfile: "strict" },
    });
    state.getCapabilities.mockResolvedValue({ controls: ["session/set_config_option"] });
    state.setConfigOption.mockImplementation(async ({ key }) => {
      if (key === "approval_policy") {
        throw new Error("control transport disconnected");
      }
      return acceptedOptions("medium");
    });
    await expect(runTurn(state.manager, "partial-controls")).rejects.toThrow(
      "control transport disconnected",
    );
    expect(state.readMeta().runtimeOptions).toEqual({
      model,
      thinking: "medium",
      permissionProfile: "strict",
    });
    expect(state.runTurn).not.toHaveBeenCalled();
  });

  it("still replays backend extras when no canonical thinking override was selected", async () => {
    const state = setupSession();
    await state.manager.updateSessionRuntimeOptions({
      cfg: baseCfg,
      sessionKey,
      patch: { backendExtras: { effort: "high" } },
    });
    await runTurn(state.manager, "backend-extras");
    expect(
      state.setConfigOption.mock.calls.map(([input]) => [input.key, input.value]),
    ).toContainEqual(["reasoning_effort", "high"]);
    expect(state.readMeta().runtimeOptions).toEqual({ model, backendExtras: { effort: "high" } });
  });

  it.each([
    {
      key: "effort",
      wireKey: "reasoning_effort",
      code: "ACP_BACKEND_UNSUPPORTED_CONTROL",
      continues: true,
    },
    {
      key: "timeout",
      wireKey: "timeout",
      code: "ACP_BACKEND_UNSUPPORTED_CONTROL",
      continues: true,
    },
    {
      key: "custom_control",
      wireKey: "custom_control",
      code: "ACP_BACKEND_UNSUPPORTED_CONTROL",
      continues: false,
    },
    {
      key: "effort",
      wireKey: "reasoning_effort",
      code: "ACP_BACKEND_UNAVAILABLE",
      continues: false,
    },
  ] as const)(
    "preserves $key rejection policy ($code) after model acknowledgement",
    async ({ key, wireKey, code, continues }) => {
      const state = setupSession();
      const value = key === "timeout" ? "30" : "high";
      await state.manager.updateSessionRuntimeOptions({
        cfg: baseCfg,
        sessionKey,
        patch: { backendExtras: { [key]: value } },
      });
      state.getCapabilities.mockResolvedValue({
        controls: ["session/set_config_option"],
        configOptionKeys: ["model", wireKey],
      });
      state.setConfigOption.mockImplementation(async ({ key: controlKey }) => {
        if (controlKey === wireKey) {
          throw new AcpRuntimeError(code, "Backend control rejected");
        }
        return acceptedOptions();
      });
      const turn = runTurn(state.manager, "removed-backend-extra");
      if (continues) {
        await expect(turn).resolves.toBeUndefined();
        expect(state.runTurn).toHaveBeenCalledOnce();
      } else {
        await expect(turn).rejects.toMatchObject({ code });
        expect(state.runTurn).not.toHaveBeenCalled();
      }
      expect(state.setConfigOption.mock.calls.map(([input]) => [input.key, input.value])).toEqual([
        ["model", model],
        [wireKey, value],
      ]);
    },
  );
});
