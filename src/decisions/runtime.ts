import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import {
  resolveDecisionModelSetting,
  resolveRawDecisionModelSetting,
} from "../agents/decision-model-setting.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginHostCleanupTimeout } from "../plugins/host-hook-cleanup-timeout.js";
import {
  capturePluginLifecycleAuthority,
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
  getPluginRegistryResourceOwner,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import type { DecisionProviderHost } from "./provider-host.js";
import type {
  DecisionBatch,
  DecisionInspection,
  DecisionOutcome,
  DecisionRuntimeV1,
} from "./types.js";
import { DecisionContractError, validateDecisionBatch } from "./validation.js";

type Options = Parameters<DecisionRuntimeV1["evaluate"]>[1];

/** Core calls carry their owner's abort signal; plugin callers additionally bind their exact instance. */
export async function evaluateDecision(
  batch: DecisionBatch,
  options: Options,
): Promise<DecisionOutcome> {
  return evaluateDecisionInRegistry(
    batch,
    options,
    getPluginRegistryForContext(),
    getRuntimeConfig(),
  );
}

export async function evaluateDecisionInRegistry(
  batch: DecisionBatch,
  options: Options,
  registry: PluginRegistry | null,
  config: OpenClawConfig,
  consumerId?: string,
): Promise<DecisionOutcome> {
  if (
    !options ||
    (options.agentId !== undefined &&
      (typeof options.agentId !== "string" || !options.agentId.trim())) ||
    typeof options.purpose !== "string" ||
    !options.purpose ||
    options.purpose.length > 128 ||
    typeof options.rubricVersion !== "string" ||
    !options.rubricVersion ||
    options.rubricVersion.length > 128 ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    !(options.signal instanceof AbortSignal)
  ) {
    throw new DecisionContractError();
  }
  options.signal.throwIfAborted();
  if (!validateDecisionBatch(batch)) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const selected = resolveDecisionModelSetting(config, options.agentId);
  if (!selected) {
    return { status: "unavailable", reason: "disabled" };
  }
  if (config.plugins?.enabled === false) {
    return { status: "unavailable", reason: "disabled" };
  }
  const entry = registry?.decisionProviders.find(
    (candidate) => candidate.host.provider.id === selected.provider,
  );
  if (!entry || !registry) {
    return { status: "unavailable", reason: "not-configured" };
  }
  if (config.plugins?.entries?.[entry.pluginId]?.enabled === false) {
    return entry.host.unavailable("disabled");
  }
  // Root callers carry their own work signal: provider replacement may still allow fallback.
  // Prepared views additionally lose consumer authority when their finite view is released.
  if (getPluginRegistryResourceOwner(registry) === getPluginRegistryState()?.activeRegistry) {
    return entry.host.evaluate(batch, options, selected.model, config, registry, consumerId);
  }
  const authority = capturePluginLifecycleAuthority(registry, undefined, { scopedRuntime: true });
  const lifetime = capturePluginRegistryLifecycleSignal(
    registry,
    capturePluginRegistryLifecycleEpoch(registry),
    { scopedRuntime: true },
  );
  if (!authority?.() || !lifetime) {
    throw new Error("Decision consumer authority closed.");
  }
  const signal = AbortSignal.any([options.signal, lifetime]);
  const result = await entry.host.evaluate(
    batch,
    { ...options, signal },
    selected.model,
    config,
    registry,
    consumerId,
  );
  signal.throwIfAborted();
  if (!authority()) {
    throw new Error("Decision consumer authority closed.");
  }
  return result;
}

export function inspectDecisionInRegistry(
  config: OpenClawConfig,
  registry: PluginRegistry | null,
  agentId?: string,
): DecisionInspection {
  const agentConfig = agentId ? resolveAgentConfig(config, agentId) : undefined;
  const rawSelection = resolveRawDecisionModelSetting(config, agentId);
  const origin: "agent-override" | "default" =
    agentId && agentConfig?.decisionModel !== undefined ? "agent-override" : "default";
  const selection = resolveDecisionModelSetting(config, agentId);
  if (!selection) {
    return {
      selection: { status: "none", origin: rawSelection === "" ? "explicit-disablement" : "none" },
      availability: { status: "unknown", reason: "no-selection" },
    };
  }
  const entry = registry?.decisionProviders.find(
    (candidate) => candidate.host.provider.id === selection.provider,
  );
  const selected = {
    status: "selected" as const,
    provider: selection.provider,
    model: selection.model,
    origin,
  };
  if (!entry || !registry) {
    return {
      selection: selected,
      availability: { status: "unknown", reason: "not-configured" },
    };
  }
  const host = entry.host.inspect(config);
  if (
    config.plugins?.enabled === false ||
    config.plugins?.entries?.[entry.pluginId]?.enabled === false
  ) {
    return {
      selection: selected,
      provider: {
        id: entry.host.provider.id,
        pluginId: entry.pluginId,
        capabilities: entry.host.capabilities(),
      },
      availability: { status: "blocked", reason: "disabled" },
    };
  }
  if (!host.configured) {
    return {
      selection: selected,
      provider: {
        id: entry.host.provider.id,
        pluginId: entry.pluginId,
        capabilities: entry.host.capabilities(),
      },
      availability: { status: "unknown", reason: "not-configured" },
    };
  }
  if (!host.credentialReady) {
    return {
      selection: selected,
      provider: {
        id: entry.host.provider.id,
        pluginId: entry.pluginId,
        capabilities: entry.host.capabilities(),
      },
      availability: {
        status: "blocked",
        reason: host.blocker ?? "credentials-unavailable",
      },
    };
  }
  if (!host.callable) {
    const reason = host.blocker ?? "retiring";
    return {
      selection: selected,
      provider: {
        id: entry.host.provider.id,
        pluginId: entry.pluginId,
        capabilities: entry.host.capabilities(),
      },
      availability: { status: "blocked", reason },
    };
  }
  return {
    selection: selected,
    provider: {
      id: entry.host.provider.id,
      pluginId: entry.pluginId,
      capabilities: entry.host.capabilities(),
    },
    availability: { status: "available" },
  };
}

export function inspectDecision(config: OpenClawConfig, agentId?: string): DecisionInspection {
  return inspectDecisionInRegistry(config, getPluginRegistryForContext(), agentId);
}

/** Abort before dependent consumers drain. Services subsequently join actual physical settlement. */
export function prepareDecisionProviderReload(
  registry: PluginRegistry,
  changedPluginIds: ReadonlySet<string>,
) {
  const paused: ReturnType<DecisionProviderHost["pauseForReload"]>[] = [];
  for (const entry of registry.decisionProviders) {
    if (changedPluginIds.has(entry.pluginId)) {
      paused.push(entry.host.pauseForReload(changedPluginIds));
    } else {
      for (const pluginId of changedPluginIds) {
        entry.host.cancelConsumer(pluginId);
      }
    }
  }
  return {
    async rollback(signal: AbortSignal) {
      // Timeout only observes settlement: no detached continuation may reopen admission.
      await withPluginHostCleanupTimeout("decision reload rollback", () =>
        Promise.all(paused.map((pause) => pause.settled)),
      );
      signal.throwIfAborted();
      for (const pause of paused) {
        pause.assertResumable();
      }
      for (const pause of paused) {
        pause.resume();
      }
    },
  };
}

export function inspectDecisionProviders(
  config: OpenClawConfig,
  registry = getPluginRegistryForContext(),
) {
  return registry?.decisionProviders.map((entry) => entry.host.inspect(config)) ?? [];
}
