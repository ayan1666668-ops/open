import path from "node:path";
import { expect, it, vi } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { hoisted, requireRecord } from "./sessions-spawn-tool.test-support.js";

// Load after fixture mocks register, independent of static import sorting.
const { createSessionsSpawnTool } = await import("./sessions-spawn-tool.js");

it("rejects an unsupported visible model before creating a session or registering a run", async () => {
  await withTestDir({ prefix: "openclaw-visible-model-" }, async (dir) => {
    const callGateway = vi.fn(async () => {
      throw new Error("Unexpected Gateway creation");
    });
    const registerRun = vi.fn();
    hoisted.prepareSessionExecutionSelectionMock.mockResolvedValue({
      status: "rejected",
      reason: "unsupported",
      message: "Unknown model: xai/nonexistent-native-fixture",
    });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: {
        session: { store: path.join(dir, "sessions.json") },
        agents: { entries: { main: { workspace: dir } } },
      },
      callGateway,
      registerRun,
      countActiveRuns: () => 0,
    });
    const result = await tool.execute("unsupported-visible", {
      task: "validate the selected model",
      model: "xai/nonexistent-native-fixture",
      visible: true,
    });
    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("Unknown model"),
    });
    expect(callGateway).not.toHaveBeenCalled();
    expect(registerRun).not.toHaveBeenCalled();
    expect(hoisted.prepareSessionExecutionSelectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: { kind: "model", model: { id: "xai/nonexistent-native-fixture" } },
        modelInput: expect.objectContaining({ raw: "xai/nonexistent-native-fixture" }),
      }),
    );
  });
});

it("reports every unsupported visible parameter in one error", async () => {
  const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:main" });

  await expect(
    tool.execute("visible-unsupported-many", {
      task: "inspect",
      runtime: "acp",
      thinking: "high",
      thread: true,
      mode: "session",
      lightContext: true,
      attachments: [{ name: "note.txt", content: "hello" }],
      attachAs: { mountPath: "inputs" },
      visible: true,
    }),
  ).rejects.toThrow(
    'Parameters unavailable with visible=true: runtime: supports runtime="subagent" only; thinking: thinking overrides are not wired to the sessions.create path; thread: visible sessions route to the dashboard, not a channel thread; mode: visible sessions are persistent dashboard sessions; lightContext: bootstrap staging is not wired to the sessions.create path; attachments: attachment staging is not wired to the sessions.create path; attachAs: attachment staging is not wired to the sessions.create path',
  );
});
it("rejects cross-agent visible transcript forks", async () => {
  const callGateway = vi.fn();
  const tool = createSessionsSpawnTool({
    agentSessionKey: "agent:main:main",
    config: {
      agents: {
        defaults: { subagents: { allowAgents: ["reviewer"] } },
        list: [{ id: "main" }, { id: "reviewer" }],
      },
    },
    callGateway,
    countActiveRuns: () => 0,
  });

  const result = await tool.execute("visible-cross-agent-fork", {
    task: "review patch",
    agentId: "reviewer",
    context: "fork",
    visible: true,
  });

  expect(result.details).toMatchObject({
    status: "error",
    error:
      'context="fork" currently requires the same target agent as the requester; use context="isolated" for cross-agent spawns.',
  });
  expect(callGateway).not.toHaveBeenCalled();
});

it.each([
  {
    name: "malformed agent ID",
    agentId: "Agent not found: reviewer",
    requireAgentId: false,
    expected: "Invalid agentId",
  },
  {
    name: "missing required agent ID",
    agentId: undefined,
    requireAgentId: true,
    expected: "sessions_spawn requires agentId",
  },
])("keeps visible $name recovery independent of filtered tools", async (testCase) => {
  const callGateway = vi.fn();
  const tool = createSessionsSpawnTool({
    agentSessionKey: "agent:main:main",
    config: {
      agents: {
        defaults: { subagents: { requireAgentId: testCase.requireAgentId } },
        list: [{ id: "main" }],
      },
    },
    callGateway,
    countActiveRuns: () => 0,
  });

  const result = await tool.execute("visible-invalid-agent", {
    task: "inspect issue",
    visible: true,
    ...(testCase.agentId ? { agentId: testCase.agentId } : {}),
  });

  const details = requireRecord(result.details, "visible spawn failure");
  expect(details.error).toContain(testCase.expected);
  expect(details.error).not.toContain("agents_list");
  expect(callGateway).not.toHaveBeenCalled();
});

it("rejects cwd escape for sandboxed visible sessions", async () => {
  await withTestDir({ prefix: "openclaw-visible-sandbox-cwd-" }, async (dir) => {
    const callGateway = vi.fn();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: {
        agents: {
          defaults: { sandbox: { mode: "all" } },
          list: [{ id: "main", workspace: path.join(dir, "workspace") }],
        },
      },
      callGateway,
      countActiveRuns: () => 0,
    });

    const result = await tool.execute("visible-sandbox-cwd", {
      task: "inspect",
      cwd: path.join(dir, "outside"),
      visible: true,
    });

    expect(result.details).toMatchObject({
      status: "forbidden",
      error:
        "cwd override is not supported outside the target agent workspace for sandboxed visible session runs",
    });
    expect(callGateway).not.toHaveBeenCalled();
  });
});

it("allows cwd within a sandboxed visible session workspace", async () => {
  await withTestDir({ prefix: "openclaw-visible-sandbox-cwd-" }, async (dir) => {
    const workspace = path.join(dir, "workspace");
    const cwd = path.join(workspace, "packages", "app");
    const callGateway = vi.fn(async () => ({
      key: "agent:main:dashboard:child",
      runStarted: true,
      runId: "run-visible",
    }));
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: {
        agents: {
          defaults: { sandbox: { mode: "all" } },
          list: [{ id: "main", workspace }],
        },
      },
      callGateway: callGateway as never,
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
    });

    const result = await tool.execute("visible-sandbox-cwd", {
      task: "inspect",
      cwd,
      visible: true,
    });

    expect(result.details).toMatchObject({ status: "accepted" });
    expect(result.details).toMatchObject({ owner: { type: "agent", id: "main" } });
    expect(result.details).not.toHaveProperty("sessionUrl");
    expect(callGateway).toHaveBeenCalledWith("sessions.create", expect.objectContaining({ cwd }));
  });
});

it.each([
  [
    "thinking",
    { thinking: "high" },
    "Parameters unavailable with visible=true: thinking: thinking overrides are not wired to the sessions.create path",
  ],
  [
    "thread",
    { thread: true },
    "Parameters unavailable with visible=true: thread: visible sessions route to the dashboard, not a channel thread",
  ],
  [
    "mode",
    { mode: "session" },
    "Parameters unavailable with visible=true: mode: visible sessions are persistent dashboard sessions",
  ],
  [
    "lightContext",
    { lightContext: true },
    "Parameters unavailable with visible=true: lightContext: bootstrap staging is not wired to the sessions.create path",
  ],
  [
    "attachments",
    { attachments: [{ name: "note.txt", content: "hello" }] },
    "Parameters unavailable with visible=true: attachments: attachment staging is not wired to the sessions.create path",
  ],
  [
    "attachAs",
    { attachAs: { mountPath: "inputs" } },
    "Parameters unavailable with visible=true: attachAs: attachment staging is not wired to the sessions.create path",
  ],
] as const)("rejects visible %s overrides with a reason", async (_name, override, message) => {
  const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:main" });

  await expect(
    tool.execute("visible-unsupported", { task: "inspect", visible: true, ...override }),
  ).rejects.toThrow(message);
});
