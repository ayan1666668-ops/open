import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexPluginDestructiveApprovalMode } from "./config.js";
import { readCodexMcpToolConnectorId } from "./mcp-tool-metadata.js";
import type { CodexAppPolicyContextEntry } from "./plugin-thread-config.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

const CODEX_APPS_MCP_SERVER = "codex_apps";
const MCP_STATUS_PAGE_SIZE = 100;
const MCP_STATUS_MAX_PAGES = 100;

export type CodexAppToolApprovalMode = "auto" | "prompt" | "writes" | "approve";
export type CodexAppToolMetadata = {
  title?: string;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
};
type CodexAppToolPolicyRequest = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export function normalizeAppToolApprovalMode(value: unknown): CodexAppToolApprovalMode | undefined {
  return value === "auto" || value === "prompt" || value === "writes" || value === "approve"
    ? value
    : undefined;
}

export async function readCodexAppToolsByApp(params: {
  request: CodexAppToolPolicyRequest;
  threadId?: string;
}): Promise<Map<string, Map<string, CodexAppToolMetadata>>> {
  const toolsByApp = new Map<string, Map<string, CodexAppToolMetadata>>();
  const seenCursors = new Set<string>();
  let cursor: string | null | undefined;
  for (let page = 0; page < MCP_STATUS_MAX_PAGES; page += 1) {
    const response = await params.request("mcpServerStatus/list", {
      ...(params.threadId ? { threadId: params.threadId } : {}),
      detail: "toolsAndAuthOnly",
      limit: MCP_STATUS_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    if (!isJsonObject(response) || !Array.isArray(response.data)) {
      throw new Error("Codex mcpServerStatus/list returned invalid app tool inventory");
    }
    for (const status of response.data) {
      if (!isJsonObject(status) || !isJsonObject(status.tools)) {
        throw new Error("Codex app tool inventory contained an invalid server status");
      }
      if (status.name !== CODEX_APPS_MCP_SERVER) {
        continue;
      }
      for (const [toolName, tool] of Object.entries(status.tools)) {
        const connectorId = readCodexMcpToolConnectorId(tool);
        if (connectorId) {
          const tools = toolsByApp.get(connectorId) ?? new Map<string, CodexAppToolMetadata>();
          const metadata = asOptionalRecord(tool);
          const annotations = asOptionalRecord(metadata?.annotations);
          tools.set(toolName, {
            title: typeof metadata?.title === "string" ? metadata.title : undefined,
            destructiveHint: annotations?.destructiveHint === false ? false : undefined,
            openWorldHint: annotations?.openWorldHint === false ? false : undefined,
          });
          toolsByApp.set(connectorId, tools);
        }
      }
    }
    if (
      response.nextCursor !== undefined &&
      response.nextCursor !== null &&
      typeof response.nextCursor !== "string"
    ) {
      throw new Error("Codex app tool inventory returned an invalid pagination cursor");
    }
    cursor = response.nextCursor;
    if (!cursor) {
      return toolsByApp;
    }
    if (seenCursors.has(cursor)) {
      throw new Error("Codex app connector inventory repeated its pagination cursor");
    }
    seenCursors.add(cursor);
  }
  throw new Error("Codex app connector inventory exceeded its bounded page limit");
}

export function readCodexAppToolPolicy(
  config: Record<string, unknown>,
  appId: string,
  toolName: string,
  metadata: CodexAppToolMetadata | undefined,
  fallbackApprovalMode: CodexAppToolApprovalMode = "auto",
): { enabled: boolean; approvalMode: CodexAppToolApprovalMode } {
  const apps = asOptionalRecord(config.apps);
  const app = asOptionalRecord(apps?.[appId]);
  const defaults = asOptionalRecord(apps?.["_default"]);
  const tools = asOptionalRecord(app?.tools);
  // Codex selects the full-name entry before the title entry, not each field
  // independently. Preserve that precedence for both enablement and approval.
  const tool = asOptionalRecord(
    tools?.[toolName] ?? (metadata?.title !== undefined ? tools?.[metadata.title] : undefined),
  );
  const defaultToolsEnabled = app?.default_tools_enabled;
  return {
    enabled:
      (app ? app.enabled !== false : defaults?.enabled !== false) &&
      (typeof tool?.enabled === "boolean"
        ? tool.enabled
        : typeof defaultToolsEnabled === "boolean"
          ? defaultToolsEnabled
          : codexAppToolHintsAllowed(metadata, {
              allowDestructiveActions:
                (app?.destructive_enabled ?? defaults?.destructive_enabled) !== false,
              allowOpenWorld: (app?.open_world_enabled ?? defaults?.open_world_enabled) !== false,
            })),
    approvalMode:
      normalizeAppToolApprovalMode(tool?.approval_mode) ??
      normalizeAppToolApprovalMode(app?.default_tools_approval_mode) ??
      normalizeAppToolApprovalMode(defaults?.default_tools_approval_mode) ??
      fallbackApprovalMode,
  };
}

export function codexAppToolHintsAllowed(
  tool: CodexAppToolMetadata | undefined,
  policy: Pick<CodexAppPolicyContextEntry, "allowDestructiveActions" | "allowOpenWorld">,
): boolean {
  // Codex treats missing annotations as destructive/open-world. Explicit tool
  // enablement bypasses its app flags, so enforce the stored cap before projecting it.
  return (
    (policy.allowDestructiveActions || tool?.destructiveHint === false) &&
    (policy.allowOpenWorld !== false || tool?.openWorldHint === false)
  );
}

/** Applies the OpenClaw category ceiling before native approval policy is considered. */
export function buildCodexAppToolEligibilityOverrides(
  config: Record<string, unknown>,
  appId: string,
  tools: ReadonlyMap<string, CodexAppToolMetadata>,
  policy: Pick<CodexAppPolicyContextEntry, "allowDestructiveActions" | "allowOpenWorld">,
): JsonObject {
  const apps = asOptionalRecord(config.apps);
  const nativeApp = asOptionalRecord(apps?.[appId]);
  const nativeTools = asOptionalRecord(nativeApp?.tools);
  // Admission already resolves explicit app denials. Evaluate tool defaults
  // under the same enabled/category settings that OpenClaw sends to Codex.
  const admittedConfig = {
    apps: {
      ...apps,
      [appId]: {
        ...nativeApp,
        enabled: true,
        destructive_enabled: policy.allowDestructiveActions,
        open_world_enabled: policy.allowOpenWorld !== false,
      },
    },
  };
  // Native explicit enablement outranks category flags. Close default and saved
  // alias/retired-key routes, then admit only the current exact native tool names.
  const overrides = new Map<string, JsonObject>(
    Object.keys(nativeTools ?? {}).map((name) => [name, { enabled: false }]),
  );
  for (const [name, metadata] of tools) {
    const selected = asOptionalRecord(
      nativeTools?.[name] ??
        (metadata.title !== undefined ? nativeTools?.[metadata.title] : undefined),
    );
    const approvalMode = normalizeAppToolApprovalMode(selected?.approval_mode);
    overrides.set(name, {
      enabled:
        readCodexAppToolPolicy(admittedConfig, appId, name, metadata).enabled &&
        codexAppToolHintsAllowed(metadata, policy),
      // Adding a full-name row shadows the whole title row in Codex, including
      // its approval mode. Carry that field forward without pinning app defaults.
      ...(approvalMode !== undefined ? { approval_mode: approvalMode } : {}),
    });
  }
  return {
    default_tools_enabled: false,
    tools: Object.fromEntries(
      [...overrides].toSorted(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

export function buildDisabledAppsConfigPatch(): JsonObject & { apps: JsonObject } {
  return {
    "features.apps": false,
    apps: {
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
    },
  };
}

export function disableUnlistedCodexApps(
  configPatch: { apps: JsonObject },
  nativeConfig: Record<string, unknown>,
): JsonObject & { apps: JsonObject } {
  const apps = { ...configPatch.apps };
  // Native app.enabled wins over _default. Bindings store admitted apps only,
  // so every configured app outside that allowlist needs an explicit denial.
  for (const id of Object.keys(isJsonObject(nativeConfig.apps) ? nativeConfig.apps : {})) {
    if (id !== "_default" && !Object.hasOwn(apps, id)) {
      apps[id] = { enabled: false };
    }
  }
  return { ...configPatch, apps };
}

export function requiresCodexAppToolEligibility(policy: {
  allowDestructiveActions: boolean;
  allowOpenWorld?: boolean;
}): boolean {
  return !policy.allowDestructiveActions || policy.allowOpenWorld === false;
}

export function buildCodexAppPolicyConfig(
  policy: {
    allowDestructiveActions: boolean;
    allowOpenWorld?: boolean;
    destructiveApprovalMode?: CodexPluginDestructiveApprovalMode;
  },
  approvalOverrides: JsonObject = {},
): JsonObject {
  return {
    ...approvalOverrides,
    // Bound policy alone cannot attest native per-tool enablement. The current
    // metadata projection below re-enables restricted apps before admission.
    enabled: !requiresCodexAppToolEligibility(policy),
    destructive_enabled: policy.allowDestructiveActions,
    open_world_enabled: policy.allowOpenWorld !== false,
    // Native app/link/tool approval settings merge underneath this patch. Only
    // explicit ask replaces them, so native prompt and approve modes survive replay.
    ...(policy.destructiveApprovalMode === "ask"
      ? { default_tools_approval_mode: "auto", approvals_reviewer: "user" }
      : {}),
  };
}
