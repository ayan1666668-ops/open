import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, beforeEach, expect, onTestFinished, vi } from "vitest";
import {
  configureExecutionDecisionWorkSink,
  type ExecutionDecisionWork,
} from "../../audit/execution-decision-work.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  installSpawnModelCatalogFixture,
  supportedSpawnExecutionSelection,
} from "../subagents/spawn/subagent-spawn.test-helpers.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";

const hoisted = vi.hoisted(() => {
  const spawnSubagentDirectMock = vi.fn();
  const spawnAcpDirectMock = vi.fn();
  const registerSubagentRunMock = vi.fn();
  const inProcessCreationMock = vi.fn();
  const getSubagentDeliveryBacklogPressureMock = vi.fn(() => ({
    suspended: 0,
    blocked: false,
  }));
  const runSubagentProgressMock = vi.fn(async () => {});
  const prepareSessionExecutionSelectionMock = vi.fn<typeof supportedSpawnExecutionSelection>();
  return {
    spawnSubagentDirectMock,
    spawnAcpDirectMock,
    registerSubagentRunMock,
    inProcessCreationMock,
    getSubagentDeliveryBacklogPressureMock,
    runSubagentProgressMock,
    prepareSessionExecutionSelectionMock,
  };
});
export { hoisted };

vi.mock("../subagents/spawn/subagent-spawn-deps.js", () => ({
  getSubagentSpawnDeps: () => ({
    prepareSessionExecutionSelection: hoisted.prepareSessionExecutionSelectionMock,
  }),
}));

vi.mock("../subagents/spawn/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_CONTEXT_MODES: ["isolated", "fork"],
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnSubagentDirectMock(...args),
}));

vi.mock("../subagents/spawn/acp-spawn.js", () => ({
  spawnAcpDirect: (...args: unknown[]) => hoisted.spawnAcpDirectMock(...args),
}));

vi.mock("../subagents/registry/subagent-registry.js", () => ({
  registerSubagentRun: (...args: unknown[]) => hoisted.registerSubagentRunMock(...args),
  getSubagentDeliveryBacklogPressure: () => hoisted.getSubagentDeliveryBacklogPressureMock(),
}));

vi.mock("./in-process-gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./in-process-gateway.js")>();
  return {
    ...actual,
    callInProcessGatewayToolWithCreation: (...args: unknown[]) =>
      hoisted.inProcessCreationMock(...args),
  };
});

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (hookName: string) => hookName === "subagent_progress",
    runSubagentProgress: hoisted.runSubagentProgressMock,
  }),
}));

export let acpRuntimeRegistry: typeof import("../../acp/runtime/registry.js");

export async function captureSessionDecisionWork<T>(run: () => Promise<T>): Promise<{
  result: T;
  work: ExecutionDecisionWork[];
}> {
  const work: ExecutionDecisionWork[] = [];
  const clear = configureExecutionDecisionWorkSink((item) => {
    work.push(item);
    return true;
  });
  try {
    const token = createExecutionIdentityAdmissionToken("sessions-spawn-action", {
      contextId: "sessions-spawn-context",
      executionId: "sessions-spawn-execution",
    });
    const result = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        executionIdentityToken: token,
        receiptAuthority: () => true,
      },
      run,
    );
    return { result, work };
  } finally {
    clear();
  }
}

beforeAll(async () => {
  acpRuntimeRegistry = await import("../../acp/runtime/registry.js");
});

beforeEach(async () => {
  const previousRegistry = captureActivePluginRegistrySnapshot();
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: "codex",
    source: "test",
    harness: {
      id: "codex",
      label: "Spawn fixture app",
      autoSelection: { providerIds: [] },
      supports: ({ provider }) => ({ supported: provider === "openai" }),
      runAttempt: async () => {
        throw new Error("Spawn orchestration fixture must not execute a model turn");
      },
    },
  });
  setActivePluginRegistry(registry);
  onTestFinished(() => restoreActivePluginRegistrySnapshot(previousRegistry));
  await installSpawnModelCatalogFixture();
  hoisted.prepareSessionExecutionSelectionMock
    .mockReset()
    .mockImplementation(supportedSpawnExecutionSelection);
  acpRuntimeRegistry.testing.resetAcpRuntimeBackendsForTests();
  hoisted.spawnSubagentDirectMock.mockReset().mockResolvedValue({
    status: "accepted",
    context: "isolated",
    childSessionKey: "agent:main:subagent:1",
    runId: "run-subagent",
  });
  hoisted.spawnAcpDirectMock.mockReset().mockResolvedValue({
    status: "accepted",
    childSessionKey: "agent:codex:acp:1",
    runId: "run-acp",
  });
  hoisted.registerSubagentRunMock.mockReset();
  hoisted.inProcessCreationMock.mockReset();
  hoisted.getSubagentDeliveryBacklogPressureMock
    .mockReset()
    .mockReturnValue({ suspended: 0, blocked: false });
  hoisted.runSubagentProgressMock.mockClear();
});

export function registerAcpBackendForTest() {
  acpRuntimeRegistry.registerAcpRuntimeBackend({
    id: "acpx",
    runtime: {
      ensureSession: vi.fn(async () => ({
        sessionKey: "agent:codex:acp:1",
        backend: "acpx",
        runtimeSessionName: "codex",
      })),
      async *runTurn() {},
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    },
  });
}

export function requireSchemaProperty(
  properties:
    | Record<string, { description?: string; enum?: string[]; type?: string } | undefined>
    | undefined,
  name: string,
) {
  const property = properties?.[name];
  if (!property) {
    throw new Error(`expected ${name} schema property`);
  }
  return property;
}

export const requireRecord = createRequireRecord("record", "expected-label");

export function expectDetailFields(details: unknown, expected: Record<string, unknown>) {
  const record = requireRecord(details, "result details");
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key]).toBe(value);
  }
}

export function mockCallArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
  if (!Array.isArray(calls)) {
    throw new Error(`expected ${label} mock calls`);
  }
  const call = calls[callIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex + 1}`);
  }
  return requireRecord(call[argIndex], `${label} call ${callIndex + 1} arg ${argIndex + 1}`);
}
