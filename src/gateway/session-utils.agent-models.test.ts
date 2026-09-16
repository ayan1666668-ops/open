import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { getSessionDefaults } from "./session-utils-model.js";
import { listAgentsForGateway } from "./session-utils-store.js";

const providerArtifactMocks = vi.hoisted(() => ({
  resolveBundledProviderPolicySurface: vi.fn<
    typeof import("../plugins/provider-public-artifacts.js").resolveBundledProviderPolicySurface
  >(() => null),
}));

vi.mock("../plugins/provider-public-artifacts.js", () => ({
  resolveBundledProviderPolicySurface: providerArtifactMocks.resolveBundledProviderPolicySurface,
  resolveProviderPolicySurface: providerArtifactMocks.resolveBundledProviderPolicySurface,
}));

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  providerArtifactMocks.resolveBundledProviderPolicySurface.mockReset();
  providerArtifactMocks.resolveBundledProviderPolicySurface.mockReturnValue(null);
});

afterAll(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("listAgentsForGateway model identity", () => {
  test.each([
    {
      shared: "local-utility/shared@local-utility:setup",
      ops: "local-utility/ops@local-utility:ops",
    },
    { shared: "helper@local-utility:setup", ops: "helper@local-utility:ops" },
    { shared: "helper", ops: "helper" },
  ])("separates canonical utility availability from primary readiness: $shared", (utility) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          utilityModel: utility.shared,
          models: { "local-utility/shared": { alias: "helper" } },
        },
        entries: {
          main: { default: true },
          ops: {
            model: {
              primary: "openai/gpt-5.5@openai:primary",
              fallbacks: ["openai/gpt-5.4@openai:backup"],
            },
            utilityModel: utility.ops,
            models: { "local-utility/ops": { alias: "helper" } },
          },
          disabled: { utilityModel: "" },
        },
      },
    };
    const original = structuredClone(cfg);

    const { agents } = listAgentsForGateway(cfg);
    const main = agents.find((agent) => agent.id === "main");
    const ops = agents.find((agent) => agent.id === "ops");
    const disabled = agents.find((agent) => agent.id === "disabled");

    expect(main?.utilityModel).toBe("local-utility/shared");
    expect(main?.model?.primary).toBeUndefined();
    expect(ops?.utilityModel).toBe("local-utility/ops");
    expect(ops?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["openai/gpt-5.4"],
    });
    expect(disabled?.utilityModel).toBeUndefined();
    expect(disabled?.model?.primary).toBeTruthy();
    expect(cfg).toEqual(original);
  });

  test("listAgentsForGateway projects a profile-qualified default as canonical model identity", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.6-sol@openai:setup-fake",
            fallbacks: ["anthropic/claude-sonnet-4-6@anthropic:backup"],
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
    const catalog = [
      {
        provider: "openai",
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        reasoning: true,
      },
    ];

    const result = listAgentsForGateway(cfg, catalog);
    const defaults = getSessionDefaults(cfg, catalog);

    expect(result.agents[0]?.model).toEqual({
      primary: "openai/gpt-5.6-sol",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
    expect(result.agents[0]?.thinkingLevels).toEqual(defaults.thinkingLevels);
    expect(result.agents[0]?.thinkingDefault).toBe(defaults.thinkingDefault);
  });

  test.each([
    ["custom/vertex-ai_claude-haiku-4-5@20251001", "custom/vertex-ai_claude-haiku-4-5@20251001"],
    [
      "custom/vertex-ai_claude-haiku-4-5@20251001@custom:setup-fake",
      "custom/vertex-ai_claude-haiku-4-5@20251001",
    ],
    ["lmstudio/gemma-4-31b-it@q8_0", "lmstudio/gemma-4-31b-it@q8_0"],
    ["lmstudio/gemma-4-31b-it@q8_0@lmstudio:setup-fake", "lmstudio/gemma-4-31b-it@q8_0"],
  ])("listAgentsForGateway preserves model-owned @ suffixes in %s", (primary, expected) => {
    const cfg = {
      agents: {
        defaults: { model: { primary } },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    expect(listAgentsForGateway(cfg).agents[0]?.model?.primary).toBe(expected);
  });
});
