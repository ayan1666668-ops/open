/** Higher-level agent scope helpers for model selection, fallbacks, skills, and workspaces. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  resolvePrimaryStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { resolveEffectiveAgentSkillFilter } from "../skills/discovery/agent-filter.js";
import {
  AgentSelectionRequiredError,
  hasAgentRosterProperty,
  listAgentIds,
  resolveMutableAgentEntry,
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  tryResolveLegacyDataOwnerAgentId,
  withAgentRosterFactsBatch,
} from "./agent-scope-config.js";
import { resolveCanonicalWorkspacePath } from "./workspace-state-identity.js";
export {
  listAgentEntries,
  listAgentEntriesWithSource,
  listAgentIds,
  resolveConfiguredAgentId,
  resolveMutableAgentEntry,
  toAgentEntriesRecord,
  resolveAgentConfig,
  resolveAgentContextLimits,
  resolveAgentDir,
  resolveDefaultAgentDir,
  resolveAgentRunCwd,
  resolveAgentWorkspaceDir,
  resolveAgentWorkspaceProvisioning,
  tryResolveConfiguredAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveAmbientOwnerAgentId,
  resolveSoleAgentId,
  tryResolveAmbientOwnerAgentId,
  tryResolveLegacyCompatibilityAgentId,
  tryResolveSoleAgentId,
  tryResolveDefaultAgentId,
  AgentSelectionRequiredError,
} from "./agent-scope-config.js";

export { resolveAgentIdFromSessionKey };

type SessionAgentResolutionParams = {
  sessionKey?: string;
  config?: OpenClawConfig;
  agentId?: string | undefined;
  fallbackAgentId?: string;
};

const SESSION_AGENT_SELECTION_CONTEXT = {
  surface: "session agent resolution",
  hint: "Pass an agentId, an agent-scoped session key, or a prepared fallbackAgentId.",
};

function resolveSelectedSessionAgentId(params: SessionAgentResolutionParams): string | undefined {
  const explicitAgentIdRaw = normalizeLowercaseStringOrEmpty(params.agentId);
  const explicitAgentId = explicitAgentIdRaw ? normalizeAgentId(explicitAgentIdRaw) : null;
  const fallbackAgentIdRaw = normalizeLowercaseStringOrEmpty(params.fallbackAgentId);
  const fallbackAgentId = fallbackAgentIdRaw ? normalizeAgentId(fallbackAgentIdRaw) : null;
  const sessionKey = params.sessionKey?.trim();
  const normalizedSessionKey = sessionKey ? normalizeLowercaseStringOrEmpty(sessionKey) : undefined;
  const parsed = normalizedSessionKey ? parseAgentSessionKey(normalizedSessionKey) : null;
  const sessionKeyAgentId = parsed?.agentId ? normalizeAgentId(parsed.agentId) : null;
  const cfg = params.config ?? {};
  const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, sessionKey);
  if (sessionKeyAgentId && explicitAgentId && explicitAgentId !== sessionKeyAgentId) {
    throw new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: "session agent resolution",
      hint: `The agent-scoped session key belongs to "${sessionKeyAgentId}", not "${explicitAgentId}".`,
    });
  }
  const requestedUnscopedAgentId = explicitAgentId ?? fallbackAgentId;
  if (!sessionKeyAgentId && persistedStoreOwner.kind === "retired") {
    throw new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: "session agent resolution",
      hint: `The shared fixed-store row belongs to retired agent "${persistedStoreOwner.agentId}".`,
    });
  }
  if (
    !sessionKeyAgentId &&
    persistedStoreOwner.kind === "configured" &&
    requestedUnscopedAgentId &&
    requestedUnscopedAgentId !== persistedStoreOwner.agentId
  ) {
    throw new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: "session agent resolution",
      hint: `The shared fixed-store row belongs to "${persistedStoreOwner.agentId}", not "${requestedUnscopedAgentId}".`,
    });
  }
  return (
    sessionKeyAgentId ??
    (persistedStoreOwner.kind === "configured" ? persistedStoreOwner.agentId : undefined) ??
    requestedUnscopedAgentId ??
    undefined
  );
}

/** Strict session selection uses explicit context and legacy data ownership. */
export function resolveSessionAgentIdsStrict(params: SessionAgentResolutionParams): {
  defaultAgentId: string;
  sessionAgentId: string;
} {
  const selectedAgentId = resolveSelectedSessionAgentId(params);
  const cfg = params.config ?? {};
  const compatibilityAgentId = tryResolveLegacyDataOwnerAgentId(cfg);
  const sessionAgentId =
    selectedAgentId ??
    compatibilityAgentId ??
    resolveDefaultAgentId(cfg, SESSION_AGENT_SELECTION_CONTEXT);
  const defaultAgentId = compatibilityAgentId ?? sessionAgentId;
  return { defaultAgentId, sessionAgentId };
}

export const resolveSessionAgentIds = resolveSessionAgentIdsStrict;

export function resolveSessionAgentIdStrict(params: SessionAgentResolutionParams): string {
  const selectedAgentId = resolveSelectedSessionAgentId(params);
  const cfg = params.config ?? {};
  return (
    selectedAgentId ??
    tryResolveLegacyDataOwnerAgentId(cfg) ??
    resolveDefaultAgentId(cfg, SESSION_AGENT_SELECTION_CONTEXT)
  );
}

export const resolveSessionAgentId = resolveSessionAgentIdStrict;

export function resolveAgentExecutionContract(
  cfg: OpenClawConfig | undefined,
  agentId?: string | null,
): NonNullable<NonNullable<AgentDefaultsConfig["embeddedAgent"]>["executionContract"]> | undefined {
  const defaultContract = cfg?.agents?.defaults?.embeddedAgent?.executionContract;
  if (!cfg || !agentId) {
    return defaultContract;
  }
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const agentContract = agentConfig?.embeddedAgent?.executionContract;
  return agentContract ?? defaultContract;
}

export function resolveAgentSkillsFilter(
  cfg: OpenClawConfig,
  agentId: string,
): string[] | undefined {
  return resolveEffectiveAgentSkillFilter(cfg, agentId);
}

export function resolveAgentExplicitModelPrimary(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  const raw = resolveAgentConfig(cfg, agentId)?.model;
  return resolvePrimaryStringValue(raw);
}

export function resolveAgentEffectiveModelPrimary(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  return (
    resolveAgentExplicitModelPrimary(cfg, agentId) ??
    resolvePrimaryStringValue(cfg.agents?.defaults?.model)
  );
}

function updateAgentModelPrimary(
  existing: AgentModelConfig | undefined,
  primary: string,
): AgentModelConfig {
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return { ...existing, primary };
  }
  return primary;
}

export type AgentModelPrimaryWriteTarget = "agent" | "defaults";

export function resolveAgentModelPrimaryWriteTarget(
  cfg: OpenClawConfig,
  agentId: string,
  options: { target?: AgentModelPrimaryWriteTarget; forceAgent?: boolean } = {},
): AgentModelPrimaryWriteTarget {
  const id = normalizeAgentId(agentId);
  const target = options.target ?? (options.forceAgent ? "agent" : undefined);
  return target !== "defaults" && (target === "agent" || resolveAgentExplicitModelPrimary(cfg, id))
    ? "agent"
    : "defaults";
}

export function setAgentEffectiveModelPrimary(
  cfg: OpenClawConfig,
  agentId: string,
  primary: string,
  options: { target?: AgentModelPrimaryWriteTarget; forceAgent?: boolean } = {},
): AgentModelPrimaryWriteTarget {
  const id = normalizeAgentId(agentId);
  const target = options.target ?? (options.forceAgent ? "agent" : undefined);
  const resolvedTarget = resolveAgentModelPrimaryWriteTarget(cfg, id, options);
  // An explicit agent target pins the write even without an existing model,
  // so a per-agent override never rewrites the shared default route.
  if (resolvedTarget === "agent") {
    const entry = resolveMutableAgentEntry(cfg, id);
    if (entry) {
      entry.model = updateAgentModelPrimary(entry.model, primary);
      return "agent";
    }
    if (target === "agent") {
      if (!hasAgentRosterProperty(cfg) && listAgentIds(cfg).includes(id)) {
        cfg.agents ??= {};
        cfg.agents.entries = { [id]: { model: updateAgentModelPrimary(undefined, primary) } };
        return "agent";
      }
      throw new Error(`Could not resolve configured agent "${id}".`);
    }
  }
  cfg.agents ??= {};
  cfg.agents.defaults ??= {};
  cfg.agents.defaults.model = updateAgentModelPrimary(cfg.agents.defaults.model, primary);
  return "defaults";
}

export function resolveAgentModelFallbacksOverride(
  cfg: OpenClawConfig,
  agentId: string,
): string[] | undefined {
  return resolveSelectedModelFallbacksOverride(resolveAgentConfig(cfg, agentId)?.model);
}

function resolveSelectedModelFallbacksOverride(
  raw: AgentModelConfig | undefined,
): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  if (typeof raw === "string") {
    return resolvePrimaryStringValue(raw) ? [] : undefined;
  }
  // Important: treat an explicitly provided empty array as an override to disable global fallbacks.
  if (!Object.hasOwn(raw, "fallbacks")) {
    return Object.hasOwn(raw, "primary") && resolvePrimaryStringValue(raw) ? [] : undefined;
  }
  return Array.isArray(raw.fallbacks) ? raw.fallbacks : undefined;
}

function resolveFirstModelFallbacksOverride(
  candidates: Array<AgentModelConfig | undefined>,
): string[] | undefined {
  for (const candidate of candidates) {
    const fallbackOverride = resolveSelectedModelFallbacksOverride(candidate);
    if (fallbackOverride !== undefined) {
      return fallbackOverride;
    }
  }
  return undefined;
}

type SubagentModelConfigSelectionSource = "subagent" | "agent" | "default-subagent";

export type SubagentModelConfigSelectionResult = {
  raw: AgentModelConfig;
  source: SubagentModelConfigSelectionSource;
};

export function resolveSubagentModelConfigSelectionResult(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentConfigOverride?: Pick<AgentConfig, "model" | "subagents">;
}): SubagentModelConfigSelectionResult | undefined {
  const agentConfig =
    params.agentConfigOverride ??
    (params.agentId ? resolveAgentConfig(params.cfg, params.agentId) : undefined);
  // Keep cron and fallback routing aligned with native spawn: per-agent subagent,
  // then the global subagent default, then agent-primary inheritance.
  const candidates: SubagentModelConfigSelectionResult[] = [
    ...(agentConfig?.subagents?.model
      ? [{ raw: agentConfig.subagents.model, source: "subagent" as const }]
      : []),
    ...(params.cfg.agents?.defaults?.subagents?.model
      ? [
          {
            raw: params.cfg.agents.defaults.subagents.model,
            source: "default-subagent" as const,
          },
        ]
      : []),
    ...(agentConfig?.model ? [{ raw: agentConfig.model, source: "agent" as const }] : []),
  ];
  return candidates.find((candidate) => resolvePrimaryStringValue(candidate.raw));
}

export function resolveSubagentModelFallbacksOverride(
  cfg: OpenClawConfig,
  agentId: string,
): string[] | undefined {
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const subagentFallbacks = resolveSelectedModelFallbacksOverride(agentConfig?.subagents?.model);
  if (subagentFallbacks !== undefined) {
    return subagentFallbacks;
  }
  const selection = resolveSubagentModelConfigSelectionResult({ cfg, agentId });
  if (selection?.source === "agent") {
    return resolveSelectedModelFallbacksOverride(agentConfig?.model);
  }
  if (selection?.source === "default-subagent") {
    return resolveSelectedModelFallbacksOverride(cfg.agents?.defaults?.subagents?.model);
  }
  return undefined;
}

export function resolveSubagentSpawnModelFallbacksOverride(
  cfg: OpenClawConfig,
  agentId: string,
): string[] | undefined {
  const agentConfig = resolveAgentConfig(cfg, agentId);
  return resolveFirstModelFallbacksOverride([
    agentConfig?.subagents?.model,
    cfg.agents?.defaults?.subagents?.model,
    agentConfig?.model,
  ]);
}

export function resolveRunModelFallbacksOverride(params: {
  cfg: OpenClawConfig | undefined;
  agentId?: string | null;
  sessionKey?: string | null;
}): string[] | undefined {
  if (!params.cfg) {
    return undefined;
  }
  const explicitAgentId = normalizeOptionalString(params.agentId);
  const agentId = explicitAgentId
    ? normalizeAgentId(explicitAgentId)
    : listAgentIds(params.cfg).length > 0
      ? resolveSessionAgentIds({
          config: params.cfg,
          sessionKey: params.sessionKey ?? undefined,
        }).sessionAgentId
      : undefined;
  return agentId ? resolveAgentModelFallbacksOverride(params.cfg, agentId) : undefined;
}

export type ModelFallbackAvailability =
  // `source` records whether an explicit fallbacks override owns the ladder or the
  // models were inherited from defaults; the run-override projection depends on it.
  | { kind: "active"; models: string[]; source: "explicit" | "inherited" }
  | { kind: "none_configured"; source: "explicit" | "inherited" }
  | { kind: "disabled_by_model_override" }
  | { kind: "disabled_by_model_selection_lock" };

function modelFallbackAvailabilityFromModels(
  models: string[],
  source: "explicit" | "inherited",
): ModelFallbackAvailability {
  return models.length > 0
    ? { kind: "active", models, source }
    : { kind: "none_configured", source };
}

/**
 * Projects availability onto the candidate-resolver override contract. Inherited
 * availability must project to `undefined`: the resolver then owns the ladder — it
 * re-derives the same configured fallbacks and appends the configured primary as the
 * final candidate (see model-fallback-candidates.ts). Collapsing inherited state into
 * an explicit list silently drops that last hop.
 */
export function modelFallbackOverrideFromAvailability(
  availability: ModelFallbackAvailability,
): string[] | undefined {
  switch (availability.kind) {
    case "active":
      return availability.source === "inherited" ? undefined : availability.models;
    case "none_configured":
      return availability.source === "inherited" ? undefined : [];
    default:
      return [];
  }
}

/** Resolve configured ladders; the session selection owner authorizes their use. */
export function resolveModelFallbackAvailability(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string | null;
  modelSelectionLocked?: boolean;
  modelFallbacksOverride?: string[];
  /** Declared child lineage includes visible sessions with dashboard keys. */
  subagentSpawnLineage?: boolean;
}): ModelFallbackAvailability {
  if (params.modelSelectionLocked) {
    return { kind: "disabled_by_model_selection_lock" };
  }
  if (params.modelFallbacksOverride !== undefined) {
    return modelFallbackAvailabilityFromModels(params.modelFallbacksOverride, "explicit");
  }
  const useSubagentFallbacks =
    !isSubagentSessionKey(params.sessionKey) && params.subagentSpawnLineage === true;
  const fallbacksOverride = useSubagentFallbacks
    ? resolveSubagentSpawnModelFallbacksOverride(params.cfg, params.agentId)
    : resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
  const source = fallbacksOverride !== undefined ? "explicit" : "inherited";
  return modelFallbackAvailabilityFromModels(
    fallbacksOverride ?? resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model),
    source,
  );
}

export function resolveEffectiveModelFallbacks(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string | null;
  subagentSpawnLineage?: boolean;
}): string[] | undefined {
  return modelFallbackOverrideFromAvailability(resolveModelFallbackAvailability(params));
}

export function resolveAgentIdByWorkspacePath(
  cfg: OpenClawConfig,
  workspacePath: string,
): string | undefined {
  const normalizedWorkspacePath = resolveCanonicalWorkspacePath(workspacePath.replaceAll("\0", ""));
  return withAgentRosterFactsBatch(cfg, () => {
    let matchedAgentId: string | undefined;
    let matchedWorkspaceLength = -1;

    for (const id of listAgentIds(cfg)) {
      const workspaceDir = resolveCanonicalWorkspacePath(resolveAgentWorkspaceDir(cfg, id));
      if (!isPathInside(workspaceDir, normalizedWorkspacePath)) {
        continue;
      }
      if (workspaceDir.length > matchedWorkspaceLength) {
        matchedAgentId = id;
        matchedWorkspaceLength = workspaceDir.length;
      }
    }
    return matchedAgentId;
  });
}
