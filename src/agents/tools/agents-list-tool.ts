/**
 * agents_list built-in tool.
 *
 * Lists configured or allowed agent ids plus model/runtime metadata for subagent spawn decisions.
 */
import { Type, type Static } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveModelAgentRuntimeMetadata } from "../agent-runtime-metadata.js";
import {
  listAgentEntrySummaries,
  listAgentIds,
  type AgentEntrySummary,
} from "../agent-scope-config.js";
import { resolveAgentConfig, resolveSessionAgentIds } from "../agent-scope.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import { resolveSubagentAllowedTargetIds } from "../subagents/spawn/subagent-target-policy.js";
import { describeAgentsListTool } from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

const AgentsListToolSchema = Type.Object({});
const AgentRuntimeSourceSchema = Type.Union([
  Type.Literal("env"),
  Type.Literal("agent"),
  Type.Literal("defaults"),
  Type.Literal("model"),
  Type.Literal("provider"),
  Type.Literal("implicit"),
  Type.Literal("session"),
  Type.Literal("session-key"),
]);
const AgentsListOutputSchema = Type.Object(
  {
    requester: Type.String(),
    allowAny: Type.Boolean(),
    agents: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          name: Type.Optional(Type.String()),
          configured: Type.Boolean(),
          model: Type.Optional(Type.String()),
          agentRuntime: Type.Optional(
            Type.Object(
              {
                id: Type.String(),
                source: AgentRuntimeSourceSchema,
              },
              { additionalProperties: false },
            ),
          ),
          description: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

type AgentListEntry = Static<typeof AgentsListOutputSchema>["agents"][number];

export function createAgentsListTool(opts?: {
  agentSessionKey?: string;
  /** Explicit agent ID override for cron/hook sessions. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Agents",
    name: "agents_list",
    description: describeAgentsListTool(false),
    parameters: AgentsListToolSchema,
    outputSchema: AgentsListOutputSchema,
    execute: async () => {
      const cfg = getRuntimeConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterInternalKey =
        typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()
          ? resolveInternalSessionKey({
              key: opts.agentSessionKey,
              alias,
              mainKey,
            })
          : alias;
      const requesterAgentId = resolveSessionAgentIds({
        config: cfg,
        sessionKey: requesterInternalKey,
        agentId: opts?.requesterAgentIdOverride,
      }).sessionAgentId;

      const allowAgents =
        resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ??
        cfg?.agents?.defaults?.subagents?.allowAgents;

      const configuredIds = listAgentIds(cfg);
      // First match wins so duplicate normalized ids stay deterministic per config,
      // matching the roster's data-plane projection.
      const summaryById = new Map<string, AgentEntrySummary>();
      for (const summary of listAgentEntrySummaries(cfg)) {
        if (!summaryById.has(summary.id)) {
          summaryById.set(summary.id, summary);
        }
      }

      const allowed = resolveSubagentAllowedTargetIds({
        requesterAgentId,
        allowAgents,
        configuredAgentIds: configuredIds,
      });
      const all = allowed.allowedIds;
      const rest = all
        .filter((id) => id !== requesterAgentId)
        .toSorted((a, b) => a.localeCompare(b));
      const ordered = all.includes(requesterAgentId) ? [requesterAgentId, ...rest] : rest;
      const agents: AgentListEntry[] = ordered.map((id) => {
        const resolvedModel = resolveDefaultModelForAgent({ cfg, agentId: id });
        // Publish the resolved identity (aliases are routing-only) so the model
        // field matches the agentRuntime derived from the same resolvedModel.
        const model = `${resolvedModel.provider}/${resolvedModel.model}`;
        const agentRuntime = resolveModelAgentRuntimeMetadata({
          cfg,
          agentId: id,
          provider: resolvedModel.provider,
          model: resolvedModel.model,
        });
        const summary = summaryById.get(id);
        const agent: AgentListEntry = {
          id,
          name: summary?.name,
          configured: configuredIds.includes(id),
          model,
          agentRuntime,
        };
        if (summary?.description) {
          agent.description = summary.description;
        }
        return agent;
      });

      return jsonResult({
        requester: requesterAgentId,
        allowAny: allowed.allowAny,
        agents,
      });
    },
  };
}
