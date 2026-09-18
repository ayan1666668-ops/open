import { onTestFinished } from "vitest";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { listCliRuntimeModelBackendBindings } from "../../agents/cli-backends.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { loadNativeHarnessFixture } from "../../agents/test-helpers/bundled-native-harness.test-support.js";
import { createSessionModelCatalogFixture } from "../../agents/test-helpers/session-model-catalog.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  getSessionExecutionSelection,
  isModelExecutionSelection,
} from "../../model-picker/execution-selection.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { createModelSelectionState, type ModelSelectionState } from "./model-selection.js";

/** Real preparation for compact tests; only the compaction backend remains mocked. */
export function attachCompactModelPreparation(params: HandleCommandsParams): void {
  let state: ModelSelectionState | undefined;
  params.prepareModelState = async (entry, validateCommit, purpose) => {
    if (!state) {
      const saved = getSessionExecutionSelection(entry);
      const provider =
        saved && isModelExecutionSelection(saved) ? saved.model.provider : params.provider;
      const rawModel = saved && isModelExecutionSelection(saved) ? saved.model.id : params.model;
      const model = rawModel.startsWith(`${provider}/`)
        ? rawModel.slice(provider.length + 1)
        : rawModel;
      const configuredModel = params.cfg.models?.providers?.[provider]?.models.find(
        (row) => row.id === model,
      );
      const row: ModelCatalogEntry = {
        provider,
        id: model,
        name: "Compaction fixture",
        api:
          configuredModel?.api ??
          params.cfg.models?.providers?.[provider]?.api ??
          (provider === "openai" ? "openai-responses" : "openai-completions"),
        reasoning: true,
        ...(configuredModel?.contextWindow ? { contextWindow: configuredModel.contextWindow } : {}),
      };
      const cfg: OpenClawConfig = {
        ...params.cfg,
        agents: {
          ...params.cfg.agents,
          defaults: {
            ...params.cfg.agents?.defaults,
            model: `${provider}/${model}`,
            models: {
              [`${provider}/${model}`]: { agentRuntime: { id: "openclaw" } },
              ...params.cfg.agents?.defaults?.models,
            },
          },
        },
        models: {
          ...params.cfg.models,
          providers: {
            ...params.cfg.models?.providers,
            [provider]: {
              api: row.api,
              baseUrl:
                provider === "openai"
                  ? "https://api.openai.com/v1"
                  : "https://compaction-fixture.invalid/v1",
              ...params.cfg.models?.providers?.[provider],
              models: configuredModel ? [configuredModel] : [],
            },
          },
        },
      };
      const agentId = resolveSessionAgentId({
        config: cfg,
        sessionKey: params.sessionKey,
        fallbackAgentId: params.agentId,
      });
      const cliBindings = listCliRuntimeModelBackendBindings({ config: cfg });
      const needsRuntimeRegistry =
        (saved?.executor.kind !== "acp" &&
          saved?.executor.id !== undefined &&
          saved.executor.id !== "openclaw") ||
        params.cfg.agents?.defaults?.models?.[`${provider}/${model}`]?.agentRuntime?.id === "codex";
      if (needsRuntimeRegistry) {
        const priorRegistry = captureActivePluginRegistrySnapshot();
        const registry = createEmptyPluginRegistry();
        registry.cliBackends = cliBindings.map(({ runtime, provider: modelProvider }) => ({
          pluginId: runtime,
          source: "fixture",
          backend: {
            id: runtime,
            pluginId: runtime,
            modelProvider,
            config: { command: process.execPath },
            bundleMcp: false,
          },
        }));
        onTestFinished(() => restoreActivePluginRegistrySnapshot(priorRegistry));
        setActivePluginRegistry(registry);
        const { harness } = await loadNativeHarnessFixture({ label: "Compaction app" });
        registerAgentHarness(harness);
      }
      const profileId = entry.authProfileOverride ?? `${provider}:fixture`;
      const published = createSessionModelCatalogFixture().publish({
        config: cfg,
        agentId,
        catalog: { entries: [row], routeVariants: [] },
        profiles: { [profileId]: { type: "api_key", provider, key: "synthetic-compaction-key" } },
        plugins: createPluginMetadataSnapshotFixture({
          plugins: cliBindings.map(({ runtime }) => ({
            id: runtime,
            cliBackends: [runtime],
            syntheticAuthRefs: [runtime],
          })),
        }).plugins,
        runtimeAuthModes: Object.fromEntries([
          ...cliBindings.map(({ runtime }) => [runtime, "oauth"] as const),
          ["codex", "oauth"] as const,
        ]),
      });
      const sessionStore = params.sessionStore ?? {};
      sessionStore[params.sessionKey] = entry;
      state = await createModelSelectionState({
        cfg,
        agentId,
        agentCfg: cfg.agents?.defaults,
        sessionEntry: entry,
        sessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        defaultProvider: provider,
        defaultModel: model,
        provider,
        model,
        hasModelDirective: false,
        prepareExecution: false,
        preparedModelCatalog: published,
        abortSignal: params.opts?.abortSignal,
        replyAuth: { isNewSession: false },
      });
    }
    state = await state.refreshExecution(entry, validateCommit, purpose);
    return state;
  };
  params.resolveModelLevels = async () => ({
    resolvedThinkLevel: params.resolvedThinkLevel ?? (await params.resolveDefaultThinkingLevel()),
    resolvedReasoningLevel: params.resolvedReasoningLevel,
  });
}
