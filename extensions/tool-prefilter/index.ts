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
  configOrApi?: OpenClawConfig | OpenClawPluginApi | { config?: OpenClawConfig; runtime?: unknown },
  maybeApi?: OpenClawPluginApi | { runtime?: unknown; config?: OpenClawConfig },
): boolean {
  const api =
    (maybeApi && "runtime" in maybeApi ? (maybeApi as OpenClawPluginApi) : undefined) ??
    (configOrApi && "runtime" in configOrApi ? (configOrApi as OpenClawPluginApi) : undefined);
  const config =
    (configOrApi && "agents" in configOrApi ? (configOrApi as OpenClawConfig) : undefined) ??
    (api && "config" in api ? (api.config as OpenClawConfig) : undefined);

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
      explicitHarness !== "embedded" &&
      explicitHarness !== "pi" &&
      explicitHarness !== "auto" &&
      explicitHarness !== "default" &&
      explicitHarness !== "copilot"
    ) {
      return false;
    }
  }

  // 2. Provider / model indicators on hook context
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

  // 4. Authoritative host runtime policy resolution (via api.runtime.modelConfig)
  let authoritativePolicyId: string | undefined;
  const runtimeModelConfig = (
    api as unknown as { runtime?: { modelConfig?: { resolveModelRuntimePolicy?: Function } } }
  )?.runtime?.modelConfig;
  if (typeof runtimeModelConfig?.resolveModelRuntimePolicy === "function") {
    try {
      const resolved = runtimeModelConfig.resolveModelRuntimePolicy({
        config,
        provider: ctx?.modelProviderId,
        modelId: ctx?.modelId,
        agentId: ctx?.agentId,
        sessionKey: ctx?.sessionKey,
      });
      if (resolved?.policy?.id) {
        authoritativePolicyId = String(resolved.policy.id).trim().toLowerCase();
      }
    } catch {
      // Fall through to configuration inspection
    }
  }

  if (authoritativePolicyId) {
    if (
      authoritativePolicyId === "codex" ||
      authoritativePolicyId === "codex-app-server" ||
      authoritativePolicyId === "acpx"
    ) {
      return false;
    }
    if (
      authoritativePolicyId !== "openclaw" &&
      authoritativePolicyId !== "embedded" &&
      authoritativePolicyId !== "pi" &&
      authoritativePolicyId !== "auto" &&
      authoritativePolicyId !== "default" &&
      authoritativePolicyId !== "copilot"
    ) {
      return false;
    }
  }

  // 5. Configuration checks (model-scoped, agent-scoped, or global runtime settings)
  let modelScopedRuntime: string | undefined;
  let agentRuntimeId: string | undefined;

  if (config) {
    // Check model-scoped runtime in agent entries and defaults
    const candidateModelKeys: string[] = [];
    if (ctx?.modelId) {
      const rawModel = ctx.modelId.trim();
      candidateModelKeys.push(rawModel, rawModel.toLowerCase());
      if (ctx?.modelProviderId) {
        const prov = ctx.modelProviderId.trim();
        candidateModelKeys.push(
          `${prov}/${rawModel}`,
          `${prov.toLowerCase()}/${rawModel.toLowerCase()}`,
        );
      }
      const slashIndex = rawModel.indexOf("/");
      if (slashIndex > 0) {
        const afterSlash = rawModel.slice(slashIndex + 1).trim();
        candidateModelKeys.push(afterSlash, afterSlash.toLowerCase());
      }
    }

    const checkModelDict = (dict: unknown): string | undefined => {
      if (!dict || typeof dict !== "object") {
        return undefined;
      }
      const record = dict as Record<string, unknown>;
      for (const key of candidateModelKeys) {
        const entry = record[key];
        if (entry && typeof entry === "object") {
          const entryObj = entry as Record<string, unknown>;
          const runtime =
            (entryObj.agentRuntime as { id?: string } | undefined)?.id ??
            (entryObj.runtime as { id?: string } | undefined)?.id ??
            (typeof entryObj.agentRuntime === "string" ? entryObj.agentRuntime : undefined);
          if (typeof runtime === "string") {
            return runtime;
          }
        }
      }
      return undefined;
    };

    if (ctx?.agentId) {
      const rawAgents = (config as Record<string, unknown>).agents as
        | Record<string, unknown>
        | undefined;
      const rawEntries = rawAgents?.entries as Record<string, unknown> | undefined;
      const agentEntry = rawEntries?.[ctx.agentId] ?? rawAgents?.[ctx.agentId];
      if (agentEntry && typeof agentEntry === "object") {
        modelScopedRuntime = checkModelDict((agentEntry as Record<string, unknown>).models);
      }
    }

    if (!modelScopedRuntime) {
      modelScopedRuntime = checkModelDict(config.agents?.defaults?.models);
    }

    if (!modelScopedRuntime && provider && (config as Record<string, unknown>).models) {
      const modelsConfig = (config as Record<string, unknown>).models as Record<string, unknown>;
      const provObj = (modelsConfig.providers as Record<string, unknown> | undefined)?.[provider];
      if (provObj && typeof provObj === "object") {
        modelScopedRuntime =
          checkModelDict((provObj as Record<string, unknown>).models) ??
          ((provObj as Record<string, unknown>).agentRuntime as { id?: string } | undefined)?.id ??
          (typeof (provObj as Record<string, unknown>).agentRuntime === "string"
            ? ((provObj as Record<string, unknown>).agentRuntime as string)
            : undefined);
      }
    }

    if (modelScopedRuntime) {
      const normalized = modelScopedRuntime.trim().toLowerCase();
      if (normalized === "codex" || normalized === "codex-app-server" || normalized === "acpx") {
        return false;
      }
      if (
        normalized &&
        normalized !== "openclaw" &&
        normalized !== "embedded" &&
        normalized !== "pi" &&
        normalized !== "auto" &&
        normalized !== "default" &&
        normalized !== "copilot"
      ) {
        return false;
      }
    }

    // Agent-level runtime settings
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
        normalized !== "embedded" &&
        normalized !== "pi" &&
        normalized !== "auto" &&
        normalized !== "default" &&
        normalized !== "copilot"
      ) {
        return false;
      }
    }
  }

  // 6. Implicit OpenAI provider routing:
  // OpenAI routes to Codex by default in OpenClaw unless an explicit supported runtime is set.
  const isExplicitlySupported =
    authoritativePolicyId === "openclaw" ||
    authoritativePolicyId === "embedded" ||
    authoritativePolicyId === "pi" ||
    authoritativePolicyId === "copilot" ||
    modelScopedRuntime === "openclaw" ||
    modelScopedRuntime === "embedded" ||
    modelScopedRuntime === "pi" ||
    modelScopedRuntime === "copilot" ||
    agentRuntimeId === "openclaw" ||
    agentRuntimeId === "embedded" ||
    agentRuntimeId === "pi" ||
    agentRuntimeId === "copilot";

  if ((provider === "openai" || provider === "openai-codex") && !isExplicitlySupported) {
    return false;
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
              const effectiveConfig =
                (
                  api.runtime as unknown as { config?: { current?: () => OpenClawConfig } }
                )?.config?.current?.() ?? api.config;
              if (!isRestrictiveToolPolicySupported(ctx, effectiveConfig, api)) {
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
