import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildEmbeddedExtensionFactories } from "../embedded-agent-runner/extensions.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { jsonResult } from "../tools/common.js";
import {
  consumeCompactionSafeguardCancellation,
  getCompactionSafeguardRuntime,
  setCompactionSafeguardCancellation,
  setCompactionSafeguardRuntime,
} from "./compaction-safeguard-runtime.js";
import { testing } from "./compaction-safeguard.test-support.js";

const {
  collectToolFailures,
  computeAdaptiveChunkRatio,
  formatToolFailuresSection,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  resolveQualityGuardMaxRetries,
  resolveRecentTurnsPreserve,
} = testing;

describe("computeAdaptiveChunkRatio", () => {
  const contextWindow = 200_000;

  it("returns the base ratio for ordinary or empty messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(1000), timestamp: Date.now() },
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "y".repeat(1000) }],
        timestamp: Date.now(),
      }),
    ];
    expect(computeAdaptiveChunkRatio(messages, contextWindow)).toBe(BASE_CHUNK_RATIO);
    expect(computeAdaptiveChunkRatio([], contextWindow)).toBe(BASE_CHUNK_RATIO);
  });

  it("reduces the ratio for large messages without crossing its floor", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(50_000 * 4), timestamp: Date.now() },
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "y".repeat(50_000 * 4) }],
        timestamp: Date.now(),
      }),
    ];
    const ratio = computeAdaptiveChunkRatio(messages, contextWindow);
    expect(ratio).toBeLessThan(BASE_CHUNK_RATIO);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
  });

  it("respects the minimum ratio for one extremely large message", () => {
    const ratio = computeAdaptiveChunkRatio(
      [{ role: "user", content: "x".repeat(180_000 * 4), timestamp: Date.now() }],
      contextWindow,
    );
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
    expect(ratio).toBeLessThanOrEqual(BASE_CHUNK_RATIO);
  });
});

function toolResult(overrides: Partial<AgentMessage> & { toolCallId: string }): AgentMessage {
  return {
    role: "toolResult",
    toolName: "exec",
    isError: true,
    content: [],
    timestamp: Date.now(),
    ...overrides,
  } as AgentMessage;
}

describe("compaction-safeguard tool failures", () => {
  it("formats tool failures with metadata and summary", () => {
    const failures = collectToolFailures([
      toolResult({
        toolCallId: "call-1",
        details: { status: "failed", exitCode: 1 },
        content: [{ type: "text", text: "ENOENT: missing file" }],
      }),
      toolResult({
        toolCallId: "call-2",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "ok" }],
      }),
    ]);
    expect(failures).toHaveLength(1);
    expect(formatToolFailuresSection(failures)).toContain(
      "exec (status=failed exitCode=1): ENOENT: missing file",
    );
  });

  it("excludes accepted sessions_spawn results even when persisted with isError", () => {
    expect(
      collectToolFailures([
        toolResult({
          toolCallId: "accepted",
          toolName: "sessions_spawn",
          details: {
            status: "accepted",
            childSessionKey: "agent:watcher:subagent:abc",
            runId: "run-123",
            mode: "run",
          },
        }),
      ]),
    ).toHaveLength(0);
  });

  it("still reports sessions_spawn results that genuinely failed", () => {
    const failures = collectToolFailures([
      toolResult({ toolCallId: "error", toolName: "sessions_spawn", details: { status: "error" } }),
      toolResult({
        toolCallId: "forbidden",
        toolName: "sessions_spawn",
        details: { status: "forbidden" },
      }),
    ]);
    expect(failures.map((failure: { toolCallId: string }) => failure.toolCallId)).toEqual([
      "error",
      "forbidden",
    ]);
  });

  it("only excludes accepted spawns, not look-alike failures", () => {
    const acceptedDetails = jsonResult({
      status: "accepted",
      childSessionKey: "agent:watcher:subagent:abc",
      runId: "run-123",
      mode: "run",
    }).details;
    const failures = collectToolFailures([
      toolResult({
        toolCallId: "accepted",
        toolName: "sessions_spawn",
        details: acceptedDetails,
      }),
      toolResult({ toolCallId: "failed", details: { status: "failed", exitCode: 1 } }),
      toolResult({ toolCallId: "lookalike", toolName: "other", details: acceptedDetails }),
    ]);
    expect(failures.map((failure: { toolCallId: string }) => failure.toolCallId)).toEqual([
      "failed",
      "lookalike",
    ]);
  });

  it("dedupes by toolCallId and handles empty output", () => {
    const failures = collectToolFailures([
      toolResult({ toolCallId: "call-1", details: { exitCode: 2 } }),
      toolResult({
        toolCallId: "call-1",
        content: [{ type: "text", text: "ignored" }],
      }),
    ]);
    expect(failures).toHaveLength(1);
    expect(formatToolFailuresSection(failures)).toContain("exec (exitCode=2): failed");
  });

  it("keeps bounded failure text UTF-16 safe", () => {
    const failures = collectToolFailures([
      toolResult({
        toolCallId: "boundary",
        content: [{ type: "text", text: `${"x".repeat(236)}🚀tail` }],
      }),
    ]);
    expect(failures[0]?.summary).toBe(`${"x".repeat(236)}...`);
  });

  it("caps the number of failures and reports overflow", () => {
    const failures = collectToolFailures(
      Array.from({ length: 9 }, (_, index) =>
        toolResult({
          toolCallId: `call-${index}`,
          content: [{ type: "text", text: `error ${index}` }],
        }),
      ),
    );
    expect(formatToolFailuresSection(failures)).toContain("...and 1 more");
  });

  it("omits the section when there are no failures", () => {
    const failures = collectToolFailures([toolResult({ toolCallId: "ok", isError: false })]);
    expect(formatToolFailuresSection(failures)).toBe("");
  });
});

describe("compaction-safeguard runtime registry", () => {
  it("stores, isolates, clears, and ignores invalid manager identities", () => {
    const first = {};
    const second = {};
    setCompactionSafeguardRuntime(first, { maxHistoryShare: 0.3 });
    setCompactionSafeguardRuntime(second, { maxHistoryShare: 0.8 });
    expect(getCompactionSafeguardRuntime(first)).toEqual({ maxHistoryShare: 0.3 });
    expect(getCompactionSafeguardRuntime(second)).toEqual({ maxHistoryShare: 0.8 });
    expect(getCompactionSafeguardRuntime({})).toBeNull();
    setCompactionSafeguardRuntime(first, null);
    expect(getCompactionSafeguardRuntime(first)).toBeNull();
    setCompactionSafeguardRuntime(null, { maxHistoryShare: 0.5 });
    setCompactionSafeguardRuntime(undefined, { maxHistoryShare: 0.5 });
    expect(getCompactionSafeguardRuntime(null)).toBeNull();
    expect(getCompactionSafeguardRuntime(undefined)).toBeNull();
  });

  it("stores model, context window, and combined runtime values", () => {
    const manager = {};
    const model = { id: "fixture" } as NonNullable<
      ReturnType<typeof getCompactionSafeguardRuntime>
    >["model"];
    setCompactionSafeguardRuntime(manager, {
      maxHistoryShare: 0.6,
      contextWindowTokens: 200_000,
      model,
    });
    expect(getCompactionSafeguardRuntime(manager)).toEqual({
      maxHistoryShare: 0.6,
      contextWindowTokens: 200_000,
      model,
    });
  });

  it("consumes cancellation once without dropping runtime fields", () => {
    const manager = {};
    const error = Object.assign(new Error("provider unavailable"), { status: 503 });
    setCompactionSafeguardRuntime(manager, { maxHistoryShare: 0.6 });
    setCompactionSafeguardCancellation(manager, "summarization failed", error);
    expect(consumeCompactionSafeguardCancellation(manager)).toEqual({
      reason: "summarization failed",
      error: expect.objectContaining({ message: "provider unavailable", status: 503 }),
    });
    expect(consumeCompactionSafeguardCancellation(manager)).toBeNull();
    expect(getCompactionSafeguardRuntime(manager)).toEqual({ maxHistoryShare: 0.6 });
  });

  it("replaces or clears pending cancellation atomically", () => {
    const manager = {};
    setCompactionSafeguardCancellation(manager, "summary failed", new Error("timeout"));
    setCompactionSafeguardCancellation(manager, "quality guard declined");
    expect(consumeCompactionSafeguardCancellation(manager)).toEqual({
      reason: "quality guard declined",
    });
    setCompactionSafeguardCancellation(manager, "summary failed", new Error("timeout"));
    setCompactionSafeguardCancellation(manager, undefined);
    expect(consumeCompactionSafeguardCancellation(manager)).toBeNull();
    expect(getCompactionSafeguardRuntime(manager)).toBeNull();
  });

  it("wires oversized config values for runtime clamping", () => {
    const sessionManager = {} as Parameters<
      typeof buildEmbeddedExtensionFactories
    >[0]["sessionManager"];
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            recentTurnsPreserve: 99,
            qualityGuard: { maxRetries: 99 },
          },
        },
      },
    } as OpenClawConfig;
    buildEmbeddedExtensionFactories({
      cfg,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-3-opus",
      model: { contextWindow: 200_000 } as Parameters<
        typeof buildEmbeddedExtensionFactories
      >[0]["model"],
    });
    const runtime = getCompactionSafeguardRuntime(sessionManager);
    expect(runtime?.qualityGuardMaxRetries).toBe(99);
    expect(runtime?.recentTurnsPreserve).toBe(99);
    expect(resolveQualityGuardMaxRetries(runtime?.qualityGuardMaxRetries)).toBe(3);
    expect(resolveRecentTurnsPreserve(runtime?.recentTurnsPreserve)).toBe(12);
  });
});
