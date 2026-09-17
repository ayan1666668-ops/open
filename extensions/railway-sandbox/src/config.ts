import { asFiniteNumberInRange, asSafeIntegerInRange } from "openclaw/plugin-sdk/number-runtime";
import {
  asNonArrayRecord,
  normalizeOptionalString,
  normalizeTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";

export type RailwaySandboxResources = {
  cpu: number;
  memoryGB: number;
};

export type RailwaySandboxConfig = {
  environmentId?: string;
  apiToken?: string;
  apiEndpoint: string;
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
const DEFAULT_RAILWAY_API_ENDPOINT = "https://backboard.railway.com/graphql/v2";

function positiveNumberOrDefault(value: unknown, fallback: number, max: number): number {
  return asFiniteNumberInRange(value, { min: 0, minExclusive: true, max }) ?? fallback;
}

function positiveIntegerOrDefault(value: unknown, fallback: number, max: number): number {
  return asSafeIntegerInRange(value, { min: 1, max }) ?? fallback;
}

function readResources(
  value: unknown,
  fallback: RailwaySandboxResources,
  max: RailwaySandboxResources,
): RailwaySandboxResources {
  const record = asNonArrayRecord(value);
  return {
    cpu: positiveNumberOrDefault(record.cpu, fallback.cpu, Math.min(max.cpu, HARD_MAX_CPU)),
    memoryGB: positiveNumberOrDefault(
      record.memoryGB,
      fallback.memoryGB,
      Math.min(max.memoryGB, HARD_MAX_MEMORY_GB),
    ),
  };
}

function resolvePluginConfigRoot(api: Pick<OpenClawPluginApi, "pluginConfig">): Record<string, unknown> {
  const pluginConfig = asNonArrayRecord(api.pluginConfig);
  // The published plugin config is direct under plugins.entries.railway-sandbox.config.
  // Accepting an inner railwaySandbox object keeps pre-review local experiments readable without
  // falling back to the global Gateway config surface that the plugin does not own.
  return asNonArrayRecord(pluginConfig.railwaySandbox ?? pluginConfig);
}

export function resolveRailwaySandboxConfig(api: Pick<OpenClawPluginApi, "pluginConfig">): RailwaySandboxConfig {
  const cfg = resolvePluginConfigRoot(api);
  const maxResources = readResources(cfg.maxResources, { cpu: HARD_MAX_CPU, memoryGB: HARD_MAX_MEMORY_GB }, {
    cpu: HARD_MAX_CPU,
    memoryGB: HARD_MAX_MEMORY_GB,
  });
  const defaultResources = readResources(
    cfg.defaultResources,
    { cpu: DEFAULT_CPU, memoryGB: DEFAULT_MEMORY_GB },
    maxResources,
  );
  const maxIdleTimeoutMinutes = positiveIntegerOrDefault(
    cfg.maxIdleTimeoutMinutes,
    HARD_MAX_IDLE_TIMEOUT_MINUTES,
    HARD_MAX_IDLE_TIMEOUT_MINUTES,
  );
  return {
    environmentId: normalizeOptionalString(cfg.environmentId),
    apiToken: normalizeOptionalString(cfg.apiToken),
    apiEndpoint: normalizeOptionalString(cfg.apiEndpoint) ?? DEFAULT_RAILWAY_API_ENDPOINT,
    defaultIdleTimeoutMinutes: positiveIntegerOrDefault(
      cfg.defaultIdleTimeoutMinutes,
      Math.min(10, maxIdleTimeoutMinutes),
      maxIdleTimeoutMinutes,
    ),
    maxIdleTimeoutMinutes,
    defaultResources,
    maxResources,
    enforceAgents: normalizeTrimmedStringList(Array.isArray(cfg.enforceAgents) ? cfg.enforceAgents : []),
    enforceHeavyLocalExec: cfg.enforceHeavyLocalExec === true,
    protectGeneratedPaths: cfg.protectGeneratedPaths !== false,
  };
}

export function requireRailwayEnvironmentId(config: RailwaySandboxConfig): string {
  if (!config.environmentId) {
    throw new Error("Railway sandbox environmentId is required before Railway sandbox tools can run");
  }
  return config.environmentId;
}

export function requireRailwayApiToken(config: RailwaySandboxConfig): string {
  if (!config.apiToken) {
    throw new Error(
      "Railway sandbox apiToken is required as a plugin SecretRef-backed config value before Railway sandbox tools can run",
    );
  }
  return config.apiToken;
}

export function clampIdleTimeoutMinutes(input: unknown, config: RailwaySandboxConfig): number {
  return positiveIntegerOrDefault(input, config.defaultIdleTimeoutMinutes, config.maxIdleTimeoutMinutes);
}

export function clampResources(input: unknown, config: RailwaySandboxConfig): RailwaySandboxResources {
  return readResources(input, config.defaultResources, config.maxResources);
}
