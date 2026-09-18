/** Shared status-summary cases for session runtime and context-window projection. */
import { describe, expect, it, vi } from "vitest";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import * as stateDatabaseCache from "../state/openclaw-state-db-cache.js";
import type * as StatusSummaryRuntimeModule from "../status/summary.runtime.js";
import { createSqliteWalHealth } from "./sqlite-wal-health.test-support.js";

type GetStatusSummary = typeof import("../status/summary.js").getStatusSummary;
type StatusSummaryRuntime = typeof StatusSummaryRuntimeModule.statusSummaryRuntime;
type SessionStore = Record<string, Record<string, unknown>>;

export function registerStatusSummaryWalCases(getSummary: GetStatusSummary): void {
  it.each([true, false])(
    "preserves WAL facts with includeSensitive=%s",
    async (includeSensitive) => {
      const error = "SYNTHETIC_PRIVATE_STORAGE_DETAIL";
      const sqliteWal = createSqliteWalHealth({
        state: "error",
        walBytes: 1024,
        databaseBytes: 4096,
        logFrames: null,
        checkpointedFrames: null,
        consecutiveBlocked: 0,
        error,
      });
      const observation = vi
        .spyOn(stateDatabaseCache, "readOpenClawStateWalHealth")
        .mockReturnValueOnce(sqliteWal);
      try {
        const summary = await getSummary({ includeSensitive });
        expect(summary.sqliteWal).toEqual({
          ...sqliteWal,
          error: includeSensitive ? error : undefined,
        });
        expect(JSON.stringify(summary).includes(error)).toBe(includeSensitive);
      } finally {
        observation.mockRestore();
      }
    },
  );
}

export function registerStatusSummarySessionRowCases(params: {
  getStatusSummary: () => ReturnType<GetStatusSummary>;
  getStatusSummaryRuntime: () => StatusSummaryRuntime;
  rejectProviderStaticModel: (error: Error) => void;
  setSessions: (store: SessionStore) => void;
}): void {
  describe("status summary session rows", () => {
    it("keeps status available when static catalog lookup fails", async () => {
      vi.mocked(
        params.getStatusSummaryRuntime().resolveConfiguredStatusModelRef,
      ).mockReturnValueOnce({
        provider: "broken-provider",
        model: "broken-model",
      });
      params.rejectProviderStaticModel(new Error("static catalog unavailable"));

      await expect(params.getStatusSummary()).resolves.toMatchObject({
        sessions: {
          defaults: {
            model: "broken-model",
            contextTokens: 200_000,
          },
        },
      });
    });

    it("includes the selected agent runtime on recent sessions", async () => {
      vi.mocked(params.getStatusSummaryRuntime().resolveSessionRuntime).mockReturnValue({
        id: "codex",
        label: "OpenAI Codex",
      });
      params.setSessions({
        "agent:main:main": {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      });

      const summary = await params.getStatusSummary();

      expect(summary.sessions.recent[0]?.runtime).toBe("OpenAI Codex");
    });

    it.each<{
      name: string;
      model: { id: string } | "native-managed";
      observed?: Partial<SessionEntry>;
      expectedModel: string | null;
      expectedContext: number | null;
    }>([
      {
        name: "opaque ACP model without runtime telemetry",
        model: { id: "openai/opaque-model" },
        expectedModel: "openai/opaque-model",
        expectedContext: null,
      },
      {
        name: "opaque ACP model with matching runtime telemetry",
        model: { id: "openai/opaque-model" },
        observed: { model: "openai/opaque-model", agentHarnessId: "acpx" },
        expectedModel: "openai/opaque-model",
        expectedContext: 42_000,
      },
      {
        name: "opaque ACP model with another model's telemetry",
        model: { id: "openai/opaque-model" },
        observed: { model: "previous-model", agentHarnessId: "acpx" },
        expectedModel: "openai/opaque-model",
        expectedContext: null,
      },
      {
        name: "opaque ACP model with another runtime's telemetry",
        model: { id: "openai/opaque-model" },
        observed: { model: "openai/opaque-model", agentHarnessId: "openclaw" },
        expectedModel: "openai/opaque-model",
        expectedContext: null,
      },
      {
        name: "native-managed ACP model without runtime telemetry",
        model: "native-managed",
        expectedModel: null,
        expectedContext: null,
      },
      {
        name: "native-managed ACP model with runtime telemetry",
        model: "native-managed",
        observed: { model: "observed-model", agentHarnessId: "acpx" },
        expectedModel: "observed-model",
        expectedContext: 42_000,
      },
    ])("projects $name without configured model fallbacks", async (scenario) => {
      const actual = await vi.importActual<typeof StatusSummaryRuntimeModule>(
        "../status/summary.runtime.js",
      );
      const runtime = params.getStatusSummaryRuntime();
      vi.mocked(runtime.resolveSessionRuntime).mockReturnValue({
        id: "acpx",
        label: "qa-agent (acp/acpx)",
      });
      params.setSessions({
        "agent:main:plugin:conversation": {
          sessionId: "opaque-acp-model",
          updatedAt: 1,
          executionSelection: {
            state: "accepted",
            selection: {
              model: scenario.model,
              executor: { kind: "acp", backend: "acpx", agent: "qa-agent" },
            },
            fallbackPermission: "explicit",
          },
          ...(scenario.observed
            ? {
                modelProvider: "observed-provider",
                contextTokens: 42_000,
                contextTokensSource: "runtime",
                ...scenario.observed,
              }
            : {}),
          totalTokens: 11,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        },
      });

      await vi
        .mocked(runtime.resolveSessionModelRef)
        .withImplementation(actual.statusSummaryRuntime.resolveSessionModelRef, async () => {
          const summary = await params.getStatusSummary();
          const expected = {
            model: scenario.expectedModel,
            selectedModel:
              scenario.model === "native-managed" ? "the app's default model" : scenario.model.id,
            configuredModel: "openai/gpt-5.5",
            modelSelectionReason: null,
            contextTokens: scenario.expectedContext,
            remainingTokens: scenario.expectedContext === null ? null : 41_989,
          };
          expect(summary.sessions.recent[0]).toMatchObject(expected);
          expect(summary.sessions.byAgent[0]?.recent[0]).toMatchObject(expected);
        });
    });

    it("rejects a stale runtime window after a same-model harness change", async () => {
      vi.mocked(params.getStatusSummaryRuntime().resolveContextTokensForModel).mockReturnValue(
        1_000_000,
      );
      vi.mocked(params.getStatusSummaryRuntime().resolveSessionRuntime).mockReturnValue({
        id: "codex",
        label: "OpenAI Codex",
      });
      params.setSessions({
        "agent:main:main": {
          sessionId: "same-model-runtime-change",
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.5",
          agentHarnessId: "openclaw",
          contextTokens: 272_000,
          contextTokensSource: "runtime",
          totalTokens: 11,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        },
      });

      const summary = await params.getStatusSummary();

      expect(summary.sessions.recent[0]).toMatchObject({
        runtime: "OpenAI Codex",
        contextTokens: 1_000_000,
        remainingTokens: 999_989,
      });
    });

    it("keeps telemetry from the matching runtime producer", async () => {
      vi.mocked(params.getStatusSummaryRuntime().resolveContextTokensForModel).mockReturnValue(
        1_000_000,
      );
      params.setSessions({
        "agent:main:main": {
          sessionId: "matching-runtime-window",
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.5",
          agentHarnessId: "openclaw",
          contextTokens: 272_000,
          contextTokensSource: "runtime",
          totalTokens: 11,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        },
      });

      const summary = await params.getStatusSummary();

      expect(summary.sessions.recent[0]?.contextTokens).toBe(272_000);
    });

    it("replaces matching runtime telemetry with a newly authored effective cap", async () => {
      vi.mocked(params.getStatusSummaryRuntime().resolveAuthoredModelContextTokens).mockReturnValue(
        1_000_000,
      );
      vi.mocked(params.getStatusSummaryRuntime().resolveContextTokensForModel).mockReturnValue(
        1_000_000,
      );
      params.setSessions({
        "agent:main:main": {
          sessionId: "authored-context-cap",
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.5",
          agentHarnessId: "openclaw",
          contextTokens: 272_000,
          contextTokensSource: "runtime",
        },
      });

      const summary = await params.getStatusSummary();

      expect(summary.sessions.recent[0]?.contextTokens).toBe(1_000_000);
    });

    it("preserves the native window owned by a locked legacy session", async () => {
      vi.mocked(params.getStatusSummaryRuntime().resolveContextTokensForModel).mockReturnValue(
        272_000,
      );
      vi.mocked(params.getStatusSummaryRuntime().resolveSessionRuntime).mockReturnValue({
        id: "codex",
        label: "OpenAI Codex",
      });
      params.setSessions({
        "agent:main:main": {
          sessionId: "locked-legacy-window",
          updatedAt: Date.now(),
          modelSelectionLocked: true,
          contextTokens: 1_000_000,
        },
      });

      const summary = await params.getStatusSummary();

      expect(summary.sessions.recent[0]?.contextTokens).toBe(1_000_000);
    });

    it("caps matching unlocked runtime telemetry to the lower current window", async () => {
      vi.mocked(params.getStatusSummaryRuntime().resolveContextTokensForModel).mockReturnValue(
        272_000,
      );
      vi.mocked(params.getStatusSummaryRuntime().resolveSessionRuntime).mockReturnValue({
        id: "codex",
        label: "OpenAI Codex",
      });
      params.setSessions({
        "agent:main:main": {
          sessionId: "unlocked-runtime-window",
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.5",
          agentHarnessId: "codex",
          contextTokens: 1_000_000,
          contextTokensSource: "runtime",
        },
      });

      const summary = await params.getStatusSummary();

      expect(summary.sessions.recent[0]?.contextTokens).toBe(272_000);
    });
  });
}
