import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveRailwaySandboxConfig } from "./config.js";
import { classifyHeavyCommand } from "./shell-classifier.js";

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

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
  const path = readString(params.path) ?? readString(params.file_path) ?? readString(params.destination);
  return path ? [path] : [];
}

export function evaluateHeavyLocalWorkBoundary(
  api: Pick<OpenClawPluginApi, "config">,
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
    const command = readString(event.params.command);
    if (!command) {
      return undefined;
    }
    const classification = classifyHeavyCommand(command);
    if (!classification.heavy) {
      return undefined;
    }
    return {
      block: true,
      blockReason: `Heavy local command blocked for ${ctx.agentId}: ${classification.reason}. Use railway_sandbox plus railway_exec instead; this command was not run locally.`,
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
