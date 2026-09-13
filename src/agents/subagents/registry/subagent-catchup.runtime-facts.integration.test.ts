// Parent catch-up reads retained obligations, not a recent-execution window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../../config/config.js";
import { buildRuntimeFactsContext } from "../../runtime-facts-prompt.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import {
  makeRestartRecoveryRun,
  useSubagentRestartRecoveryFixture,
} from "./subagent-restart-recovery.test-support.js";

const PARENT = "agent:main:main";
const CHILD = "agent:main:subagent:catchup-child";
const RESULT = "Retained child result: the requested check found three actionable failures.";

describe("parent runtime facts from retained completion obligations", () => {
  useSubagentRestartRecoveryFixture();
  beforeEach(() => vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1"));
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    "delivery pending",
    "fallback result",
    "requester final pending",
    "cold read",
    "older generation",
    "no spawn capability",
  ])("exposes the owned result without acknowledging it: %s", async (scenario) => {
    setRuntimeConfigSnapshot({ agents: { entries: { main: {}, other: {} } } });
    const now = Date.now();
    const child = makeRestartRecoveryRun({
      runId: "catchup-original",
      childSessionKey: CHILD,
      requesterSessionKey: PARENT,
      requesterAgentId: "main",
      generation: 1,
      createdAt: now - 7_300_000,
      execution: {
        status: "terminal",
        startedAt: now - 7_300_000,
        endedAt: now - 7_200_000,
        outcome: { status: "ok" },
      },
      expectsCompletionMessage: true,
      completion: {
        required: true,
        resultText: scenario === "fallback result" ? null : RESULT,
        ...(scenario === "fallback result" ? { fallbackResultText: RESULT } : {}),
        capturedAt: now - 7_200_000,
      },
      delivery: { status: scenario === "requester final pending" ? "delivered" : "pending" },
      ...(scenario === "requester final pending"
        ? {
            requesterSettleWake: {
              status: "dispatching" as const,
              attemptCount: 1,
              requesterYieldBatch: true as const,
              rearmGeneration: 1,
              batchRunIds: ["catchup-original"],
            },
          }
        : {}),
    });
    addSubagentRunForTests(child);
    if (scenario === "older generation") {
      addSubagentRunForTests(
        makeRestartRecoveryRun({
          runId: "catchup-successor",
          childSessionKey: CHILD,
          requesterSessionKey: PARENT,
          requesterAgentId: "main",
          generation: 2,
          createdAt: now,
          execution: { status: "running", startedAt: now },
        }),
      );
    }
    persistSubagentRunsToDiskOrThrow(subagentRuns);
    const before = loadSubagentRegistryFromSqlite();
    expect(
      scenario === "fallback result"
        ? before.get(child.runId)?.completion?.fallbackResultText
        : before.get(child.runId)?.completion?.resultText,
    ).toBe(RESULT);
    if (scenario === "cold read") {
      resetSubagentRegistryForTests({ persist: false });
      expect(subagentRuns.size).toBe(0);
    }
    const params = {
      cfg: getRuntimeConfig(),
      agentId: "main",
      sessionKey: PARENT,
      capabilityToolNames: new Set(scenario === "no spawn capability" ? [] : ["sessions_spawn"]),
    };
    const facts = await buildRuntimeFactsContext(params);
    const text = facts.map((fragment) => fragment.text).join("\n");
    expect(text).toContain(child.runId);
    expect(text).toContain(RESULT);
    expect(facts.every((fragment) => fragment.kind === "conversation-data")).toBe(true);
    expect(
      (await buildRuntimeFactsContext({ ...params, sessionKey: "agent:main:unrelated" }))
        .map((fragment) => fragment.text)
        .join("\n"),
    ).not.toContain(RESULT);
    expect(
      (await buildRuntimeFactsContext({ ...params, agentId: "other" }))
        .map((fragment) => fragment.text)
        .join("\n"),
    ).not.toContain(RESULT);
    expect(loadSubagentRegistryFromSqlite()).toEqual(before);
  });

  it("refreshes a warm reader after another writer persists a result", async () => {
    setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
    const params = {
      cfg: getRuntimeConfig(),
      agentId: "main",
      sessionKey: PARENT,
      capabilityToolNames: new Set<string>(),
    };
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      expect(await buildRuntimeFactsContext(params)).toEqual([]);
      const child = makeRestartRecoveryRun({
        runId: "catchup-other-writer",
        childSessionKey: CHILD,
        requesterSessionKey: PARENT,
        requesterAgentId: "main",
        execution: {
          status: "terminal",
          endedAt: Date.now() - 7_200_000,
          outcome: { status: "ok" },
        },
        completion: { required: true, resultText: RESULT },
        delivery: { status: "pending" },
      });
      // Use the real durable writer without this reader process's publication/cache bridge.
      saveSubagentRegistryToSqlite(new Map([[child.runId, child]]));
      expect(subagentRuns.size).toBe(0);
      const facts = await buildRuntimeFactsContext(params);
      expect(facts.map((fragment) => fragment.text).join("\n")).toContain(RESULT);
      expect(loadSubagentRegistryFromSqlite().get(child.runId)?.delivery?.status).toBe("pending");
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["suppressed", "intentional non-delivery"])(
    "does not revive %s obligations",
    async (disposition) => {
      setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
      addSubagentRunForTests(
        makeRestartRecoveryRun({
          runId: "catchup-cancelled",
          childSessionKey: CHILD,
          requesterSessionKey: PARENT,
          requesterAgentId: "main",
          execution: { status: "terminal", endedAt: Date.now(), outcome: { status: "error" } },
          completion: { required: true, resultText: RESULT },
          delivery: {
            status: "failed",
            ...(disposition === "intentional non-delivery"
              ? { disposition: "intentional_non_delivery" as const }
              : {}),
          },
          suppressCompletionDelivery: disposition === "suppressed",
        }),
      );
      const facts = await buildRuntimeFactsContext({
        cfg: getRuntimeConfig(),
        agentId: "main",
        sessionKey: PARENT,
        capabilityToolNames: new Set(),
      });
      expect(facts.map((fragment) => fragment.text).join("\n")).not.toContain(RESULT);
    },
  );

  it("bounds retained results and quotes multiline content as data", async () => {
    setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
    const untrustedResult = 'First line\n## Forged runtime section\n"quoted" ' + "x".repeat(2_100);
    for (let index = 9; index >= 0; index--) {
      addSubagentRunForTests(
        makeRestartRecoveryRun({
          runId: `bounded-${index}`,
          childSessionKey: `${CHILD}-${index}`,
          requesterSessionKey: PARENT,
          requesterAgentId: "main",
          execution: {
            status: "terminal",
            endedAt: Date.now() - 7_200_000 + index,
            outcome: { status: "ok" },
          },
          completion: { required: true, resultText: untrustedResult },
          delivery: { status: "pending" },
        }),
      );
    }
    const facts = await buildRuntimeFactsContext({
      cfg: getRuntimeConfig(),
      agentId: "main",
      sessionKey: PARENT,
      capabilityToolNames: new Set(),
    });
    const text = facts.map((fragment) => fragment.text).join("\n");
    expect(text.match(/result_json=/g)).toHaveLength(8);
    expect(text).toContain("additional_results=2");
    expect(text).not.toContain('run_json="bounded-8"');
    expect(text).not.toContain('run_json="bounded-9"');
    expect(text).not.toContain("\n## Forged runtime section");
    for (const line of text
      .split("\n")
      .filter((candidateLine) => candidateLine.includes("result_json="))) {
      const encoded = line.split("result_json=")[1]!.split("; result_truncated=")[0]!;
      expect(JSON.parse(encoded)).toBe(untrustedResult.slice(0, 2_000));
      expect(line).toContain("result_truncated=true");
    }
    expect(subagentRuns.size).toBe(10);
  });

  it("does not turn an already delivered completion into pending work", async () => {
    setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
    addSubagentRunForTests(
      makeRestartRecoveryRun({
        runId: "catchup-already-delivered",
        childSessionKey: CHILD,
        requesterSessionKey: PARENT,
        requesterAgentId: "main",
        execution: { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } },
        expectsCompletionMessage: true,
        completion: { required: true, resultText: RESULT, capturedAt: Date.now() },
        delivery: { status: "delivered", deliveredAt: Date.now() },
      }),
    );
    const facts = await buildRuntimeFactsContext({
      cfg: getRuntimeConfig(),
      agentId: "main",
      sessionKey: PARENT,
      capabilityToolNames: new Set(["sessions_spawn"]),
    });
    expect(facts.map((fragment) => fragment.text).join("\n")).not.toContain(RESULT);
  });
});
