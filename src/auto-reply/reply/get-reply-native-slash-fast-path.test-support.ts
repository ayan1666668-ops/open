import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { listCliRuntimeModelBackendBindings } from "../../agents/cli-backends.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import * as preparedModelCatalog from "../../agents/prepared-model-catalog.js";
import { loadNativeHarnessFixture } from "../../agents/test-helpers/bundled-native-harness.test-support.js";
import { createSessionModelCatalogFixture } from "../../agents/test-helpers/session-model-catalog.test-support.js";
import { migrateSessionExecutionSelection } from "../../commands/doctor/shared/session-execution-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import {
  commitSessionExecutionSelection,
  resolveExecutionSelectionExecutorKind,
} from "../../model-picker/apply-session-model-selection.js";
import { sessionExecutionSelectionSchema } from "../../model-picker/execution-selection.schema.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import { usesFullReplyRuntime } from "./reply-config-runtime-mode.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

const { handleCommandsMock, buildStatusReplyMock } = vi.hoisted(() => ({
  handleCommandsMock: vi.fn(),
  buildStatusReplyMock: vi.fn(),
}));

export { handleCommandsMock, buildStatusReplyMock };

vi.mock("./commands.runtime.js", () => ({
  handleCommands: (...args: unknown[]) => handleCommandsMock(...args),
}));

vi.mock("./commands-status.js", () => ({
  buildStatusReply: (...args: unknown[]) => buildStatusReplyMock(...args),
}));

const { maybeResolveNativeSlashCommandFastReply } =
  await import("./get-reply-native-slash-fast-path.js");

export const runtimeCliBackends = [
  {
    id: "claude-cli",
    modelProvider: "anthropic",
    pluginId: "anthropic",
    config: { command: process.execPath },
    bundleMcp: false,
  },
];

const nativePluginMetadata = createPluginMetadataSnapshotFixture({
  plugins: [{ id: "anthropic", cliBackends: ["claude-cli"], syntheticAuthRefs: ["claude-cli"] }],
});

const nativeCatalog: ModelCatalogSnapshot = {
  entries: [
    {
      id: "gpt-5.5",
      name: "GPT",
      provider: "openai",
      contextWindow: 400_000,
      reasoning: false,
    },
    {
      id: "claude-fable-5",
      name: "Fable",
      provider: "anthropic",
      contextWindow: 1_000_000,
      reasoning: false,
    },
    {
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      name: "Alias target",
      contextWindow: 1_000_000,
      reasoning: false,
    },
  ],
  routeVariants: [],
};

export function migratedSessionEntry(
  entry: { sessionId: string; updatedAt: number } & Record<string, unknown>,
): SessionEntry {
  const migrated = migrateSessionExecutionSelection({
    entry,
    defaultProvider: "openai",
    cliRuntimeProviders: new Map(
      listCliRuntimeModelBackendBindings().map(({ runtime, provider }) => [runtime, provider]),
    ),
    classifyExecutor: (id) => resolveExecutionSelectionExecutorKind(undefined, id),
  });
  return {
    ...migrated.entry,
    sessionId: entry.sessionId,
    updatedAt: entry.updatedAt,
    executionSelection: sessionExecutionSelectionSchema.parse(migrated.entry.executionSelection),
  };
}

export function selectedSessionEntry(
  entry: SessionEntry,
  provider: string,
  model: string,
  executor: { kind: "harness" | "cli"; id: string } = { kind: "harness", id: "openclaw" },
): SessionEntry {
  commitSessionExecutionSelection(entry, { model: { provider, id: model }, executor });
  return entry;
}

export const createTypingController = (): TypingController => ({
  onReplyStart: async () => {},
  startTypingLoop: async () => {},
  startTypingOnText: async () => {},
  refreshTypingTtl: () => {},
  isActive: () => false,
  markRunComplete: () => {},
  markDispatchIdle: () => {},
  cleanup: vi.fn(),
});

type NativeSlashFastReplyParams = Parameters<typeof maybeResolveNativeSlashCommandFastReply>[0];
type NativeSlashFastReplyDefaultKey =
  | "agentDir"
  | "agentCfg"
  | "defaultProvider"
  | "defaultModel"
  | "aliasIndex"
  | "provider"
  | "model"
  | "workspaceDir";

export function runTestNativeSlashFastReply(
  overrides: Omit<NativeSlashFastReplyParams, NativeSlashFastReplyDefaultKey> &
    Partial<Pick<NativeSlashFastReplyParams, NativeSlashFastReplyDefaultKey>>,
  publishCatalog?: boolean,
) {
  let preparedOverrides = overrides;
  const commandName = overrides.ctx.CommandTurn?.commandName;
  if (publishCatalog ?? (commandName === "model" || commandName === "compact")) {
    const input = overrides.cfg;
    const catalog = overrides.preparedModelCatalog ?? nativeCatalog;
    const config: OpenClawConfig = {
      ...input,
      models: {
        ...input.models,
        providers: {
          ...input.models?.providers,
          ...Object.fromEntries(
            [...new Set(catalog.entries.map((row) => row.provider))].map((provider) => [
              provider,
              {
                api:
                  provider === "anthropic"
                    ? ("anthropic-messages" as const)
                    : ("openai-responses" as const),
                baseUrl:
                  provider === "anthropic"
                    ? "https://api.anthropic.com"
                    : "https://api.openai.com/v1",
                ...input.models?.providers?.[provider],
                ...(catalog.entries.find((row) => row.provider === provider)?.baseUrl
                  ? { baseUrl: catalog.entries.find((row) => row.provider === provider)?.baseUrl }
                  : {}),
                models: catalog.entries
                  .filter((row) => row.provider === provider)
                  .map((row) => {
                    const ownedModel: ModelDefinitionConfig = {
                      id: row.id,
                      name: row.name,
                      reasoning: row.reasoning ?? false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow:
                        row.provider === "openai" && row.id === "gpt-5.5"
                          ? 200_000
                          : (row.contextWindow ?? 200_000),
                      maxTokens: 8192,
                    };
                    if (row.api) {
                      ownedModel.api = row.api;
                    }
                    Object.assign(
                      ownedModel,
                      input.models?.providers?.[provider]?.models.find(
                        (configured) => configured.id === row.id,
                      ),
                    );
                    return ownedModel;
                  }),
              },
            ]),
          ),
        },
      },
      agents: {
        ...input.agents,
        defaults: {
          model: "openai/gpt-5.5",
          workspace: "/tmp/workspace",
          ...input.agents?.defaults,
          models: {
            ...Object.fromEntries(
              catalog.entries.map((row) => [
                row.provider + "/" + row.id,
                { agentRuntime: { id: "openclaw" } },
              ]),
            ),
            ...input.agents?.defaults?.models,
          },
        },
      },
    };
    const published = createSessionModelCatalogFixture().publish({
      config,
      agentId: overrides.agentId,
      catalog,
      plugins: nativePluginMetadata.plugins,
      runtimeAuthModes: { "claude-cli": "oauth" },
      profiles: Object.fromEntries(
        [...new Set(catalog.entries.map((row) => row.provider))].map((provider) => [
          provider + ":test",
          { type: "api_key", provider, key: "test-key" },
        ]),
      ),
    });
    preparedOverrides = {
      ...overrides,
      cfg: markCompleteReplyConfig(config, {
        runtimeMode: usesFullReplyRuntime(input) ? "full" : "fast",
      }),
      agentDir: published.agentDir,
      workspaceDir: published.workspaceDir,
    };
  }
  return maybeResolveNativeSlashCommandFastReply({
    agentDir: resolveAgentDir(preparedOverrides.cfg, preparedOverrides.agentId),
    agentCfg: undefined,
    defaultProvider: "openai",
    defaultModel: "gpt-5.5",
    aliasIndex: { byKey: new Map(), byAlias: new Map() },
    provider: "openai",
    model: "gpt-5.5",
    workspaceDir: resolveAgentWorkspaceDir(preparedOverrides.cfg, preparedOverrides.agentId),
    ...preparedOverrides,
  });
}

export async function useRealNativeCompactCommand() {
  const runtime = await import("./commands-compact.runtime.js");
  const { handleCommands } = await import("./commands-core.js");
  const compact = vi.spyOn(runtime, "compactEmbeddedAgentSession").mockResolvedValue({
    ok: true,
    compacted: false,
    reason: "already compacted",
  });
  const abort = vi.spyOn(runtime, "abortEmbeddedAgentRun");
  const wait = vi.spyOn(runtime, "waitForEmbeddedAgentRunEnd");
  handleCommandsMock.mockImplementation(handleCommands);
  return { compact, abort, wait };
}

export function buildNativeCommandCtx(
  body: string,
  overrides: Parameters<typeof buildTestCtx>[0] = {},
) {
  const authorized = overrides.CommandAuthorized ?? true;
  return buildTestCtx({
    Body: body,
    CommandBody: body,
    CommandSource: "native",
    CommandAuthorized: authorized,
    CommandTurn: {
      kind: "native",
      source: "native",
      authorized,
      commandName: body.slice(1).split(/\s+/, 1)[0] ?? "",
      body,
    },
    ...overrides,
  });
}

export function useNativeSlashFastReplyFixture() {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => cliBackendsTesting.resetDepsForTest());

  let registryBefore: ReturnType<typeof captureActivePluginRegistrySnapshot>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    registryBefore = captureActivePluginRegistrySnapshot();
    const registry = createEmptyPluginRegistry();
    registry.cliBackends = runtimeCliBackends.map((backend) => ({
      pluginId: backend.pluginId,
      source: "fixture",
      backend,
    }));
    setActivePluginRegistry(registry);
    const { harness } = await loadNativeHarnessFixture({ label: "Test native app" });
    registerAgentHarness(harness);
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => runtimeCliBackends,
      resolvePluginSetupCliBackend: () => {
        throw new Error("native command attempted synchronous CLI setup discovery");
      },
    });
    // Keep scoped thinking reads on the same catalog fixture as model selection.

    vi.spyOn(preparedModelCatalog, "loadPreparedModelCatalogSnapshot").mockResolvedValue(
      nativeCatalog,
    );
    vi.spyOn(preparedModelCatalog, "loadProviderScopedThinkingCatalog").mockResolvedValue(
      nativeCatalog.entries,
    );
    handleCommandsMock.mockReset();
    buildStatusReplyMock.mockReset();
    buildStatusReplyMock.mockResolvedValue({ text: "selected model status" });
  });

  afterEach(() => restoreActivePluginRegistrySnapshot(registryBefore));

  async function resolveNativeDirectiveCommand(
    body: string,
    config?: OpenClawConfig,
    response: { shouldContinue: boolean; reply?: { text: string } } = { shouldContinue: true },
    preparedCatalog?: ModelCatalogSnapshot,
    publishCatalog?: boolean,
  ) {
    handleCommandsMock.mockResolvedValue(response);
    const typing = createTypingController();
    const resolvedConfig =
      config ??
      ({
        session: {
          store: path.join(tempDirs.make("openclaw-native-directive-"), "sessions.json"),
        },
      } as OpenClawConfig);
    const result = await runTestNativeSlashFastReply(
      {
        ctx: buildNativeCommandCtx(body, {
          BodyForAgent: body,
          RawBody: body,
          Provider: "telegram",
          Surface: "telegram",
          GatewayClientScopes: ["operator.admin"],
          SessionKey: "telegram:slash:123",
          CommandTargetSessionKey: "agent:main:telegram:123",
        }),
        cfg: markCompleteReplyConfig(resolvedConfig),
        agentId: "main",
        agentCfg: config?.agents?.defaults,
        commandAuthorized: true,
        typing,
        preparedModelCatalog: preparedCatalog,
      },
      publishCatalog,
    );

    return { result, typing, storePath: resolvedConfig.session?.store };
  }

  return { tempDirs, resolveNativeDirectiveCommand };
}
