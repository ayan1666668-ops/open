import os from "node:os";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThinkLevel } from "../../../auto-reply/thinking.shared.js";
import type { SessionExecutionSelection } from "../../../model-picker/execution-selection.js";
import { acceptedModelSelection } from "../../../test-utils/session-execution-selection.js";
import { resolveUserPath } from "../../../utils.js";
import { installAcceptedSubagentGatewayMock } from "../../test-helpers/subagent-gateway.js";
import type * as SubagentRegistryTestHelpers from "../registry/subagent-registry.test-helpers.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import type * as SubagentSpawn from "./subagent-spawn.js";
import {
  createSubagentSpawnTestConfig,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";

const hoisted = {
  callGatewayMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
};
let resetSubagentRegistryForTests: typeof SubagentRegistryTestHelpers.resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof SubagentSpawn.spawnSubagentDirect;

function createConfigOverride(overrides?: Record<string, unknown>) {
  return createSubagentSpawnTestConfig(os.tmpdir(), {
    agents: {
      defaults: {
        workspace: os.tmpdir(),
      },
      list: [
        {
          id: "main",
          workspace: "/tmp/workspace-main",
        },
      ],
    },
    ...overrides,
  });
}

type InheritedSpawnPreferenceCase = {
  name: string;
  task: string;
  requesterState: Readonly<Record<string, unknown>>;
  preferenceKey: "thinkingLevel" | "fastMode";
  expected: string | boolean;
  agentDefaults?: Readonly<Record<string, unknown>>;
  requesterAgent?: Readonly<Record<string, unknown>>;
  requesterPreferenceReadFails?: boolean;
  collect?: boolean;
  requesterRunId?: string;
  requesterThinkingLevel?: ThinkLevel;
  thinkingOverride?: string;
};

const inheritedSpawnPreferenceCases: readonly InheritedSpawnPreferenceCase[] = [
  {
    name: "inherits requester thinking level when no spawn or subagent default is configured",
    task: "inherit thinking",
    requesterState: { thinkingLevel: "high" },
    preferenceKey: "thinkingLevel",
    expected: "high",
  },
  {
    name: "inherits active-turn Ultra instead of the stored session thinking level",
    task: "inherit active thinking",
    requesterState: { thinkingLevel: "medium" },
    requesterThinkingLevel: "ultra",
    preferenceKey: "thinkingLevel",
    expected: "ultra",
  },
  {
    name: "inherits active-turn off instead of a stored Ultra override",
    task: "inherit active thinking off",
    requesterState: { thinkingLevel: "ultra" },
    requesterThinkingLevel: "off",
    preferenceKey: "thinkingLevel",
    expected: "off",
  },
  {
    name: "keeps explicit child thinking ahead of active-turn Ultra",
    task: "override active thinking",
    requesterState: { thinkingLevel: "medium" },
    requesterThinkingLevel: "ultra",
    thinkingOverride: "low",
    preferenceKey: "thinkingLevel",
    expected: "low",
  },
  {
    name: "inherits requester fast mode for collector children",
    task: "inherit fast mode",
    requesterState: { fastMode: "auto" },
    preferenceKey: "fastMode",
    expected: "auto",
    collect: true,
    requesterRunId: "parent-run",
  },
  {
    name: "inherits requester fast mode for ordinary children with default Swarm config",
    task: "inherit ordinary fast mode",
    requesterState: { fastMode: true },
    preferenceKey: "fastMode",
    expected: true,
  },
  {
    name: "persists inherited requester thinking off",
    task: "inherit thinking off",
    requesterState: { thinkingLevel: "off" },
    preferenceKey: "thinkingLevel",
    expected: "off",
  },
  {
    name: "inherits requester agent thinkingDefault when the caller session has no stored thinking",
    task: "inherit agent thinking default",
    requesterState: {},
    requesterAgent: { thinkingDefault: "high" },
    preferenceKey: "thinkingLevel",
    expected: "high",
  },
  {
    name: "uses requester agent thinkingDefault after a failed preference read",
    task: "inherit agent thinking default after a preference read failure",
    requesterState: {},
    requesterAgent: { thinkingDefault: "high" },
    requesterPreferenceReadFails: true,
    preferenceKey: "thinkingLevel",
    expected: "high",
  },
  {
    name: "inherits global thinkingDefault when caller session and agent have no stored thinking",
    task: "inherit global thinking default",
    requesterState: {},
    agentDefaults: { thinkingDefault: "medium" },
    preferenceKey: "thinkingLevel",
    expected: "medium",
  },
  {
    name: "applies requester-agent subagent thinking before active-turn thinking",
    task: "requester policy thinking",
    requesterState: { thinkingLevel: "high" },
    requesterAgent: { subagents: { thinking: "medium" } },
    requesterThinkingLevel: "ultra",
    preferenceKey: "thinkingLevel",
    expected: "medium",
  },
];

describe("spawnSubagentDirect inherited preferences", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      getRuntimeConfig: () => hoisted.configOverride,
      loadSessionStoreMock: hoisted.loadSessionStoreMock,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      resolveAgentConfig: (cfg: { agents?: { list?: Array<{ id?: string }> } }, agentId: string) =>
        cfg.agents?.list?.find((agent) => agent.id === agentId),
      sessionStorePath: "/tmp/subagent-spawn-preferences.json",
    }));
  });

  beforeEach(() => {
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    hoisted.loadSessionStoreMock.mockReset().mockReturnValue({});
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.configOverride = createConfigOverride();
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
  });
  afterEach(() => swarmSchedulerTesting.reset());

  it.each([
    { label: "default", mode: undefined },
    { label: "read-only", mode: "read-only" },
    { label: "guarded", mode: "guarded" },
    { label: "workspace", mode: "workspace" },
    { label: "full", mode: "full" },
  ] as const)(
    "inherits the parent's $label permission mode in a hidden child",
    async ({ mode }) => {
      const sessionRoot = resolveUserPath("/tmp/workspace-main");
      let persistedStore: Record<string, Record<string, unknown>> | undefined;
      installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
        onStore: (store) => {
          persistedStore = store;
        },
      });

      const result = await spawnSubagentDirect(
        { task: "inherit the parent permission policy" },
        {
          agentSessionKey: "agent:main:main",
          workspaceDir: sessionRoot,
          ...(mode ? { sessionPermissionPolicy: { mode, root: sessionRoot } } : {}),
        },
      );

      expect(result.status).toBe("accepted");
      const childEntry = persistedStore?.[result.childSessionKey as string];
      if (mode) {
        expect(childEntry).toMatchObject({ permissionMode: mode, sessionRoot });
      } else {
        expect(childEntry).not.toHaveProperty("permissionMode");
        expect(childEntry).not.toHaveProperty("sessionRoot");
      }
    },
  );

  it.each(inheritedSpawnPreferenceCases)(
    "$name",
    async ({
      task,
      requesterState,
      preferenceKey,
      expected,
      agentDefaults,
      requesterAgent,
      requesterPreferenceReadFails,
      collect,
      requesterRunId,
      requesterThinkingLevel,
      thinkingOverride,
    }) => {
      if (agentDefaults || requesterAgent) {
        hoisted.configOverride = createConfigOverride({
          agents: {
            defaults: { workspace: os.tmpdir(), ...agentDefaults },
            list: [{ id: "main", workspace: "/tmp/workspace-main", ...requesterAgent }],
          },
        });
      }
      hoisted.loadSessionStoreMock.mockReturnValue({ "agent:main:main": requesterState });
      if (requesterPreferenceReadFails) {
        hoisted.loadSessionStoreMock.mockImplementationOnce(() => {
          throw new Error("preference read unavailable");
        });
      }
      let persistedStore: Record<string, Record<string, unknown>> | undefined;
      installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
        onStore: (store) => {
          persistedStore = store;
        },
      });

      const result = await spawnSubagentDirect(
        { task, thinking: thinkingOverride, ...(collect ? { collect: true } : {}) },
        {
          agentSessionKey: "agent:main:main",
          ...(requesterRunId ? { requesterRunId } : {}),
          requesterThinkingLevel,
        },
      );

      expect(result.status).toBe("accepted");
      expect(persistedStore?.[result.childSessionKey as string]?.[preferenceKey]).toBe(expected);
    },
  );

  it.each<{
    name: string;
    selectedParent?: boolean;
    observedParent?: boolean;
    agentThinking?: ThinkLevel;
    configuredModel?: string;
    configuredThinking?: ThinkLevel;
    expected: ThinkLevel;
    expectedSelection?: SessionExecutionSelection;
  }>([
    {
      name: "prefers requester agent thinkingDefault over selected-model thinking fallback",
      selectedParent: true,
      agentThinking: "high",
      expected: "high",
    },
    {
      name: "inherits requester selected-model thinking when caller session has no stored thinking or agent default",
      selectedParent: true,
      expected: "low",
    },
    {
      name: "prefers requester agent thinkingDefault over runtime-model thinking fallback",
      observedParent: true,
      agentThinking: "high",
      expected: "high",
    },
    {
      name: "uses configured thinking and model instead of observed parent history",
      observedParent: true,
      configuredModel: "anthropic/claude-opus-4-7",
      configuredThinking: "high",
      expected: "high",
      expectedSelection: acceptedModelSelection("anthropic", "claude-opus-4-7", {
        fallbackPermission: "configured",
      }),
    },
    {
      name: "inherits provider/model thinking default when no caller-specific default exists",
      configuredModel: "openai/gpt-5.4",
      expected: "low",
    },
  ])("$name", async (scenario) => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          ...(scenario.configuredModel ? { model: scenario.configuredModel } : {}),
          models: {
            "openai/gpt-5.4": { params: { thinking: "low" } },
            ...(scenario.configuredModel && scenario.configuredThinking
              ? {
                  [scenario.configuredModel]: { params: { thinking: scenario.configuredThinking } },
                }
              : {}),
          },
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
            ...(scenario.agentThinking ? { thinkingDefault: scenario.agentThinking } : {}),
          },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": scenario.selectedParent
        ? {
            sessionId: "selected-parent",
            updatedAt: 1,
            executionSelection: acceptedModelSelection("openai", "gpt-5.4"),
            modelProvider: "anthropic",
            model: "claude-opus-4-7",
          }
        : scenario.observedParent
          ? { modelProvider: "openai", model: "gpt-5.4" }
          : {},
    });
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      { task: scenario.name },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result.status).toBe("accepted");
    const childEntry = persistedStore?.[result.childSessionKey as string];
    expect(childEntry?.thinkingLevel).toBe(scenario.expected);
    if (scenario.expectedSelection) {
      expect(childEntry?.executionSelection).toEqual(scenario.expectedSelection);
    }
  });
});
