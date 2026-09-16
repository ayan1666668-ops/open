// Tests queue state storage, dedupe, and cleanup primitives.
import { afterEach, describe, expect, it } from "vitest";
import { enqueueFollowupRun } from "./enqueue.js";
import {
  clearFollowupQueue,
  getFollowupQueue,
  hasPendingFollowupQueueWork,
  refreshQueuedFollowupSession,
} from "./state.js";
import type { FollowupRun } from "./types.js";

const QUEUE_KEY = "agent:main:dm:test";

afterEach(() => {
  clearFollowupQueue(QUEUE_KEY);
});

function makeRun(): FollowupRun["run"] {
  return {
    agentId: "main",
    agentDir: "/tmp/agent",
    sessionId: "session-1",
    sessionKey: QUEUE_KEY,
    sessionFile: "/tmp/session-1.jsonl",
    workspaceDir: "/tmp/workspace",
    config: {} as FollowupRun["run"]["config"],
    executionSelection: {
      model: { provider: "anthropic", id: "claude-opus-4-6" },
      executor: { kind: "harness", id: "openclaw" },
    },

    authProfileId: "profile-a",
    authProfileIdSource: "user",
    timeoutMs: 30_000,
    blockReplyBreak: "message_end",
  };
}

describe("refreshQueuedFollowupSession", () => {
  it("retargets queued runs to the persisted selection", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    const lastRun = makeRun();
    const queuedRun: FollowupRun = {
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    const summarizedRun: FollowupRun = {
      prompt: "summarized message",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    queue.lastRun = lastRun;
    queue.items.push(queuedRun);
    queue.summarySources.push(summarizedRun);
    queue.summaryElisions.push({
      contextKey: "context",
      count: 2,
      sources: [
        {
          prompt: "elided summary",
          enqueuedAt: Date.now(),
          run: makeRun(),
        },
      ],
      summaryLines: ["elided summary"],
      sourceRefs: new WeakMap(),
    });

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextSelection: {
        model: { provider: "openai", id: "gpt-4o" },
        executor: { kind: "harness", id: "openclaw" },
      },

      nextAuthProfileId: undefined,
      nextAuthProfileIdSource: undefined,
    });

    expect(queue.lastRun).toEqual({
      ...makeRun(),
      executionSelection: {
        model: { provider: "openai", id: "gpt-4o" },
        executor: { kind: "harness", id: "openclaw" },
      },

      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(queue.items[0]?.run).toEqual({
      ...makeRun(),
      executionSelection: {
        model: { provider: "openai", id: "gpt-4o" },
        executor: { kind: "harness", id: "openclaw" },
      },

      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(queue.summarySources[0]?.run).toEqual({
      ...makeRun(),
      executionSelection: {
        model: { provider: "openai", id: "gpt-4o" },
        executor: { kind: "harness", id: "openclaw" },
      },

      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(queue.summaryElisions[0]?.sources[0]?.run).toEqual({
      ...makeRun(),
      executionSelection: {
        model: { provider: "openai", id: "gpt-4o" },
        executor: { kind: "harness", id: "openclaw" },
      },

      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("retargets queued runs with the complete accepted pair", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    const queuedRun: FollowupRun = {
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: { ...makeRun() },
    };
    queue.items.push(queuedRun);

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextSelection: {
        model: { provider: "ollama", id: "qwen3.5:27b" },
        executor: { kind: "harness", id: "openclaw" },
      },
    });

    expect(queue.items[0]?.run).toEqual({
      ...makeRun(),
      executionSelection: {
        model: { provider: "ollama", id: "qwen3.5:27b" },
        executor: { kind: "harness", id: "openclaw" },
      },
    });
  });

  it("replaces the reset pair without copying fallback authorization into the queue", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.items.push({
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: {
        ...makeRun(),
        executionSelection: {
          model: { provider: "fixture", id: "previous" },
          executor: { kind: "harness", id: "another-app" },
        },
      },
    });

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextSelection: {
        model: { provider: "anthropic", id: "claude-opus-4-6" },
        executor: { kind: "harness", id: "openclaw" },
      },
    });

    expect(queue.items[0]?.run?.executionSelection).toEqual(makeRun().executionSelection);
    expect(queue.items[0]?.run).not.toHaveProperty("modelOverrideSource");
  });

  it("clamps queued Sol Ultra work to Codex Luna Max", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.items.push({
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: {
        ...makeRun(),
        executionSelection: {
          model: { provider: "openai", id: "gpt-5.6-sol" },
          executor: { kind: "harness", id: "openclaw" },
        },

        thinkLevel: "ultra",
      },
    });

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextSelection: {
        model: { provider: "openai", id: "gpt-5.6-luna" },
        executor: { kind: "harness", id: "codex" },
      },

      nextThinking: {
        level: "ultra",
        catalog: [{ provider: "openai", id: "gpt-5.6-luna", name: "Luna", reasoning: true }],
      },
    });

    expect(queue.items[0]?.run).toMatchObject({
      executionSelection: { model: { provider: "openai", id: "gpt-5.6-luna" } },

      thinkLevel: "max",
      thinkingCatalog: [{ provider: "openai", id: "gpt-5.6-luna", name: "Luna", reasoning: true }],
    });
  });

  it("uses the highest supported non-max level when retargeting queued work", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.items.push({
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: { ...makeRun(), thinkLevel: "ultra" },
    });

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextSelection: {
        model: { provider: "custom", id: "reasoner" },
        executor: { kind: "harness", id: "openclaw" },
      },

      nextThinking: { level: "ultra" },
    });

    expect(queue.items[0]?.run.thinkLevel).toBe("high");
  });

  it.each([
    {
      source: "turn",
      current: "high",
      stored: "off",
      model: "gpt-5.6-sol",
      reasoning: true,
      expected: "high",
    },
    {
      source: "turn",
      current: "off",
      stored: "high",
      model: "gpt-5.6-sol",
      reasoning: true,
      expected: "low",
    },
    {
      source: "default",
      current: "high",
      stored: "high",
      model: "gpt-5.6-sol",
      reasoning: true,
      expected: "medium",
    },
    {
      source: undefined,
      current: "high",
      stored: "low",
      model: "gpt-5.6-sol",
      reasoning: true,
      expected: "low",
    },
    {
      source: "turn",
      current: "ultra",
      stored: "off",
      model: "gpt-5.6-luna",
      reasoning: true,
      expected: "max",
    },
    {
      source: "turn",
      current: "high",
      stored: "off",
      model: "non-reasoner",
      reasoning: false,
      expected: "off",
    },
  ] as const)(
    "retargets $source thinking $current with stored $stored to $model as $expected",
    ({ source, current, stored, model, reasoning, expected }) => {
      const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
      const runs = Array.from({ length: 4 }, () => ({
        ...makeRun(),
        thinkLevel: current,
        thinkLevelOverride: source === "turn" ? current : source,
      }));
      const wrap = (run: FollowupRun["run"]): FollowupRun => ({
        prompt: "queued",
        enqueuedAt: Date.now(),
        run,
      });
      queue.lastRun = runs[0];
      queue.items.push(wrap(runs[1]!));
      queue.summarySources.push(wrap(runs[2]!));
      queue.summaryElisions.push({
        contextKey: "elided",
        count: 1,
        sources: [wrap(runs[3]!)],
        summaryLines: ["queued"],
        sourceRefs: new WeakMap(),
      });
      refreshQueuedFollowupSession({
        key: QUEUE_KEY,
        nextSelection: {
          model: { provider: "openai", id: model },
          executor: { kind: "harness", id: "codex" },
        },

        nextThinking: {
          level: stored,
          catalog: [{ provider: "openai", id: model, name: model, reasoning }],
        },
      });
      expect(runs.map((run) => run.thinkLevel)).toEqual(Array(4).fill(expected));
      expect(runs.map((run) => run.thinkLevelOverride)).toEqual(
        Array(4).fill(source === "turn" ? current : source),
      );
    },
  );

  it.each([
    { requested: "high", stored: "low", expected: ["high", "off", "high"] },
    { requested: "off", stored: "high", expected: ["low", "off", "low"] },
    { requested: "default", stored: "off", expected: ["high", "off", "low"] },
    { requested: undefined, stored: "low", expected: ["low", "off", "low"] },
  ] as const)(
    "retains requested thinking $requested across repeated queued model switches",
    ({ requested, stored, expected }) => {
      const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
      const run: FollowupRun["run"] = {
        ...makeRun(),
        config: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.6-sol": { params: { thinking: "high" } },
                "openai/gpt-5.6-luna": { params: { thinking: "low" } },
              },
            },
          },
        },
        thinkLevel: "high",
        thinkLevelOverride: requested,
      };
      queue.items.push({ prompt: "task", enqueuedAt: Date.now(), run });
      for (const [index, model] of ["gpt-5.6-sol", "non-reasoner", "gpt-5.6-luna"].entries()) {
        refreshQueuedFollowupSession({
          key: QUEUE_KEY,
          nextSelection: {
            model: { provider: "openai", id: model },
            executor: { kind: "harness", id: "codex" },
          },

          nextThinking: {
            level: stored,
            catalog: [{ provider: "openai", id: model, name: model, reasoning: index !== 1 }],
          },
        });
        expect(run.thinkLevel).toBe(expected[index]);
        expect(run.thinkLevelOverride).toBe(requested);
      }
    },
  );

  describe.each(["default", undefined] as const)("thinking source %s", (source) => {
    it.each<{ name: string; config: FollowupRun["run"]["config"]; expected: string }>([
      {
        name: "agent",
        config: {
          agents: {
            entries: { main: { thinkingDefault: "low" } },
            defaults: {
              thinkingDefault: "off",
              models: { "openai/gpt-5.6-sol": { params: { thinking: "high" } } },
            },
          },
        },
        expected: "low",
      },
      {
        name: "agent model",
        config: {
          agents: {
            entries: {
              main: {
                models: { "openai/gpt-5.6-sol": { params: { thinking: "low" } } },
              },
            },
            defaults: {
              models: { "openai/gpt-5.6-sol": { params: { thinking: "high" } } },
            },
          },
        },
        expected: "low",
      },
      {
        name: "model",
        config: {
          agents: {
            defaults: {
              thinkingDefault: "off",
              models: { "openai/gpt-5.6-sol": { params: { thinking: "high" } } },
            },
          },
        },
        expected: "high",
      },
      {
        name: "global",
        config: { agents: { defaults: { thinkingDefault: "high" } } },
        expected: "high",
      },
    ])("honors the configured $name default when retargeting", ({ config, expected }) => {
      const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
      const run: FollowupRun["run"] = {
        ...makeRun(),
        config,
        thinkLevel: "medium",
        thinkLevelOverride: source,
      };
      queue.items.push({ prompt: "task", enqueuedAt: Date.now(), run });
      refreshQueuedFollowupSession({
        key: QUEUE_KEY,
        nextSelection: {
          model: { provider: "openai", id: "gpt-5.6-sol" },
          executor: { kind: "harness", id: "codex" },
        },

        nextThinking: {
          level: source === "default" ? "off" : undefined,
          catalog: [{ provider: "openai", id: "gpt-5.6-sol", name: "Sol", reasoning: true }],
        },
      });
      expect(run.thinkLevel).toBe(expected);
    });
  });

  it("recomputes the retargeted model default when the session has no thinking override", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.items.push({
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: { ...makeRun(), thinkLevel: "ultra" },
    });

    refreshQueuedFollowupSession({
      key: QUEUE_KEY,
      nextSelection: {
        model: { provider: "openai", id: "gpt-5.6-sol" },
        executor: { kind: "harness", id: "codex" },
      },

      nextThinking: {},
    });

    // Sol's provider default reasoning level is medium (extensions/openai
    // thinking-policy.ts); retargeting without an override adopts it.
    expect(queue.items[0]?.run.thinkLevel).toBe("medium");
  });
});

describe("getFollowupQueue", () => {
  it("aborts work owned by a cleared queue", () => {
    const queuedRun: FollowupRun = {
      prompt: "queued message",
      enqueuedAt: Date.now(),
      run: makeRun(),
    };
    enqueueFollowupRun(QUEUE_KEY, queuedRun, { mode: "followup" });

    expect(queuedRun.queueAbortSignal?.aborted).toBe(false);
    clearFollowupQueue(QUEUE_KEY);
    expect(queuedRun.queueAbortSignal?.aborted).toBe(true);
  });

  it("trims overflow metadata when a live queue cap shrinks", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 3 });
    for (const [contextKey, count] of [
      ["oldest", 2],
      ["middle", 3],
      ["newest", 4],
    ] as const) {
      queue.summaryElisions.push({
        contextKey,
        count,
        sources: Array.from({ length: count }, () => ({
          prompt: contextKey,
          enqueuedAt: Date.now(),
          run: makeRun(),
        })),
        summaryLines: Array.from({ length: count }, () => contextKey),
        sourceRefs: new WeakMap(),
      });
    }
    queue.evictedSummaryCount = 5;

    const updated = getFollowupQueue(QUEUE_KEY, { mode: "followup", cap: 1 });

    expect(updated.summaryElisions.map((entry) => entry.contextKey)).toEqual(["newest"]);
    expect(updated.summaryElisions[0]?.sources).toHaveLength(1);
    expect(updated.summaryElisions[0]?.summaryLines).toEqual(["newest"]);
    expect(updated.evictedSummaryCount).toBe(13);
  });
});

describe("hasPendingFollowupQueueWork", () => {
  it("detects each actionable queued-work representation", () => {
    const cases = [
      (queue: ReturnType<typeof getFollowupQueue>) => {
        queue.items.push({
          prompt: "queued message",
          enqueuedAt: Date.now(),
          run: makeRun(),
        });
      },
      (queue: ReturnType<typeof getFollowupQueue>) => {
        queue.inFlight.add({
          prompt: "in-flight collected message",
          enqueuedAt: Date.now(),
          run: makeRun(),
        });
      },
      (queue: ReturnType<typeof getFollowupQueue>) => {
        queue.droppedCount = 1;
      },
    ];

    for (const populate of cases) {
      const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
      populate(queue);
      expect(hasPendingFollowupQueueWork(["", ` ${QUEUE_KEY} `, QUEUE_KEY])).toBe(true);
      clearFollowupQueue(QUEUE_KEY);
    }
  });

  it("ignores empty queues and historical eviction accounting", () => {
    const queue = getFollowupQueue(QUEUE_KEY, { mode: "followup" });
    queue.evictedSummaryCount = 3;

    expect(hasPendingFollowupQueueWork([undefined, "", QUEUE_KEY])).toBe(false);
  });
});
