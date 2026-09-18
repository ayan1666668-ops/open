import { expectDefined } from "@openclaw/normalization-core";
/** Tests ACP manager backend failover across initialization and turn execution. */
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import { commitSessionExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
import type {
  AcpExecutionSelection,
  ExecutionFallbackPermission,
} from "../../model-picker/execution-selection.js";
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

function failBeforeOutput(message = "backend unavailable") {
  return async function* () {
    yield await Promise.reject(new AcpRuntimeError("ACP_TURN_FAILED", message));
  };
}

describe("AcpSessionManager backend failover", () => {
  installAcpSessionManagerTestLifecycle();

  function setupFailoverBackends(
    params: {
      initialBackend?: "primary-backend" | "fallback-backend";
      primaryUnavailableError?: Error;
      fallbackUnavailableError?: Error;
      fallbackPermission?: ExecutionFallbackPermission;
      model?: string;
    } = {},
  ) {
    const primaryRuntime = createRuntime();
    const fallbackRuntime = createRuntime();
    const sessionKey = "agent:main:acp:session-1";
    const initialBackend = params.initialBackend ?? "primary-backend";
    primaryRuntime.ensureSession.mockImplementation(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "primary-backend",
      runtimeSessionName: "primary-runtime",
    }));
    fallbackRuntime.ensureSession.mockImplementation(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "fallback-backend",
      runtimeSessionName: "fallback-runtime",
    }));
    hoisted.requireAcpRuntimeBackendMock.mockImplementation((backendId?: string) => {
      if (backendId === "primary-backend") {
        if (params.primaryUnavailableError) {
          throw params.primaryUnavailableError;
        }
        return {
          id: "primary-backend",
          runtime: primaryRuntime.runtime,
        };
      }
      if (backendId === "fallback-backend") {
        if (params.fallbackUnavailableError) {
          throw params.fallbackUnavailableError;
        }
        return {
          id: "fallback-backend",
          runtime: fallbackRuntime.runtime,
        };
      }
      throw new Error(`unexpected backend ${backendId ?? "<auto>"}`);
    });
    const cfg = {
      acp: {
        ...baseCfg.acp,
        backend: "primary-backend",
        fallbacks: ["fallback-backend"],
      },
    } as OpenClawConfig;
    const selection: AcpExecutionSelection = {
      executor: { kind: "acp", backend: initialBackend, agent: "qa-agent" },
      model: params.model ? { id: params.model } : "native-managed",
    };
    const store = installAcpSessionStoreFixture({
      cfg,
      sessionKey,
      entry: {
        sessionId: "session-1",
        updatedAt: 1,
        executionSelection: {
          state: "accepted",
          selection,
          fallbackPermission: params.fallbackPermission ?? "configured",
        },
      },
      meta: {
        runtimeSessionName:
          initialBackend === "fallback-backend" ? "fallback-runtime" : "primary-runtime",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 1,
      },
    });
    return {
      cfg,
      fallbackRuntime,
      get currentMeta() {
        return expectDefined(store.readMeta(), "persisted lifecycle");
      },
      get selection() {
        return store.readSelection();
      },
      primaryRuntime,
      sessionKey,
      store,
    };
  }

  it("retains the accepted backend when configured policy changes", async () => {
    const harness = setupFailoverBackends({ initialBackend: "fallback-backend" });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: harness.cfg,
      sessionKey: harness.sessionKey,
      text: "use primary",
      mode: "prompt",
      requestId: "r-primary",
    });

    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledWith("fallback-backend");
    expect(harness.fallbackRuntime.runTurn).toHaveBeenCalledTimes(1);
    expect(harness.primaryRuntime.runTurn).not.toHaveBeenCalled();
    expect(harness.selection.executor.backend).toBe("fallback-backend");
  });

  it("closes turn-local fallback handles before returning and retains the primary selection", async () => {
    const harness = setupFailoverBackends();
    harness.primaryRuntime.runTurn.mockImplementationOnce(failBeforeOutput());

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: harness.cfg,
      sessionKey: harness.sessionKey,
      text: "use fallback",
      mode: "prompt",
      requestId: "r-fallback",
    });
    expect(harness.selection.executor.backend).toBe("primary-backend");
    expect(harness.fallbackRuntime.runTurn).toHaveBeenCalledTimes(1);
    expect(harness.fallbackRuntime.close).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "turn-local-fallback-complete" }),
    );

    harness.fallbackRuntime.close.mockClear();
    await manager.runTurn({
      provenance: "system",
      cfg: harness.cfg,
      sessionKey: harness.sessionKey,
      text: "return to primary",
      mode: "prompt",
      requestId: "r-primary",
    });

    expect(harness.fallbackRuntime.close).not.toHaveBeenCalled();
    expect(harness.primaryRuntime.runTurn).toHaveBeenCalledTimes(2);
    expect(harness.selection.executor.backend).toBe("primary-backend");
  });

  it.each([undefined, "qa-model"])(
    "does not change an explicit ACP pair when its model is %s",
    async (model) => {
      const harness = setupFailoverBackends({
        model,
        fallbackPermission: "explicit",
        primaryUnavailableError: new AcpRuntimeError(
          "ACP_BACKEND_UNAVAILABLE",
          "primary backend unavailable",
        ),
      });
      const selected = harness.selection;
      await expect(
        new AcpSessionManager().runTurn({
          cfg: harness.cfg,
          sessionKey: harness.sessionKey,
          provenance: "system",
          text: "retain my selected pair",
          mode: "prompt",
          requestId: "strict-selection",
        }),
      ).rejects.toMatchObject({ code: "ACP_BACKEND_UNAVAILABLE" });
      expect(harness.fallbackRuntime.ensureSession).not.toHaveBeenCalled();
      expect(harness.selection).toEqual(selected);
    },
  );

  it("revalidates fallback permission after closing the previous backend", async () => {
    const harness = setupFailoverBackends();
    harness.primaryRuntime.runTurn.mockImplementationOnce(failBeforeOutput());
    harness.primaryRuntime.close.mockImplementationOnce(async () => {
      await harness.store.patchEntry(
        { agentId: "main", sessionKey: harness.sessionKey },
        (entry) => {
          commitSessionExecutionSelection(entry, harness.selection);
          return entry;
        },
      );
    });
    await expect(
      new AcpSessionManager().runTurn({
        cfg: harness.cfg,
        sessionKey: harness.sessionKey,
        provenance: "system",
        text: "keep the newly explicit pair",
        mode: "prompt",
        requestId: "revoked-fallback",
      }),
    ).rejects.toMatchObject({ code: "ACP_SESSION_INIT_FAILED" });
    expect(harness.fallbackRuntime.ensureSession).not.toHaveBeenCalled();
    expect(harness.currentMeta.lastError).not.toBe(ACP_SELECTION_REPAIR_MESSAGE);
  });

  it.each(["ACP_BACKEND_MISSING", "ACP_BACKEND_UNAVAILABLE"] as const)(
    "allows primary recovery after an unused fallback fails with %s",
    async (code) => {
      const harness = setupFailoverBackends({
        fallbackUnavailableError: new AcpRuntimeError(code, "fallback backend unavailable"),
      });
      harness.primaryRuntime.runTurn.mockImplementationOnce(failBeforeOutput());
      const selected = harness.selection;
      const input = {
        cfg: harness.cfg,
        sessionKey: harness.sessionKey,
        provenance: "system" as const,
        text: "continue",
        mode: "prompt" as const,
        requestId: "unavailable-fallback",
      };
      await expect(new AcpSessionManager().runTurn(input)).rejects.toMatchObject({ code });
      expect(harness.fallbackRuntime.ensureSession).not.toHaveBeenCalled();
      await new AcpSessionManager().runTurn({ ...input, requestId: "primary-recovered" });
      expect(harness.primaryRuntime.runTurn).toHaveBeenCalledTimes(2);
      expect(harness.selection).toEqual(selected);
      expect(harness.currentMeta).toMatchObject({
        state: "idle",
        runtimeSessionName: "primary-runtime",
      });
    },
  );

  it("pauses a reopened session when fallback cleanup cannot be confirmed", async () => {
    const harness = setupFailoverBackends({
      primaryUnavailableError: new AcpRuntimeError(
        "ACP_BACKEND_UNAVAILABLE",
        "primary backend unavailable",
      ),
    });
    harness.fallbackRuntime.close.mockRejectedValueOnce(new Error("fallback close result lost"));
    const input = {
      cfg: harness.cfg,
      sessionKey: harness.sessionKey,
      provenance: "system" as const,
      text: "continue",
      mode: "prompt" as const,
      requestId: "uncertain-fallback",
    };
    await expect(new AcpSessionManager().runTurn(input)).rejects.toThrow(
      "fallback close result lost",
    );
    expect(harness.selection.executor.backend).toBe("primary-backend");
    expect(harness.currentMeta.runtimeSessionName).toBe("primary-runtime");
    await expect(
      new AcpSessionManager().runTurn({ ...input, requestId: "after-restart" }),
    ).rejects.toThrow("app did not confirm the last change");
    expect(harness.fallbackRuntime.runTurn).toHaveBeenCalledOnce();
  });

  it.each(["acquisition", "model control"] as const)(
    "keeps a rejected fallback %s fenced after restart",
    async (operation) => {
      const harness = setupFailoverBackends({
        model: "qa-model",
        primaryUnavailableError: new AcpRuntimeError(
          "ACP_BACKEND_UNAVAILABLE",
          "primary backend unavailable",
        ),
      });
      const failure = new Error(`${operation} result lost`);
      if (operation === "acquisition") {
        harness.fallbackRuntime.ensureSession.mockRejectedValueOnce(failure);
      } else {
        harness.fallbackRuntime.setConfigOption.mockRejectedValueOnce(failure);
      }
      const input = {
        cfg: harness.cfg,
        sessionKey: harness.sessionKey,
        provenance: "system" as const,
        text: "continue",
        mode: "prompt" as const,
        requestId: "uncertain-fallback",
      };
      await expect(new AcpSessionManager().runTurn(input)).rejects.toThrow(failure.message);
      if (operation === "model control") {
        expect(harness.fallbackRuntime.close).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "turn-local-fallback-complete" }),
        );
      } else {
        expect(harness.fallbackRuntime.close).not.toHaveBeenCalled();
      }
      await expect(
        new AcpSessionManager().runTurn({ ...input, requestId: "after-uncertain-operation" }),
      ).rejects.toThrow("app did not confirm the last change");
      expect(harness.fallbackRuntime.runTurn).not.toHaveBeenCalled();
      expect(harness.selection.executor.backend).toBe("primary-backend");
    },
  );

  it("does not overlap unresolved fallback timeout cleanup with another close", async () => {
    vi.useFakeTimers();
    const harness = setupFailoverBackends({
      primaryUnavailableError: new AcpRuntimeError(
        "ACP_BACKEND_UNAVAILABLE",
        "primary backend unavailable",
      ),
    });
    const entered = createDeferred();
    const releaseTurn = createDeferred();
    const releaseCancel = createDeferred();
    harness.fallbackRuntime.runTurn.mockImplementation(async function* () {
      entered.resolve();
      await releaseTurn.promise;
      yield { type: "done" };
    });
    harness.fallbackRuntime.cancel.mockImplementation(async () => await releaseCancel.promise);
    const input = {
      cfg: { ...harness.cfg, agents: { defaults: { timeoutSeconds: 1 } } },
      sessionKey: harness.sessionKey,
      provenance: "system" as const,
      text: "continue",
      mode: "prompt" as const,
      requestId: "fallback-timeout",
    };
    try {
      const turn = new AcpSessionManager().runTurn(input);
      const settled = Promise.allSettled([turn]);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(4_001);
      expect((await settled)[0]).toMatchObject({
        status: "rejected",
        reason: {
          code: "ACP_TURN_FAILED",
          detailCode: "TURN_TIMEOUT",
          message:
            "All ACP backends failed (2): primary-backend: primary backend unavailable | fallback-backend: ACP turn timed out after 1s.",
        },
      });
      expect(harness.fallbackRuntime.cancel).toHaveBeenCalledOnce();
      expect(harness.fallbackRuntime.close).not.toHaveBeenCalled();
      await expect(
        new AcpSessionManager().runTurn({ ...input, requestId: "after-timeout" }),
      ).rejects.toThrow("app did not confirm the last change");
      expect(harness.fallbackRuntime.runTurn).toHaveBeenCalledOnce();
    } finally {
      releaseTurn.resolve();
      releaseCancel.resolve();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it("closes the previous persistent handle before switching fallback backends", async () => {
    const harness = setupFailoverBackends();
    harness.primaryRuntime.runTurn.mockImplementation(failBeforeOutput());

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: harness.cfg,
        sessionKey: harness.sessionKey,
        text: "fallback",
        mode: "prompt",
        requestId: "r-fallback",
      }),
    ).resolves.toBeUndefined();

    expect(harness.primaryRuntime.close).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "backend-failover",
      }),
    );
    expect(harness.fallbackRuntime.runTurn).toHaveBeenCalledTimes(1);
  });

  it("fails over when the primary backend is registered but unavailable", async () => {
    const harness = setupFailoverBackends({
      primaryUnavailableError: new AcpRuntimeError(
        "ACP_BACKEND_UNAVAILABLE",
        "primary backend unavailable",
      ),
    });

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: harness.cfg,
        sessionKey: harness.sessionKey,
        text: "fallback",
        mode: "prompt",
        requestId: "r-unavailable",
      }),
    ).resolves.toBeUndefined();

    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledWith("primary-backend");
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledWith("fallback-backend");
    expect(harness.fallbackRuntime.runTurn).toHaveBeenCalledTimes(1);
  });

  it("fails over for common rate limit wording before output", async () => {
    const harness = setupFailoverBackends();
    harness.primaryRuntime.runTurn.mockImplementation(failBeforeOutput("rate limit exceeded"));

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: harness.cfg,
        sessionKey: harness.sessionKey,
        text: "fallback",
        mode: "prompt",
        requestId: "r-rate-limit",
      }),
    ).resolves.toBeUndefined();

    expect(harness.primaryRuntime.runTurn).toHaveBeenCalledTimes(1);
    expect(harness.fallbackRuntime.runTurn).toHaveBeenCalledTimes(1);
  });

  it("does not fail over after prompt submission even when no output was emitted", async () => {
    const harness = setupFailoverBackends();
    const startTurn = vi.fn<NonNullable<typeof harness.primaryRuntime.runtime.startTurn>>(
      (input) => ({
        requestId: input.requestId,
        promptStarted: Promise.resolve(),
        events: (async function* () {})(),
        result: Promise.resolve({
          status: "failed" as const,
          error: { code: "ACP_TURN_FAILED", message: "backend unavailable" },
        }),
        cancel: vi.fn(async () => {}),
        closeStream: vi.fn(async () => {}),
      }),
    );
    harness.primaryRuntime.runtime.startTurn = startTurn;

    await expect(
      new AcpSessionManager().runTurn({
        provenance: "system",
        cfg: harness.cfg,
        sessionKey: harness.sessionKey,
        text: "do not replay submitted prompt",
        mode: "prompt",
        requestId: "r-submitted-no-failover",
      }),
    ).rejects.toMatchObject({ code: "ACP_TURN_FAILED", message: "backend unavailable" });

    expect(startTurn).toHaveBeenCalledOnce();
    expect(harness.fallbackRuntime.runTurn).not.toHaveBeenCalled();
  });

  it("fails over only after rejected prompt readiness reaches canonical terminal cleanup", async () => {
    const harness = setupFailoverBackends();
    const transitions: string[] = [];
    const readinessFailure = new Error("backend unavailable");
    const promptStarted = Promise.reject(readinessFailure);
    promptStarted.catch(() => {});
    harness.primaryRuntime.runtime.startTurn = vi.fn((input) => ({
      requestId: input.requestId,
      promptStarted,
      events: (async function* () {})(),
      result: Promise.resolve().then(() => {
        transitions.push("primary-cleaned-up");
        return {
          status: "failed" as const,
          error: { code: "ACP_TURN_FAILED", message: "backend unavailable" },
        };
      }),
      cancel: vi.fn(async () => {}),
      closeStream: vi.fn(async () => {}),
    }));
    harness.fallbackRuntime.runTurn.mockImplementation(async function* () {
      transitions.push("fallback-started");
      yield { type: "done" as const };
    });
    const lifecycleEvents: string[] = [];

    await new AcpSessionManager().runTurn({
      provenance: "system",
      cfg: harness.cfg,
      sessionKey: harness.sessionKey,
      text: "fail over an unsubmitted prompt",
      mode: "prompt",
      requestId: "r-unsubmitted-failover",
      onLifecycle: (event) => {
        lifecycleEvents.push(event.type);
      },
    });

    expect(transitions).toEqual(["primary-cleaned-up", "fallback-started"]);
    expect(lifecycleEvents).toEqual(["prompt_submitted"]);
    expect(harness.fallbackRuntime.runTurn).toHaveBeenCalledOnce();
  });

  it("does not fail over after a backend has emitted output", async () => {
    const harness = setupFailoverBackends();
    harness.primaryRuntime.runTurn.mockImplementation(async function* () {
      yield { type: "text_delta" as const, text: "partial" };
      throw new AcpRuntimeError("ACP_TURN_FAILED", "backend unavailable");
    });
    const events: unknown[] = [];

    const manager = new AcpSessionManager();
    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: harness.cfg,
        sessionKey: harness.sessionKey,
        text: "do not duplicate",
        mode: "prompt",
        requestId: "r-output",
        onEvent: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
    });

    expect(events).toEqual([expect.objectContaining({ type: "text_delta", text: "partial" })]);
    expect(harness.fallbackRuntime.runTurn).not.toHaveBeenCalled();
  });
});
