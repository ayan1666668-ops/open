import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";

export type RailwaySandboxResources = {
  cpu: number;
  memoryGB: number;
};

export type RailwaySandboxConfig = {
  environmentId?: string;
  cliCommand: string;
  defaultIdleTimeoutMinutes: number;
  maxIdleTimeoutMinutes: number;
  defaultResources: RailwaySandboxResources;
  maxResources: RailwaySandboxResources;
  enforceAgents: readonly string[];
  enforceHeavyLocalExec: boolean;
  protectGeneratedPaths: boolean;
};

const HARD_MAX_IDLE_TIMEOUT_MINUTES = 10;
const HARD_MAX_CPU = 4;
const HARD_MAX_MEMORY_GB = 8;
const DEFAULT_CPU = 1;
const DEFAULT_MEMORY_GB = 1;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readPositiveNumber(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

function readPositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

function readResources(
  value: unknown,
  fallback: RailwaySandboxResources,
  max: RailwaySandboxResources,
): RailwaySandboxResources {
  const record = asRecord(value);
  return {
    cpu: readPositiveNumber(record.cpu, fallback.cpu, Math.min(max.cpu, HARD_MAX_CPU)),
    memoryGB: readPositiveNumber(
      record.memoryGB,
      fallback.memoryGB,
      Math.min(max.memoryGB, HARD_MAX_MEMORY_GB),
    ),
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

export function resolveRailwaySandboxConfig(api: Pick<OpenClawPluginApi, "config">): RailwaySandboxConfig {
  const root = asRecord(api.config);
  const cfg = asRecord(root.railwaySandbox);
  const maxResources = readResources(cfg.maxResources, { cpu: HARD_MAX_CPU, memoryGB: HARD_MAX_MEMORY_GB }, {
    cpu: HARD_MAX_CPU,
    memoryGB: HARD_MAX_MEMORY_GB,
  });
  const defaultResources = readResources(
    cfg.defaultResources,
    { cpu: DEFAULT_CPU, memoryGB: DEFAULT_MEMORY_GB },
    maxResources,
  );
  const maxIdleTimeoutMinutes = readPositiveInteger(
    cfg.maxIdleTimeoutMinutes,
    HARD_MAX_IDLE_TIMEOUT_MINUTES,
    HARD_MAX_IDLE_TIMEOUT_MINUTES,
  );
  return {
    environmentId: typeof cfg.environmentId === "string" ? cfg.environmentId.trim() || undefined : undefined,
    cliCommand: typeof cfg.cliCommand === "string" && cfg.cliCommand.trim() ? cfg.cliCommand.trim() : "railway",
    defaultIdleTimeoutMinutes: readPositiveInteger(
      cfg.defaultIdleTimeoutMinutes,
      Math.min(10, maxIdleTimeoutMinutes),
      maxIdleTimeoutMinutes,
    ),
    maxIdleTimeoutMinutes,
    defaultResources,
    maxResources,
    enforceAgents: readStringArray(cfg.enforceAgents),
    enforceHeavyLocalExec: cfg.enforceHeavyLocalExec === true,
    protectGeneratedPaths: cfg.protectGeneratedPaths !== false,
  };
}

export function requireRailwayEnvironmentId(config: RailwaySandboxConfig): string {
  if (!config.environmentId) {
    throw new Error("railwaySandbox.environmentId is required before Railway sandbox tools can run");
  }
  return config.environmentId;
}

export function clampIdleTimeoutMinutes(input: unknown, config: RailwaySandboxConfig): number {
  return readPositiveInteger(input, config.defaultIdleTimeoutMinutes, config.maxIdleTimeoutMinutes);
}

export function clampResources(input: unknown, config: RailwaySandboxConfig): RailwaySandboxResources {
  return readResources(input, config.defaultResources, config.maxResources);
}
