import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { vi } from "vitest";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import type { CodexPluginThreadConfig } from "./plugin-thread-config.js";
import { createCodexTestModel } from "./test-support.js";
import type { startOrResumeThread } from "./thread-lifecycle.js";

export function createAttemptParams(params: {
  provider: string;
  authProfileId?: string;
  authProfileType?: "oauth" | "api_key";
  authProfileProvider?: string;
  authProfileProviders?: Record<string, string>;
  runtimeExternalProfileIds?: string[];
  bootstrapContextMode?: "full" | "lightweight";
  bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  images?: EmbeddedRunAttemptParams["images"];
  modelId?: string;
}): EmbeddedRunAttemptParams {
  const authProfileProviders =
    params.authProfileProviders ??
    (params.authProfileId
      ? { [params.authProfileId]: params.authProfileProvider ?? "openai" }
      : {});
  const authProfileType = params.authProfileType ?? "oauth";
  return {
    hostCapabilities: createCodexTestHostCapabilities(),
    provider: params.provider,
    modelId: params.modelId ?? "gpt-5.4",
    prompt: "test prompt",
    authProfileId: params.authProfileId,
    ...(params.bootstrapContextMode ? { bootstrapContextMode: params.bootstrapContextMode } : {}),
    ...(params.bootstrapContextRunKind
      ? { bootstrapContextRunKind: params.bootstrapContextRunKind }
      : {}),
    ...(params.images ? { images: params.images } : {}),
    authProfileStore: {
      version: 1,
      profiles: Object.fromEntries(
        Object.entries(authProfileProviders).map(([profileId, provider]) => [
          profileId,
          authProfileType === "api_key"
            ? {
                type: "api_key" as const,
                provider,
                key: "sk-test",
              }
            : {
                type: "oauth" as const,
                provider,
                access: "access-token",
                refresh: "refresh-token",
                expires: Date.now() + 60_000,
              },
        ]),
      ),
      ...(params.runtimeExternalProfileIds
        ? { runtimeExternalProfileIds: params.runtimeExternalProfileIds }
        : {}),
    },
  } as EmbeddedRunAttemptParams;
}

export function createAppServerOptions() {
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  };
}

export function createNetworkProxyAppServerOptions() {
  const configPatch = {
    "features.network_proxy.enabled": true,
    default_permissions: "mock-proxy",
    permissions: {
      "mock-proxy": {
        filesystem: {
          ":minimal": "read",
          ":project_roots": {
            ".": "write",
          },
        },
        network: {
          enabled: true,
          domains: {
            "api.openai.com": "allow",
          },
          allow_upstream_proxy: true,
          proxy_url: "http://127.0.0.1:3128",
        },
      },
    },
  } as const;
  return {
    ...createAppServerOptions(),
    networkProxy: {
      profileName: "mock-proxy",
      configFingerprint: "test-network-proxy",
      configPatch,
    },
  } as const;
}

export function createThreadLifecycleParams(
  sessionFile: string,
  workspaceDir: string,
): EmbeddedRunAttemptParams {
  return {
    hostCapabilities: createCodexTestHostCapabilities(),
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

export function createThreadLifecycleAppServerOptions(): Parameters<
  typeof startOrResumeThread
>[0]["appServer"] {
  return {
    start: {
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      headers: {},
    },
    codeModeOnly: false,
    loopDetectionPreToolUseRelay: true,
    requestTimeoutMs: 60_000,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    connectionClass: "local-loopback",
    remoteAppsSubstrate: "preconfigured",
  };
}

export function createProvisionalPluginThreadConfigProvider(appId: string) {
  const config: CodexPluginThreadConfig = {
    enabled: true,
    configPatch: {
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
        [appId]: {
          enabled: true,
          destructive_enabled: false,
          open_world_enabled: true,
          default_tools_approval_mode: "auto",
        },
      },
    },
    provisionalAppIds: [appId],
    fingerprint: `plugin-config-${appId}`,
    inputFingerprint: `plugin-input-${appId}`,
    policyContext: {
      fingerprint: `plugin-policy-${appId}`,
      apps: {
        [appId]: {
          configKey: "linear",
          marketplaceName: "openai-curated",
          pluginName: "linear",
          allowDestructiveActions: false,
          destructiveApprovalMode: "deny",
          mcpServerNames: [],
        },
      },
      pluginAppIds: { linear: [appId] },
    },
    diagnostics: [],
  };
  return {
    enabled: true,
    inputFingerprint: config.inputFingerprint,
    enabledPluginConfigKeys: ["linear"],
    recoverablePluginConfigKeys: ["linear"],
    build: vi.fn(async () => config),
  };
}

export function createAttestedAccountAppThreadConfigProvider(appId: string) {
  const pluginProvider = createProvisionalPluginThreadConfigProvider(appId);
  const inputFingerprint = `account-input-${appId}`;
  return {
    enabled: true,
    inputFingerprint,
    enabledPluginConfigKeys: [],
    recoverablePluginConfigKeys: [],
    accountAppRecoveryEnabled: true,
    build: vi.fn(async (): Promise<CodexPluginThreadConfig> => {
      const pluginConfig = await pluginProvider.build();
      return {
        ...pluginConfig,
        fingerprint: `account-config-${appId}`,
        inputFingerprint,
        policyContext: {
          fingerprint: `account-policy-${appId}`,
          apps: {
            [appId]: {
              source: "account",
              appName: "Account App",
              allowDestructiveActions: false,
              destructiveApprovalMode: "deny",
              mcpServerNames: [],
            },
          },
          pluginAppIds: {},
        },
      };
    }),
  };
}
