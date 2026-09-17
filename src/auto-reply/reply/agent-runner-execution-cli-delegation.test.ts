import { describe, expect, it } from "vitest";
import { buildCliMcpGrantContext } from "../../agents/cli-runner/mcp-grant-context.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import {
  configureTestCliModel,
  createFollowupRun,
  configureTestHarness,
  testModel,
  testAuthProfiles,
  createMinimalRunAgentTurnParams,
  fallbackAttemptOptions,
  getExecuteAgentTurnForTest,
  initialFallbackAttemptOptions,
  requireMockCall,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

function resolveMockedCliGrantCapability() {
  const run = requireMockCall(state.runCliAgentMock, 0, "CLI run params")[0] as RunCliAgentParams;
  return buildCliMcpGrantContext({
    run,
    config: run.config ?? {},
    requireExplicitMessageTarget: false,
    agentId: "main",
    modelProvider: "openai",
    modelId: "gpt-5.4",
  }).delegationCapability;
}

describe("executeAgentTurn: CLI delegation grants", () => {
  it("keeps primary CLI completion grants unrestricted", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run("codex-cli", "gpt-5.4", initialFallbackAttemptOptions(params)),
      provider: "codex-cli",
      model: "gpt-5.4",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValue({ payloads: [{ text: "done" }], meta: {} });
    const followupRun = createFollowupRun({
      catalog: [testModel("codex-cli", "gpt-5.4")],
      profiles: testAuthProfiles("codex-cli"),
      runtimeAuthModes: { "codex-cli": "token" },
    });
    followupRun.run.executionSelection = configureTestCliModel(followupRun, "codex-cli", "gpt-5.4");
    followupRun.run.inputProvenance = {
      kind: "inter_session",
      sourceTool: "subagent_announce",
    };

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));

    expect(result).toMatchObject({ kind: "success" });
    expect(resolveMockedCliGrantCapability()).toBeUndefined();
  });

  it("restricts fallback CLI completion grants", async () => {
    state.isCliProviderMock.mockImplementation((provider) => provider === "codex-cli");
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params.run("anthropic", "claude", initialFallbackAttemptOptions(params));
      return {
        outcome: "completed",
        result: await params.run("codex-cli", "gpt-5.4", fallbackAttemptOptions(params, "unknown")),
        provider: "codex-cli",
        model: "gpt-5.4",
        attempts: [{ provider: "anthropic", model: "claude", error: "rate limit" }],
      };
    });
    state.runEmbeddedAgentMock.mockResolvedValue({ payloads: [], meta: {} });
    state.runCliAgentMock.mockResolvedValue({ payloads: [{ text: "done" }], meta: {} });
    const followupRun = createFollowupRun({
      catalog: [testModel("anthropic", "claude"), testModel("codex-cli", "gpt-5.4")],
      profiles: testAuthProfiles("anthropic", "codex-cli"),
      fallbacks: ["codex-cli/gpt-5.4"],
      runtimeAuthModes: { "codex-cli": "token" },
    });
    followupRun.run.config = {
      agents: {
        defaults: { model: { primary: "anthropic/claude", fallbacks: ["codex-cli/gpt-5.4"] } },
      },
    };
    configureTestCliModel(followupRun, "codex-cli", "gpt-5.4");
    configureTestHarness(
      followupRun,
      "delegation-test-primary",
      [{ provider: "anthropic", id: "claude" }],
      [{ provider: "codex-cli", id: "gpt-5.4" }],
    );
    followupRun.run.inputProvenance = {
      kind: "inter_session",
      sourceTool: "subagent_announce",
    };

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));

    expect(result).toMatchObject({ kind: "success" });
    expect(resolveMockedCliGrantCapability()).toBe("report_only");
  });
});
