import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveRailwaySandboxConfig } from "./config.js";
import { assessLocalCommand } from "./shell-classifier.js";

const LOCAL_EXEC_HOSTS = new Set(["", "auto", "gateway", "sandbox"]);
const GENERATED_PATH_SEGMENTS = new Set([
  ".gradle",
  ".next",
  ".nuxt",
  ".pnpm-store",
  ".pytest_cache",
  ".turbo",
  ".yarn",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

type PluginHookBeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  derivedPaths?: readonly string[];
};

type PluginHookToolContext = {
  agentId?: string;
};

type PolicyDecision =
  | { block: true; blockReason: string }
  | undefined;

function isEnforcedAgent(agentId: string | undefined, agents: readonly string[]): boolean {
  return Boolean(agentId && agents.includes(agentId));
}

function isLocalExecHost(value: unknown): boolean {
  return LOCAL_EXEC_HOSTS.has((typeof value === "string" ? value.trim().toLowerCase() : "") || "");
}

function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

function isGeneratedPath(path: string): boolean {
  return pathSegments(path).some((segment) => GENERATED_PATH_SEGMENTS.has(segment));
}

function pathsForTool(event: PluginHookBeforeToolCallEvent): string[] {
  if (event.derivedPaths && event.derivedPaths.length > 0) {
    return [...event.derivedPaths];
  }
  const params = event.params;
  const path = normalizeOptionalString(params.path) ?? normalizeOptionalString(params.file_path) ?? normalizeOptionalString(params.destination);
  return path ? [path] : [];
}

export function evaluateHeavyLocalWorkBoundary(
  api: Pick<OpenClawPluginApi, "pluginConfig">,
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
): PolicyDecision {
  const cfg = resolveRailwaySandboxConfig(api);
  if (!isEnforcedAgent(ctx.agentId, cfg.enforceAgents)) {
    return undefined;
  }

  if (event.toolName === "exec") {
    if (!cfg.enforceHeavyLocalExec || !isLocalExecHost(event.params.host)) {
      return undefined;
    }
    const command = normalizeOptionalString(event.params.command);
    if (!command) {
      return {
        block: true,
        blockReason: `Local exec blocked for ${ctx.agentId}: empty or non-string commands are not approved local routes. Use railway_sandbox plus railway_exec instead; no command was run locally.`,
      };
    }
    const assessment = assessLocalCommand(command);
    if (assessment.allowed) {
      return undefined;
    }
    return {
      block: true,
      blockReason: `Local exec blocked for ${ctx.agentId}: ${assessment.reason ?? "not an approved local route"}. Use railway_sandbox plus railway_exec instead; this command was not run locally.`,
    };
  }

  if (!cfg.protectGeneratedPaths) {
    return undefined;
  }
  if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "apply_patch") {
    const generated = pathsForTool(event).find(isGeneratedPath);
    if (generated) {
      return {
        block: true,
        blockReason: `Gateway dependency/build tree write blocked for ${ctx.agentId}: ${generated}. Use railway_file inside a Railway sandbox for generated outputs.`,
      };
    }
  }
  return undefined;
}
