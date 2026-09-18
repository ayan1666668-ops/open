/** Tests foreground budget ownership across optional embedded maintenance. */
import { randomUUID } from "node:crypto";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { createAbortError } from "../infra/abort-signal.js";
import {
  agentCommand,
  compactionTestRuntime,
  compactionTestState as state,
  findCompactionSessionEntry as findStoredSessionEntry,
  makeCompactionResult as makeResult,
  readCompactionLifecyclePhases as readLifecyclePhases,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath as requireStorePath,
} from "./agent-command.compaction.test-support.js";
import type { RunEmbeddedAgentInternalParams } from "./embedded-agent-runner/run/internal-params.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent.js";
import { waitForSessionMaintenance } from "./session-maintenance/coordinator.js";

const { replaceSessionEntry } = compactionTestRuntime;

registerAgentCommandCompactionTestHooks();

describe("agentCommand maintenance budget", () => {
  it("keeps the completed foreground budget when maintenance invokes a retired callback", async () => {
    const sessionId = "foreground-compaction-budget";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const foreground = {
      contextWindow: 32_768,
      reserveTokens: 8_192,
      fixedTokens: 4_000,
      pendingTokens: 100,
    };
    let retiredObserver: RunEmbeddedAgentInternalParams["onCompactionRequestBudget"];
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      params.onSuccessfulAuthProfile?.({});
      retiredObserver = params.onCompactionRequestBudget;
      retiredObserver?.(foreground);
      return makeResult({
        sessionId,
        text: "done",
        runner: "embedded",
        agentHarnessId: "openclaw",
      });
    });
    state.runMemoryFlushIfNeededMock.mockImplementationOnce(async (params) => {
      retiredObserver?.({
        contextWindow: 200_000,
        reserveTokens: 20_000,
        fixedTokens: 10,
        pendingTokens: 0,
      });
      return { sessionEntry: params.sessionEntry, outcome: "completed" };
    });

    await agentCommand({ message: "continue", sessionId, sessionKey });
    await waitForSessionMaintenance(sessionKey);

    expect(state.runSessionCompactionIfNeededMock).toHaveBeenCalledWith(
      expect.objectContaining({ compactionRequestBudget: { ...foreground, pendingTokens: 0 } }),
    );
    expect(foreground.pendingTokens).toBe(100);
  });

  it.each([462_153, 600_000])(
    "shares the command allowance after %i ms of foreground work",
    async (foregroundMs) => {
      const startedAt = Date.now();
      let now = startedAt;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const sessionId = `maintenance-budget-${foregroundMs}`;
      const sessionKey = `agent:main:explicit:${sessionId}`;
      const text = "completed foreground answer";
      let flushTimeout: number | undefined;
      state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
        params.onSuccessfulAuthProfile?.({});
        now += foregroundMs;
        return makeResult({ sessionId, text, runner: "embedded", agentHarnessId: "openclaw" });
      });
      state.runMemoryFlushIfNeededMock.mockImplementationOnce(async (params) => {
        flushTimeout = params.followupRun.run.timeoutMs;
        now = startedAt + 600_000;
        return { sessionEntry: params.sessionEntry, outcome: "completed" };
      });
      try {
        await agentCommand({ message: "continue", sessionId, sessionKey, timeout: "600" });
        await waitForSessionMaintenance(sessionKey);
        expect(state.runMemoryFlushIfNeededMock).toHaveBeenCalledTimes(
          foregroundMs < 600_000 ? 1 : 0,
        );
        expect(flushTimeout).toBe(foregroundMs < 600_000 ? 600_000 - foregroundMs : undefined);
        expect(state.runSessionCompactionIfNeededMock).not.toHaveBeenCalled();
        expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
          expect.objectContaining({ payloads: [{ text }] }),
        );
        expect(readLifecyclePhases()).toContain("end");
        expect(readLifecyclePhases()).not.toContain("error");
      } finally {
        await waitForSessionMaintenance(sessionKey);
        clock.mockRestore();
      }
    },
  );

  it("drains expired maintenance without changing the completed reply", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const sessionId = "maintenance-expiry";
    const successorSessionId = "maintenance-expiry-successor";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const storePath = requireStorePath();
    const text = "answer survives maintenance expiry";
    const caller = new AbortController();
    let flushTimeout: number | undefined;
    let compactionTimeout: number | undefined;
    let maintenanceSignal: AbortSignal | undefined;
    let cleanupFinished = false;
    const onSessionIdChanged = vi.fn();
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      params.onSuccessfulAuthProfile?.({});
      await vi.advanceTimersByTimeAsync(400);
      return makeResult({ sessionId, text, runner: "embedded", agentHarnessId: "openclaw" });
    });
    state.runMemoryFlushIfNeededMock.mockImplementationOnce(async (params) => {
      flushTimeout = params.followupRun.run.timeoutMs;
      await vi.advanceTimersByTimeAsync(200);
      return { sessionEntry: params.sessionEntry, outcome: "completed" };
    });
    state.runSessionCompactionIfNeededMock.mockImplementationOnce(async (params) => {
      compactionTimeout = params.followupRun.run.timeoutMs;
      maintenanceSignal = params.abortSignal;
      const successor = {
        ...params.sessionEntry,
        sessionId: successorSessionId,
        lifecycleRevision: randomUUID(),
        compactionCount: (params.sessionEntry?.compactionCount ?? 0) + 1,
        updatedAt: Date.now(),
      };
      await replaceSessionEntry({ sessionKey, storePath }, successor);
      if (params.sessionStore) {
        params.sessionStore[sessionKey] = successor;
      }
      params.onCompactionCommitted?.({
        sessionId: successorSessionId,
        sessionFile: sessionKey,
        sessionTarget: { agentId: "main", sessionId: successorSessionId, sessionKey, storePath },
        entry: successor,
        previousSessionId: sessionId,
      });
      try {
        await vi.advanceTimersByTimeAsync(400);
        maintenanceSignal?.throwIfAborted();
        return successor;
      } finally {
        await Promise.resolve();
        cleanupFinished = true;
      }
    });
    state.deliverAgentCommandResultMock.mockImplementationOnce(
      async (params: { result: EmbeddedAgentRunResult }) => ({
        ...params.result,
        deliverySucceeded: true,
      }),
    );
    try {
      const result = await agentCommand({
        message: "continue",
        sessionId,
        sessionKey,
        timeout: "1",
        abortSignal: caller.signal,
        onSessionIdChanged,
      });
      expect(result).toMatchObject({
        meta: { agentMeta: { sessionId } },
      });
      await waitForSessionMaintenance(sessionKey);
      expect(flushTimeout).toBe(600);
      expect(compactionTimeout).toBe(400);
      expect(maintenanceSignal?.aborted).toBe(true);
      expect(maintenanceSignal?.reason).toMatchObject({ name: "AbortError" });
      expect(caller.signal.aborted).toBe(false);
      expect(cleanupFinished).toBe(true);
      expect(findStoredSessionEntry(sessionKey)?.sessionId).toBe(successorSessionId);
      expect(onSessionIdChanged).not.toHaveBeenCalled();
      expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
        expect.objectContaining({
          payloads: [{ text }],
          sessionEntry: expect.objectContaining({ sessionId }),
        }),
      );
      expect(readLifecyclePhases()).toContain("end");
      expect(readLifecyclePhases()).not.toContain("error");
    } finally {
      await waitForSessionMaintenance(sessionKey);
      vi.useRealTimers();
    }
  });

  it("preserves delivery when the caller aborts after foreground completion", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const sessionId = "maintenance-expiry-then-caller-abort";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const caller = new AbortController();
    let maintenanceExpired = false;
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      params.onSuccessfulAuthProfile?.({});
      await vi.advanceTimersByTimeAsync(400);
      return makeResult({
        sessionId,
        text: "cancelled foreground answer",
        runner: "embedded",
        agentHarnessId: "openclaw",
      });
    });
    state.runMemoryFlushIfNeededMock.mockImplementationOnce(async (params) => {
      await vi.advanceTimersByTimeAsync(600);
      maintenanceExpired = params.abortSignal?.aborted === true;
      caller.abort(createAbortError("caller cancelled during flush"));
      return { sessionEntry: params.sessionEntry, outcome: "failed" };
    });
    try {
      await agentCommand({
        message: "continue",
        sessionId,
        sessionKey,
        timeout: "1",
        abortSignal: caller.signal,
      });
      await waitForSessionMaintenance(sessionKey);
      expect(maintenanceExpired).toBe(true);
      expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
      expect(readLifecyclePhases()).toContain("end");
      expect(state.runSessionCompactionIfNeededMock).not.toHaveBeenCalled();
      expect(findStoredSessionEntry(sessionKey)?.pendingFinalDelivery).toBeUndefined();
    } finally {
      await waitForSessionMaintenance(sessionKey);
      vi.useRealTimers();
    }
  });

  it("preserves unlimited command maintenance after a long foreground turn", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const sessionId = "maintenance-unlimited";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    let flushTimeout: number | undefined;
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      params.onSuccessfulAuthProfile?.({});
      now += 1_200_000;
      return makeResult({
        sessionId,
        text: "unlimited answer",
        runner: "embedded",
        agentHarnessId: "openclaw",
      });
    });
    state.runMemoryFlushIfNeededMock.mockImplementationOnce(async (params) => {
      flushTimeout = params.followupRun.run.timeoutMs;
      now += 600_000;
      return { sessionEntry: params.sessionEntry, outcome: "completed" };
    });
    try {
      await agentCommand({ message: "continue", sessionId, sessionKey, timeout: "0" });
      await waitForSessionMaintenance(sessionKey);
      expect(flushTimeout).toBe(MAX_TIMER_TIMEOUT_MS);
      expect(state.runSessionCompactionIfNeededMock).toHaveBeenCalledWith(
        expect.objectContaining({
          followupRun: expect.objectContaining({
            run: expect.objectContaining({ timeoutMs: MAX_TIMER_TIMEOUT_MS }),
          }),
        }),
      );
      expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
    } finally {
      await waitForSessionMaintenance(sessionKey);
      clock.mockRestore();
    }
  });
});
