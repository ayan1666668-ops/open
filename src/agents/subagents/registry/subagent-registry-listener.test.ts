import { describe, expect, it, vi } from "vitest";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { createSubagentRegistryListener } from "./subagent-registry-listener.js";
import { createPendingLifecycleScheduler } from "./subagent-registry-pending-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

describe("subagent lifecycle event ownership", () => {
  it.each(["paused", "pending generations", "retired predecessor"] as const)(
    "does not transfer completion ownership through a session key: %s",
    async (state) => {
      const childSessionKey = "agent:main:subagent:owned-result";
      const original = createSubagentRunRecord({
        runId: "original-run",
        childSessionKey,
        generation: 1,
        endedAt: 100,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
        completion: { required: true, resultText: "original result", capturedAt: 100 },
      });
      const runs = new Map<string, SubagentRunRecord>([[original.runId, original]]);
      if (state === "paused") {
        original.pauseReason = "sessions_yield";
        original.completion = { required: true };
      } else {
        const successor = createSubagentRunRecord({
          ...original,
          runId: "successor-run",
          generation: 2,
          completion: { required: true, resultText: "successor result", capturedAt: 200 },
        });
        runs.set(successor.runId, successor);
        if (state === "retired predecessor") {
          runs.delete(original.runId);
        }
      }
      const before = structuredClone([...runs]);
      const callbacks: Array<(event: AgentEventPayload) => void> = [];
      const persist = vi.fn();
      const complete = vi.fn(async () => {});
      const warn = vi.fn();
      const scheduler = createPendingLifecycleScheduler({
        runs,
        completeInBackground: vi.fn(),
      });
      const listener = createSubagentRegistryListener({
        runs,
        pendingLifecycle: scheduler,
        onAgentEvent: (callback) => {
          callbacks.push(callback);
          return () => {};
        },
        persist,
        completeSubagentRunWithRecovery: complete,
        warn,
      });
      listener.ensure();
      const onEvent = callbacks[0];
      if (!onEvent) {
        throw new Error("Expected the registry lifecycle listener");
      }
      onEvent({
        runId: state === "retired predecessor" ? original.runId : "unadmitted-followup",
        sessionKey: childSessionKey,
        seq: 1,
        ts: 300,
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: 300,
          terminalReply: { disposition: "visible", text: "unowned later answer" },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      listener.reset();
      scheduler.clearAll();

      expect([...runs]).toEqual(before);
      expect(complete).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );
});
