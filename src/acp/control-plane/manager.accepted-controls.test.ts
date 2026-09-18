/** Accepted backend controls, not stale requests, own subsequent session replay. */
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import * as placementContext from "../../gateway/session-worker-placement-context.js";
import type { WorkerSessionPlacementRecord } from "../../gateway/worker-environments/placement-record.js";
import {
  commitSessionExecutionSelection,
  commitStoredSessionExecutionSelection,
} from "../../model-picker/apply-session-model-selection.js";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  installAcpSessionStoreFixture,
} from "./manager.test-helpers.js";
import { ACP_SELECTION_REPAIR_MESSAGE } from "./manager.utils.js";

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
  const store = installAcpSessionStoreFixture({
    sessionKey,
    entry: {
      sessionId: "accepted-controls",
      lifecycleRevision: "accepted-generation",
      updatedAt: 1,
    },
    selection: {
      executor: { kind: "acp", backend: "acpx", agent: "qa-agent" },
      model: initialModel ? { id: initialModel } : "native-managed",
    },
    meta: {
      runtimeSessionName: "runtime-1",
      mode: "persistent",
      state: "idle",
      lastActivityAt: 1,
      ...(thinking ? { runtimeOptions: { thinking } } : {}),
    },
  });
  hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
    id: "acpx",
    runtime: runtimeState.runtime,
  });
  runtimeState.getCapabilities.mockResolvedValue({
    controls: ["session/set_config_option", "session/status"],
    configOptionKeys: ["model", "reasoning_effort"],
  });
  return {
    ...runtimeState,
    ...store,
    readMeta: () => expectDefined(store.readMeta(), "persisted lifecycle"),
    manager: new AcpSessionManager(),
  };
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

  it.each(["before-control", "before-commit"] as const)(
    "rechecks placement after preparing a staged ACP choice: %s",
    async (phase) => {
      const state = setupSession();
      const previous = state.readSelection();
      await state.patchEntry({ agentId: "main", sessionKey }, (entry) => {
        commitStoredSessionExecutionSelection(entry, {
          state: "deferred",
          previous,
          fallbackPermission: "explicit",
          request: { executor: previous.executor, model: { id: "qa-next" } },
        });
        return entry;
      });
      const staged = state.readEntry().executionSelection;
      const placements = new Map<string, WorkerSessionPlacementRecord>();
      vi.spyOn(placementContext, "resolveSessionWorkerPlacementContext").mockReturnValue({
        workerSessionPlacementService: { getMany: () => placements },
      });
      const revokePlacement = () =>
        placements.set("accepted-controls", {
          sessionId: "accepted-controls",
          agentId: "main",
          sessionKey,
          state: "requested",
          executionMode: "remote-exec",
          generation: 1,
          turnClaim: null,
          environmentId: null,
          activeOwnerEpoch: null,
          workspaceBaseManifestRef: null,
          remoteWorkspaceDir: null,
          workerBundleHash: null,
          lastTranscriptAckCursor: null,
          lastLiveEventAckCursor: null,
          recoveryError: null,
          terminalReason: null,
          terminalAtMs: null,
          createdAtMs: 1,
          updatedAtMs: 1,
          stateChangedAtMs: 1,
        });
      if (phase === "before-control") {
        state.getCapabilities.mockImplementationOnce(async () => {
          revokePlacement();
          return { controls: ["session/set_config_option"], configOptionKeys: ["model"] };
        });
      } else {
        state.setConfigOption.mockImplementationOnce(async () => {
          revokePlacement();
          return { configOptions: [{ id: "model", category: "model", currentValue: "qa-next" }] };
        });
      }
      await expect(runTurn(state.manager, `placement-${phase}`)).rejects.toThrow("cloud placement");
      expect(state.setConfigOption).toHaveBeenCalledTimes(phase === "before-control" ? 0 : 1);
      expect(state.readEntry().executionSelection).toEqual(staged);
      expect(state.runTurn).not.toHaveBeenCalled();
    },
  );

  it("releases an unsubmitted model reservation after request authority expires", async () => {
    const state = setupSession();
    const before = state.readEntry();
    const write = expectDefined(
      hoisted.upsertAcpSessionMetaMock.getMockImplementation(),
      "canonical lifecycle writer",
    );
    let active = true;
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (input) => {
      const committed = await write(input);
      if (committed?.acp?.lastError === ACP_SELECTION_REPAIR_MESSAGE) {
        active = false;
      }
      return committed;
    });
    const commitAccepted = vi.fn(async () => {});
    await expect(
      state.manager.withExecutionSelection({
        cfg: baseCfg,
        sessionKey,
        commitAccepted,
        selection: { ...state.readSelection(), model: { id: "qa-next" } },
        assertActive: () => {
          if (!active) {
            throw new Error("selection authority expired");
          }
        },
      }),
    ).rejects.toThrow("selection authority expired");
    expect(commitAccepted).not.toHaveBeenCalled();
    expect(state.setConfigOption).not.toHaveBeenCalled();
    expect(state.readEntry()).toEqual(before);
    expect(state.readMeta().state).toBe("idle");
    expect(state.readMeta().lastError).toBeUndefined();
    await runTurn(new AcpSessionManager(), "after-unsubmitted-control");
    expect(state.runTurn).toHaveBeenCalledOnce();
  });

  it("advances session activity only after an accepted model commits", async () => {
    const state = setupSession();
    vi.spyOn(Date, "now").mockReturnValue(200);
    state.setConfigOption.mockImplementationOnce(async () => {
      expect(state.readEntry().updatedAt).toBe(1);
      return { configOptions: [{ id: "model", category: "model", currentValue: "qa-accepted" }] };
    });
    await state.manager.setSessionConfigOption({
      cfg: baseCfg,
      sessionKey,
      key: "model",
      value: "qa-next",
    });
    expect(state.readEntry().updatedAt).toBe(200);
    expect(state.readSelection().model).toEqual({ id: "qa-accepted" });
  });

  it("rejects a direct model control for a locked session before contacting the runtime", async () => {
    const state = setupSession();
    const read = hoisted.readAcpSessionEntryMock.getMockImplementation()!;
    hoisted.readAcpSessionEntryMock.mockImplementation((params) => {
      const current = read(params);
      return { ...current, entry: { ...current.entry, modelSelectionLocked: true } };
    });
    await expect(
      state.manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey,
        key: "model",
        value: "qa-next",
      }),
    ).rejects.toMatchObject({ code: "ACP_BACKEND_UNSUPPORTED_CONTROL" });
    expect(state.ensureSession).not.toHaveBeenCalled();
    expect(state.setConfigOption).not.toHaveBeenCalled();
    expect(state.readOptions().model).toBe(model);
  });

  it("returns the accepted model and uses it after reopening", async () => {
    const state = setupSession();
    state.setConfigOption.mockResolvedValue({
      configOptions: [{ id: "model", category: "model", currentValue: "qa-normalized" }],
    });
    const options = await state.manager.setSessionConfigOption({
      cfg: baseCfg,
      sessionKey,
      key: "model",
      value: "qa-requested",
    });
    expect(options.model).toBe("qa-normalized");
    expect(state.readSelection().model).toEqual({ id: "qa-normalized" });
    await runTurn(new AcpSessionManager(), "accepted-model-reopen");
    expect(state.ensureSession.mock.lastCall?.[0].model).toBe("qa-normalized");
  });

  it("accepts an empty backend snapshot as its agent-managed default", async () => {
    const state = setupSession();
    state.setConfigOption.mockResolvedValue({ configOptions: [] });
    const options = await state.manager.setSessionConfigOption({
      cfg: baseCfg,
      sessionKey,
      key: "model",
      value: "qa-requested",
    });
    expect(options.model).toBeUndefined();
    expect(state.readSelection().model).toBe("native-managed");
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
    expect(state.readOptions().model).toBe(model);
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
    state.patchEntry.mockRejectedValueOnce(new Error("selection commit failed"));
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
    expect(state.readOptions().model).toBe(model);
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
    const commitAccepted = vi.fn(async () => {});
    await expect(
      state.manager.withExecutionSelection({
        cfg: baseCfg,
        sessionKey,
        commitAccepted,
        selection: {
          executor: { kind: "acp", backend: "acpx", agent: state.readSelection().executor.agent },
          model: { id: "qa-next" },
        },
        assertActive: () => {
          if (!active) {
            throw new Error("selection authority ended");
          }
        },
      }),
    ).rejects.toThrow("selection authority ended");
    expect(commitAccepted).not.toHaveBeenCalled();
    expect(state.readOptions().model).toBe(model);
    expect(state.setConfigOption).toHaveBeenCalledOnce();
    await expect(runTurn(new AcpSessionManager(), "lost-selection-authority")).rejects.toThrow(
      "app did not confirm the last change",
    );
  });

  it.each(["sessionId", "lifecycleRevision"] as const)(
    "does not restore through an old handle after the session's %s changes",
    async (field) => {
      const state = setupSession();
      state.setConfigOption.mockImplementationOnce(async () => {
        const replacement = { ...state.readEntry(), [field]: "replacement-generation" };
        commitSessionExecutionSelection(replacement, {
          ...state.readSelection(),
          model: { id: "replacement-model" },
        });
        await state.patchEntry({ agentId: "main", sessionKey }, () => replacement, {
          replaceEntry: true,
        });
        await hoisted.upsertAcpSessionMetaMock({
          cfg: baseCfg,
          agentId: "main",
          sessionKey,
          preserveActivity: true,
          mutate: () => ({
            ...state.readMeta(),
            state: "error",
            lastError: ACP_SELECTION_REPAIR_MESSAGE,
          }),
        });
        return { configOptions: [{ id: "model", category: "model", currentValue: "qa-next" }] };
      });
      await expect(
        state.manager.setSessionConfigOption({
          cfg: baseCfg,
          sessionKey,
          key: "model",
          value: "qa-next",
        }),
      ).rejects.toThrow("session changed while its model selection was being applied");
      expect(state.setConfigOption).toHaveBeenCalledOnce();
      expect(state.readEntry()[field]).toBe("replacement-generation");
      expect(state.readSelection().model).toEqual({ id: "replacement-model" });
      expect(state.readMeta().lastError).toBe(ACP_SELECTION_REPAIR_MESSAGE);
    },
  );

  it("keeps the default selection paused when failed persistence cannot be restored", async () => {
    const state = setupSession(undefined, null);
    state.patchEntry.mockRejectedValueOnce(new Error("selection commit failed"));
    await expect(
      state.manager.setSessionConfigOption({
        cfg: baseCfg,
        sessionKey,
        key: "model",
        value: "qa-next",
      }),
    ).rejects.toThrow("selection commit failed");
    expect(state.readOptions().model).toBeUndefined();
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
    expect(state.readOptions().model).toBe(model);
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
    expect(state.readOptions()).toEqual(expectedOptions);
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
      expect(state.readOptions()).toEqual({ model, thinking: "medium" });
    },
  );

  it.each(["medium", undefined])(
    "reconciles automatic model acknowledgement before effort replay: %s",
    async (accepted) => {
      const state = setupSession("high");
      state.setConfigOption.mockResolvedValue(acceptedOptions(accepted));
      const expectedOptions = { model, ...(accepted ? { thinking: accepted } : {}) };
      state.runTurn.mockImplementation(async function* () {
        expect(state.readOptions()).toEqual(expectedOptions);
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

  it("keeps later accepted controls after automatic model normalization changes the pair", async () => {
    const state = setupSession("high", "qa-request-alias");
    state.setConfigOption.mockImplementation(async ({ key }) =>
      acceptedOptions(key === "model" ? "medium" : "low"),
    );
    await runTurn(state.manager, "normalized-model-then-thinking");
    expect(state.readSelection().model).toEqual({ id: model });
    expect(state.readOptions()).toEqual({ model, thinking: "low" });
    expect(state.readMeta().runtimeOptions).not.toHaveProperty("model");
    expect(state.runTurn).toHaveBeenCalledOnce();
  });

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
      expect(state.readOptions()).toEqual({ model, thinking: "high" });
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
    expect(state.readOptions()).toEqual({
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
    expect(state.readOptions()).toEqual({ model, backendExtras: { effort: "high" } });
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
