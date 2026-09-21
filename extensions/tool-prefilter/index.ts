import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  definePluginEntry,
  type OpenClawConfig,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";

export interface ToolPreFilterPluginConfig {
  enabled?: boolean;
  thresholdAnyTool?: number;
  timeoutMs?: number;
}

export type HookAgentContextLike = {
  agentId?: string;
  sessionKey?: string;
  modelProviderId?: string;
  modelId?: string;
  harnessId?: string;
  agentHarnessId?: string;
  agentRuntime?: string;
  agentRuntimeId?: string;
  [key: string]: unknown;
};

/**
 * Checks whether the active agent harness supports turn-scoped restrictive tool policy (`toolsAllow: []`).
 *
 * Per OpenClaw prompt contract (docs/plugins/hooks/prompt-and-session.md), only the embedded runner
 * and Copilot harness support turn-scoped tool restrictions. The Codex app-server and ACP harnesses
 * define tools at thread/connection boundaries and reject restrictive values at preparation time.
 */
export function isRestrictiveToolPolicySupported(
  ctx?: HookAgentContextLike,
  config?: OpenClawConfig,
): boolean {
  // 1. Direct harness indicators on hook context
  const explicitHarness = (
    ctx?.harnessId ??
    ctx?.agentHarnessId ??
    ctx?.agentRuntime ??
    ctx?.agentRuntimeId
  )
    ?.toString()
    ?.trim()
    ?.toLowerCase();
  if (explicitHarness) {
    if (
      explicitHarness === "codex" ||
      explicitHarness === "codex-app-server" ||
      explicitHarness === "acpx"
    ) {
      return false;
    }
    if (
      explicitHarness !== "openclaw" &&
      explicitHarness !== "pi" &&
      explicitHarness !== "auto" &&
      explicitHarness !== "default" &&
      explicitHarness !== "copilot"
    ) {
      return false;
    }
  }

  // 2. Provider / model indicators
  const provider = ctx?.modelProviderId?.trim().toLowerCase();
  if (provider === "codex" || provider === "acpx") {
    return false;
  }

  const modelId = ctx?.modelId?.trim().toLowerCase();
  if (modelId && (modelId.includes("codex") || modelId.startsWith("codex/"))) {
    return false;
  }

  // 3. Session key indicators (Codex session keys include "harness:codex" or ":codex:")
  const sessionKey = ctx?.sessionKey?.toLowerCase();
  if (
    sessionKey &&
    (sessionKey.includes("harness:codex") ||
      sessionKey.includes(":codex:") ||
      sessionKey.includes("harness:acpx") ||
      sessionKey.includes(":acpx:"))
  ) {
    return false;
  }

  // 4. Configuration checks (agent-level or global runtime settings)
  if (config) {
    let agentRuntimeId: string | undefined;

    if (ctx?.agentId) {
      try {
        const agentConfig = resolveAgentConfig(config, ctx.agentId);
        agentRuntimeId =
          agentConfig?.agentRuntime?.id ??
          (agentConfig?.runtime as { id?: string } | undefined)?.id;

        if (
          typeof agentConfig?.model === "string" &&
          agentConfig.model.toLowerCase().includes("codex")
        ) {
          return false;
        }
        if (typeof agentConfig?.model === "object" && agentConfig?.model !== null) {
          const m = agentConfig.model as { provider?: string; id?: string };
          if (m.provider?.toLowerCase() === "codex" || m.id?.toLowerCase().includes("codex")) {
            return false;
          }
        }
      } catch {
        // Fail-safe if resolveAgentConfig encounters unexpected configuration shape
      }

      // Check direct agent entries in case config is a partial mock object
      const rawConfig = config as Record<string, unknown>;
      const rawAgents = rawConfig.agents as Record<string, unknown> | undefined;
      const rawEntries = rawAgents?.entries as Record<string, unknown> | undefined;
      const directAgent =
        (rawEntries?.[ctx.agentId] as Record<string, unknown> | undefined) ??
        (rawAgents?.[ctx.agentId] as Record<string, unknown> | undefined) ??
        (Array.isArray(rawAgents?.list)
          ? (rawAgents.list as unknown[]).find(
              (a): a is Record<string, unknown> =>
                typeof a === "object" &&
                a !== null &&
                (a as Record<string, unknown>).id === ctx.agentId,
            )
          : undefined);

      if (!agentRuntimeId && directAgent) {
        const agentRuntimeObj = directAgent.agentRuntime as { id?: string } | undefined;
        const runtimeObj = directAgent.runtime as { id?: string } | undefined;
        agentRuntimeId = agentRuntimeObj?.id ?? runtimeObj?.id;
      }
    }

    if (!agentRuntimeId) {
      const rawConfig = config as Record<string, unknown>;
      const rawAgentRuntime = rawConfig.agentRuntime;
      agentRuntimeId =
        config.agents?.defaults?.agentRuntime?.id ??
        (typeof rawAgentRuntime === "object" && rawAgentRuntime !== null
          ? (rawAgentRuntime as { id?: string }).id
          : typeof rawAgentRuntime === "string"
            ? rawAgentRuntime
            : undefined);
    }

    if (typeof agentRuntimeId === "string") {
      const normalized = agentRuntimeId.trim().toLowerCase();
      if (normalized === "codex" || normalized === "codex-app-server" || normalized === "acpx") {
        return false;
      }
      if (
        normalized &&
        normalized !== "openclaw" &&
        normalized !== "pi" &&
        normalized !== "auto" &&
        normalized !== "default" &&
        normalized !== "copilot"
      ) {
        return false;
      }
    }
  }

  return true;
}

export default definePluginEntry({
  id: "tool-prefilter",
  name: "Tool Pre-filter",
  description:
    "Dynamic two-stage skill and tool pre-filtering using decision models to reduce context overhead and eliminate tool hallucinations.",
  register(api: OpenClawPluginApi) {
    api.on("before_prompt_build", async (event, ctx) => {
      const config = (api.pluginConfig ?? {}) as ToolPreFilterPluginConfig;
      if (config.enabled === false) {
        return undefined;
      }

      // If the runtime decisions evaluation is not available, fail-open
      const decisions = api.runtime?.decisions;
      if (!decisions || typeof decisions.evaluate !== "function") {
        return undefined;
      }

      // The hook contract explicitly distinguishes an empty currentUserMessage from an omitted legacy field.
      // If currentUserMessage is explicitly provided (including an empty string), do not fall back to event.prompt.
      const rawMessage =
        event.currentUserMessage !== undefined ? event.currentUserMessage : event.prompt;
      const userMessage = rawMessage?.trim();
      if (!userMessage) {
        return undefined;
      }

      const threshold = config.thresholdAnyTool ?? 0.35;
      const timeoutMs = config.timeoutMs ?? 500;

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const outcome = await decisions.evaluate(
          {
            state: { userMessage },
            questions: {
              any_tool_needed: {
                type: "boolean",
                instructions:
                  "Does this user prompt require executing an external tool (such as bash, git, file reading/writing, web search, database operations, or APIs), or can it be answered purely as conversational knowledge/dialogue?",
              },
            },
          },
          {
            agentId: ctx?.agentId,
            purpose: "tool-prefilter.semantic-gate",
            rubricVersion: "1",
            timeoutMs,
            signal: controller.signal,
          },
        );

        if (outcome && outcome.status === "ok") {
          const answer = outcome.result?.answers?.any_tool_needed;
          if (answer && answer.type === "boolean" && typeof answer.probabilityTrue === "number") {
            const prob = answer.probabilityTrue;

            // Pure conversational turn: strip optional tools from the model context if supported
            if (prob < threshold) {
              if (!isRestrictiveToolPolicySupported(ctx, api.config)) {
                api.logger?.info(
                  `[tool-prefilter] Pure conversation detected, but active harness does not support turn-scoped tool pruning. Preserving tools.`,
                );
                return undefined;
              }

              api.logger?.info(
                `[tool-prefilter] Pure conversation detected (tool probability: ${(prob * 100).toFixed(1)}% < ${(threshold * 100).toFixed(1)}%). Pruning tools to save context.`,
              );
              return {
                toolsAllow: [],
              };
            }
          }
        }
      } catch (err) {
        // Fail-open: network glitches or decision provider errors must never break agent conversation
        api.logger?.warn(`[tool-prefilter] Decision check failed, failing open: ${String(err)}`);
      } finally {
        clearTimeout(timeoutHandle);
      }

      return undefined;
    });
  },
});
