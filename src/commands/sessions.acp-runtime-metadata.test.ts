// Sessions ACP runtime metadata tests cover session-owned runtime overlays.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveCurrentSessionAgentRuntimeMetadata,
  resolveModelAgentRuntimeMetadata,
} from "../agents/agent-runtime-metadata.js";
import {
  clearAgentHarnesses,
  listRegisteredAgentHarnesses,
  registerAgentHarness,
} from "../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../agents/harness/registry.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

const ACP_SESSION_KEY = "agent:copilot:acp:86b7b5af-3773-4a56-b244-069d6c5d3db9";
const NON_ACP_SESSION_KEY = "agent:main:main";

function buildConfigWithoutAgentRuntimePolicy(): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "copilot" }, { id: "main", default: true }],
      defaults: {},
    },
  } as OpenClawConfig;
}

function computeSessionAgentRuntime(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  fallbackAgentId: string;
  acpRuntime?: boolean;
  acpBackend?: string;
}): ReturnType<typeof resolveModelAgentRuntimeMetadata> {
  const agentId = parseAgentSessionKey(params.sessionKey)?.agentId ?? params.fallbackAgentId;
  return resolveModelAgentRuntimeMetadata({
    cfg: params.cfg,
    agentId,
    sessionKey: params.sessionKey,
    acpRuntime: params.acpRuntime,
    acpBackend: params.acpBackend,
  });
}

const registeredHarnesses = listRegisteredAgentHarnesses();
beforeEach(() => clearAgentHarnesses());
afterAll(() => restoreRegisteredAgentHarnesses(registeredHarnesses));

describe("session ACP runtime metadata", () => {
  it.each(["model", "provider", "implicit"] as const)(
    "projects a declared fallback for the next turn while retaining %s attribution",
    (source) => {
      const supports = vi.fn((_context: unknown) => ({
        supported: false as const,
        fallbackRuntime: "openclaw" as const,
      }));
      registerAgentHarness({
        id: "codex",
        label: "Codex",
        supports,
        runAttempt: async () => {
          throw new Error("projection must not execute");
        },
      });
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              ...(source === "provider" ? { agentRuntime: { id: "codex" } } : {}),
              models: [
                {
                  id: "gpt-5.6-luna",
                  name: "Sol",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 8192,
                  compat: { supportsStore: false },
                },
              ],
            },
          },
        },
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.6-luna": source === "model" ? { agentRuntime: { id: "codex" } } : {},
            },
          },
        },
      };
      const params = {
        cfg,
        agentId: "main",
        provider: "openai",
        model: "gpt-5.6-luna",
        sessionKey: NON_ACP_SESSION_KEY,
        sessionEntry: {
          executionSelection: {
            state: "deferred",
            request: { model: { provider: "openai", id: "gpt-5.6-luna" }, runtime: "codex" },
            fallbackPermission: "explicit",
          },
        },
      } satisfies Parameters<typeof resolveCurrentSessionAgentRuntimeMetadata>[0];
      expect(resolveCurrentSessionAgentRuntimeMetadata(params)).toEqual({ id: "openclaw", source });
      expect(
        resolveCurrentSessionAgentRuntimeMetadata({
          ...params,
          sessionEntry: {
            executionSelection: {
              state: "accepted",
              selection: {
                model: { provider: "openai", id: "gpt-5.6-luna" },
                executor: { kind: "harness", id: "codex" },
              },
              fallbackPermission: "explicit",
            },
          },
        }),
      ).toEqual({ id: "codex", source: "session" });
      expect(
        resolveCurrentSessionAgentRuntimeMetadata({
          ...params,
          sessionKey: "agent:main:acp:runtime-test",
          acpRuntime: true,
        }),
      ).toEqual({ id: "acpx", source: "session-key" });
    },
  );
  it("prefers an explicit ACP backend", () => {
    const agentRuntime = computeSessionAgentRuntime({
      cfg: buildConfigWithoutAgentRuntimePolicy(),
      sessionKey: ACP_SESSION_KEY,
      fallbackAgentId: "copilot",
      acpRuntime: true,
      acpBackend: "custom-backend",
    });

    expect(agentRuntime).toEqual({ id: "custom-backend", source: "session-key" });
  });

  it("falls back to acpx when ACP metadata has no backend", () => {
    const agentRuntime = computeSessionAgentRuntime({
      cfg: buildConfigWithoutAgentRuntimePolicy(),
      sessionKey: ACP_SESSION_KEY,
      fallbackAgentId: "copilot",
      acpRuntime: true,
    });

    expect(agentRuntime).toEqual({ id: "acpx", source: "session-key" });
  });

  it("does not overlay ACP-shaped bridge sessions without ACP metadata", () => {
    const agentRuntime = computeSessionAgentRuntime({
      cfg: buildConfigWithoutAgentRuntimePolicy(),
      sessionKey: ACP_SESSION_KEY,
      fallbackAgentId: "copilot",
      acpRuntime: false,
    });

    expect(agentRuntime.id).not.toBe("acpx");
    expect(agentRuntime.source).not.toBe("session-key");
  });

  it("preserves accepted Codex ownership ahead of current OpenClaw policy", () => {
    const agentRuntime = resolveModelAgentRuntimeMetadata({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      } as OpenClawConfig,
      agentId: "main",
      provider: "openai",
      model: "gpt-5.5",
      sessionKey: NON_ACP_SESSION_KEY,
      sessionEntry: {
        executionSelection: {
          state: "accepted",
          selection: {
            model: { provider: "openai", id: "gpt-5.5" },
            executor: { kind: "harness", id: "codex" },
          },
          fallbackPermission: "explicit",
        },
      },
    });

    expect(agentRuntime).toEqual({ id: "codex", source: "session" });
  });

  it.each([undefined, "codex"])(
    "reports current %s policy instead of an unaccepted runtime request",
    (runtime) => {
      const agentRuntime = resolveCurrentSessionAgentRuntimeMetadata({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.6-luna": runtime ? { agentRuntime: { id: runtime } } : {},
              },
            },
          },
        } as OpenClawConfig,
        agentId: "main",
        provider: "openai",
        model: "gpt-5.6-luna",
        sessionKey: NON_ACP_SESSION_KEY,
        sessionEntry: {
          executionSelection: {
            state: "deferred",
            request: { runtime: "openclaw", defaultSelection: "inherit" },
            fallbackPermission: "configured",
          },
        },
      });

      expect(agentRuntime).toEqual({ id: "codex", source: runtime ? "model" : "implicit" });
    },
  );

  it("keeps an accepted native-managed runtime without a model policy", () => {
    const agentRuntime = resolveCurrentSessionAgentRuntimeMetadata({
      cfg: buildConfigWithoutAgentRuntimePolicy(),
      agentId: "main",
      provider: "openai",
      model: "gpt-5.6-luna",
      sessionKey: NON_ACP_SESSION_KEY,
      sessionEntry: {
        executionSelection: {
          state: "accepted",
          selection: {
            model: "native-managed",
            executor: { kind: "harness", id: "codex" },
          },
          fallbackPermission: "explicit",
        },
      },
    });

    expect(agentRuntime).toEqual({ id: "codex", source: "session" });
  });
});
