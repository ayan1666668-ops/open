// Tests compact command context-budget resolution separately from command lifecycle behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  buildCompactParams as createCompactParams,
  compactEmbeddedAgentSession,
  formatContextUsageShort,
  runCompactCommand,
  requireCompactEmbeddedAgentSessionCall,
  resetCompactCommandMocks,
} from "./commands-compact.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

const buildCompactParams = (cfg: OpenClawConfig) => createCompactParams("/compact", cfg);

describe("handleCompactCommand context budget", () => {
  beforeEach(resetCompactCommandMocks);

  it("resolves the active Codex runtime config instead of stale session metadata", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "compacted",
        firstKeptEntryId: "first-kept",
        tokensBefore: 199_000,
        tokensAfter: 56_000,
      },
    });

    const result = await runCompactCommand(
      {
        ...buildCompactParams({
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": {
                  agentRuntime: { id: "codex" },
                },
              },
            },
          },
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
          models: {
            providers: {
              openai: {
                models: [{ id: "gpt-5.5", contextWindow: 258_000 }],
              },
            },
          },
        } as unknown as OpenClawConfig),
        provider: "openai",
        model: "openai/gpt-5.5",
        contextTokens: 0,
        sessionEntry: {
          sessionId: "live-session",
          updatedAt: Date.now(),
          contextTokens: 400_000,
        },
      } as HandleCommandsParams,
      true,
    );

    expect(compactEmbeddedAgentSession, result?.reply?.text).toHaveBeenCalledOnce();
    expect(requireCompactEmbeddedAgentSessionCall().contextTokenBudget).toBe(258_000);
    expect(vi.mocked(formatContextUsageShort)).toHaveBeenLastCalledWith(56_000, 258_000);
  });

  it("retains persisted context when an unknown custom model uses a legacy alias", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "already compacted",
    });

    await runCompactCommand(
      {
        ...buildCompactParams({
          agents: {
            defaults: {
              models: { "custom/actual-model": { alias: "legacy-fast-model" } },
            },
          },
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        provider: "custom",
        model: "actual-model",
        contextTokens: 0,
        sessionEntry: {
          sessionId: "legacy-model-session",
          updatedAt: Date.now(),
          executionSelection: {
            state: "accepted",
            selection: {
              model: { provider: "custom", id: "actual-model" },
              executor: { kind: "harness", id: "openclaw" },
            },
            fallbackPermission: "explicit",
          },
          contextTokens: 777_777,
        },
      } as HandleCommandsParams,
      true,
    );

    expect(requireCompactEmbeddedAgentSessionCall().contextTokenBudget).toBe(777_777);
  });
});
