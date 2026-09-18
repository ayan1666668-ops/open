import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../../config/config.js";
import type { OpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { getPreparedModelRuntimeMocks } from "../../prepared-model-runtime.test-harness.js";
import { ModelRegistry } from "../../sessions/model-registry.js";

export async function configureSpawnRuntimeFixture(state: OpenClawTestState) {
  const config = {
    logging: { audit: { enabled: true, executionIdentity: true } },
    tools: { swarm: { enabled: true, maxConcurrent: 1 } },
    agents: {
      ownership: "explicit",
      defaults: {
        workspace: state.stateDir,
        systemAgent: { agentId: "main" },
        model: { primary: "custom/test-model" },
      },
      entries: { main: { workspace: state.stateDir } },
    },
    models: {
      mode: "replace",
      providers: {
        custom: {
          api: "openai-completions",
          baseUrl: "https://example.invalid/v1",
          models: [
            {
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              id: "test-model",
              input: ["text"],
              maxTokens: 1_024,
              name: "Test model",
              reasoning: false,
            },
          ],
        },
      },
    },
  } satisfies OpenClawConfig;
  await state.writeConfig(config);
  clearConfigCache();
  clearRuntimeConfigSnapshot();

  const preparedRuntime = getPreparedModelRuntimeMocks();
  preparedRuntime.modelRegistry.fork.mockImplementation((authStorage) =>
    ModelRegistry.inMemory(authStorage),
  );
  const model = {
    api: "openai-completions" as const,
    baseUrl: "https://example.invalid/v1",
    contextWindow: 4_096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    id: "test-model",
    input: ["text" as const],
    maxTokens: 1_024,
    name: "Test model",
    provider: "custom",
    reasoning: false,
  };
  preparedRuntime.configuredAgentIds = ["main"];
  preparedRuntime.configuredAgentDirs.set("main", state.agentDir("main"));
  preparedRuntime.configuredWorkspaces.set("main", state.stateDir);
  preparedRuntime.buildPreparedModelCatalogSnapshot.mockResolvedValue({
    entries: [model],
    routeVariants: [model],
  });
  return config;
}
