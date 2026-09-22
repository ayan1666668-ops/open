// Gateway observation for `plugins inspect --runtime`.
// A CLI module load is not the running Gateway's plugin registry.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { READ_SCOPE } from "../gateway/operator-scopes.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readActiveGatewayLockIdentity } from "../infra/gateway-lock.js";
import { redactSensitiveText } from "../logging/redact.js";

const PLUGIN_INSPECT_GATEWAY_TIMEOUT_MS = 30_000;
const GATEWAY_RUNTIME_ERROR_LIMIT = 300;

export const PLUGIN_INSPECT_NO_GATEWAY_DETAIL =
  "No running Gateway. Plugin runtime state was not read from the daemon.";

export const PLUGIN_INSPECT_CLI_PROCESS_NOTE =
  "plugin.status, activation, hooks, and tools describe a module load in this CLI process. They are not the running Gateway. reportedStatus and gatewayRuntime describe the Gateway.";

type GatewayCatalogRuntimeState = "unloaded" | "disabled" | "active" | "service-failed";

function isGatewayCatalogRuntimeState(state: unknown): state is GatewayCatalogRuntimeState {
  return (
    state === "unloaded" || state === "disabled" || state === "active" || state === "service-failed"
  );
}

type GatewayCatalogEntry = {
  state: GatewayCatalogRuntimeState | "unreported";
  error?: string;
};

export type PluginInspectGatewayRuntime =
  | {
      source: "gateway";
      reachable: false;
      state: "unreachable";
      detail: string;
    }
  | {
      source: "gateway";
      reachable: true;
      state: GatewayCatalogRuntimeState | "absent" | "unreported";
      generation?: number;
      detail: string;
      error?: string;
    };

export type PluginInspectGatewayRuntimeReport =
  | { kind: "unreachable"; detail: string }
  | {
      kind: "catalog";
      generation?: number;
      byPluginId: ReadonlyMap<string, GatewayCatalogEntry>;
      byLowerPluginId: ReadonlyMap<string, GatewayCatalogEntry>;
    };

function unreachableReport(detail: string): PluginInspectGatewayRuntimeReport {
  return { kind: "unreachable", detail };
}

function describeFailure(summary: string, error: unknown): string {
  const reason = formatErrorMessage(error).replace(/\s+/g, " ").trim();
  if (!reason) {
    return summary;
  }
  return `${summary} ${reason.slice(0, GATEWAY_RUNTIME_ERROR_LIMIT)}`;
}

function readOptionalGeneration(payload: Record<string, unknown>): number | undefined {
  const generation = payload.generation;
  return typeof generation === "number" && Number.isInteger(generation) && generation >= 0
    ? generation
    : undefined;
}

function readRuntimeError(runtime: Record<string, unknown>): string | undefined {
  const error = runtime.error;
  if (typeof error !== "string") {
    return undefined;
  }
  const redacted = redactSensitiveText(error).replace(/\s+/g, " ").trim();
  return redacted.length > 0 ? redacted.slice(0, GATEWAY_RUNTIME_ERROR_LIMIT) : undefined;
}

function readCatalogEntry(plugin: unknown): { id: string; entry: GatewayCatalogEntry } | undefined {
  if (!isRecord(plugin) || typeof plugin.id !== "string" || plugin.id.length === 0) {
    return undefined;
  }
  const runtime = isRecord(plugin.runtime) ? plugin.runtime : undefined;
  const state = runtime?.state;
  if (isGatewayCatalogRuntimeState(state)) {
    const error = runtime ? readRuntimeError(runtime) : undefined;
    return {
      id: plugin.id,
      entry: {
        state,
        ...(error ? { error } : {}),
      },
    };
  }
  return { id: plugin.id, entry: { state: "unreported" } };
}

function catalogReportFromPayload(payload: unknown): PluginInspectGatewayRuntimeReport {
  if (!isRecord(payload) || !Array.isArray(payload.plugins)) {
    return unreachableReport(
      "Gateway unreachable. The plugin list did not include a runtime catalog.",
    );
  }
  const byPluginId = new Map<string, GatewayCatalogEntry>();
  const byLowerPluginId = new Map<string, GatewayCatalogEntry>();
  for (const plugin of payload.plugins) {
    const parsed = readCatalogEntry(plugin);
    if (!parsed || byPluginId.has(parsed.id)) {
      continue;
    }
    byPluginId.set(parsed.id, parsed.entry);
    const lower = parsed.id.toLowerCase();
    if (!byLowerPluginId.has(lower)) {
      byLowerPluginId.set(lower, parsed.entry);
    }
  }
  const generation = readOptionalGeneration(payload);
  return {
    kind: "catalog",
    ...(generation !== undefined ? { generation } : {}),
    byPluginId,
    byLowerPluginId,
  };
}

/** Read the local Gateway's plugin runtime, or an explicit unreachable result. */
export async function readPluginsInspectGatewayRuntime(
  config: OpenClawConfig,
): Promise<PluginInspectGatewayRuntimeReport> {
  let owner: Awaited<ReturnType<typeof readActiveGatewayLockIdentity>>;
  try {
    owner = await readActiveGatewayLockIdentity();
  } catch (error) {
    return unreachableReport(
      describeFailure(
        "The Gateway lock could not be read. Plugin runtime state was not read from the daemon.",
        error,
      ),
    );
  }
  if (!owner) {
    return unreachableReport(PLUGIN_INSPECT_NO_GATEWAY_DETAIL);
  }
  try {
    const { callGateway } = await import("../gateway/call.js");
    const payload = await callGateway<unknown>({
      config,
      method: "plugins.list",
      params: {},
      localPortOverride: owner.port,
      ignoreEnvUrlOverride: true,
      timeoutMs: PLUGIN_INSPECT_GATEWAY_TIMEOUT_MS,
      scopes: [READ_SCOPE],
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
      requiredMethods: ["plugins.list"],
      sharedStateMode: "read-only",
    });
    return catalogReportFromPayload(payload);
  } catch (error) {
    return unreachableReport(
      describeFailure(
        "Gateway unreachable. Plugin runtime state was not read from the daemon.",
        error,
      ),
    );
  }
}

function catalogDetail(
  state: GatewayCatalogEntry["state"] | "absent",
  error: string | undefined,
): string {
  switch (state) {
    case "active":
      return "The running Gateway has loaded this plugin.";
    case "unloaded":
      return "The running Gateway has not loaded this plugin.";
    case "disabled":
      return "The running Gateway reports this plugin as disabled.";
    case "service-failed":
      return error
        ? `The running Gateway loaded this plugin, but a service failed: ${error}`
        : "The running Gateway loaded this plugin, but a service failed.";
    case "absent":
      return "The running Gateway catalog does not include this plugin.";
    case "unreported":
      return "The running Gateway did not report a runtime state for this plugin.";
  }
  // Exhaustive over catalog states; the return satisfies consistent-return.
  return state satisfies never;
}

/** Resolve one plugin's Gateway observation from a list query. */
export function gatewayRuntimeForPlugin(
  report: PluginInspectGatewayRuntimeReport,
  pluginId: string,
): PluginInspectGatewayRuntime {
  if (report.kind === "unreachable") {
    return {
      source: "gateway",
      reachable: false,
      state: "unreachable",
      detail: report.detail,
    };
  }
  const entry =
    report.byPluginId.get(pluginId) ?? report.byLowerPluginId.get(pluginId.toLowerCase());
  const state = entry?.state ?? "absent";
  const error = entry?.error;
  return {
    source: "gateway",
    reachable: true,
    state,
    ...(report.generation !== undefined ? { generation: report.generation } : {}),
    detail: catalogDetail(state, error),
    ...(error ? { error } : {}),
  };
}

/** Operator status for the running Gateway. `loaded` means the Gateway reports active. */
export function reportedPluginGatewayStatus(runtime: PluginInspectGatewayRuntime): string {
  if (!runtime.reachable) {
    return "unreachable";
  }
  switch (runtime.state) {
    case "active":
      return "loaded";
    case "absent":
      return "not-loaded";
    case "unreported":
      return "unknown";
    default:
      return runtime.state;
  }
}
