import type { CodexDynamicToolFunctionSpec } from "./protocol.js";
import type { startOrResumeThread } from "./thread-lifecycle.js";

export function createMessageDynamicTool(
  description: string,
  actions: string[] = ["send"],
): CodexDynamicToolFunctionSpec {
  return {
    type: "function",
    name: "message",
    description,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: actions,
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}

export function createNamedDynamicTool(name: string): CodexDynamicToolFunctionSpec {
  return {
    type: "function",
    name,
    description: `${name} test tool`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
}

export function createDeferredNamedDynamicTool(
  name: string,
): Parameters<typeof startOrResumeThread>[0]["dynamicTools"][number] {
  return {
    type: "namespace",
    name: "openclaw",
    description: "",
    tools: [{ ...createNamedDynamicTool(name), deferLoading: true }],
  };
}

export function createPluginAppConfigPatch(options: { approvalsReviewer?: "user" } = {}) {
  return {
    apps: {
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
      "google-calendar-app": {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
        ...(options.approvalsReviewer ? { approvals_reviewer: options.approvalsReviewer } : {}),
      },
    },
  };
}

export function createPluginAppPolicyContext() {
  return {
    fingerprint: "plugin-policy-1",
    apps: {
      "google-calendar-app": {
        configKey: "google-calendar",
        marketplaceName: "openai-curated" as const,
        pluginName: "google-calendar",
        allowDestructiveActions: true,
        mcpServerNames: ["google-calendar"],
      },
    },
    pluginAppIds: {
      "google-calendar": ["google-calendar-app"],
    },
  };
}

export function createTwoPluginAppConfigPatch() {
  return {
    apps: {
      ...createPluginAppConfigPatch().apps,
      "gmail-app": {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
      },
    },
  };
}

export function createTwoPluginAppPolicyContext() {
  return {
    fingerprint: "plugin-policy-2",
    apps: {
      ...createPluginAppPolicyContext().apps,
      "gmail-app": {
        configKey: "gmail",
        marketplaceName: "openai-curated" as const,
        pluginName: "gmail",
        allowDestructiveActions: false,
        mcpServerNames: ["gmail"],
      },
    },
    pluginAppIds: {
      ...createPluginAppPolicyContext().pluginAppIds,
      gmail: ["gmail-app"],
    },
  };
}

export function createTwoCalendarAppConfigPatch() {
  return {
    apps: {
      ...createPluginAppConfigPatch().apps,
      "google-calendar-secondary-app": {
        enabled: true,
        destructive_enabled: true,
        open_world_enabled: true,
        default_tools_approval_mode: "auto",
      },
    },
  };
}

export function createTwoCalendarAppPolicyContext() {
  return {
    fingerprint: "plugin-policy-calendar-2",
    apps: {
      ...createPluginAppPolicyContext().apps,
      "google-calendar-secondary-app": {
        configKey: "google-calendar",
        marketplaceName: "openai-curated" as const,
        pluginName: "google-calendar",
        allowDestructiveActions: false,
        mcpServerNames: ["google-calendar"],
      },
    },
    pluginAppIds: {
      "google-calendar": ["google-calendar-app", "google-calendar-secondary-app"],
    },
  };
}
