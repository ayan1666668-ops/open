// Gateway agent-command test helpers.
// Waits for mocked agent command dispatches in async gateway tests.
import { vi } from "vitest";
import { sleep } from "../utils/sleep.js";
import { agentCommandMock } from "./test-helpers.runtime-state.js";

type AgentCommandCall = Record<string, unknown>;

function agentCommandCalls(): Array<[AgentCommandCall]> {
  return vi.mocked(agentCommandMock).mock.calls as unknown as Array<[AgentCommandCall]>;
}

/** Observe admitted cleanup without moving production work into the test's async scope. */
export async function observeAgentCommandWork() {
  const [execution, admission, { AsyncWorkScope }] = await Promise.all([
    import("./agent-turn/agent-run-execution-phase.js"),
    import("../process/gateway-work-admission.js"),
    import("../shared/async-work-scope.js"),
  ]);
  const work = new AsyncWorkScope();
  const observe = <T>(pending: Promise<T>): Promise<T> => {
    void work.track(() => pending).catch(() => {});
    return pending;
  };
  const startExecution = execution.startAgentRunExecution;
  const executionObserver = vi
    .spyOn(execution, "startAgentRunExecution")
    .mockImplementation((params) => observe(startExecution(params)));
  const retainWork = admission.runWithRetainedGatewayRootWork;
  const retainedWorkObserver = vi
    .spyOn(admission, "runWithRetainedGatewayRootWork")
    .mockImplementation(function <T>(run: () => T | Promise<T>) {
      return observe(retainWork(run));
    });
  return {
    settle: () => work.runWhenIdle(() => {}),
    async [Symbol.asyncDispose]() {
      await work.runWhenIdle(() => {
        executionObserver.mockRestore();
        retainedWorkObserver.mockRestore();
      });
      await work.drain();
    },
  };
}

/** Waits until the mocked `agentCommand` receives a call for a specific run id. */
export async function waitForAgentCommandCall(runId: string): Promise<AgentCommandCall> {
  for (let elapsed = 0; elapsed <= 2_000; elapsed += 5) {
    const call = agentCommandCalls()
      .map((entry) => entry[0])
      .find((entry) => entry.runId === runId);
    if (call) {
      return call;
    }
    await sleep(5);
  }
  throw new Error(`expected agentCommand to be called for ${runId}`);
}

/** Reads the latest mocked `agentCommand` call, or waits for a specific run id. */
export async function readAgentCommandCall(
  params: { runId?: string; fromEnd?: number } = {},
): Promise<AgentCommandCall> {
  if (params.runId) {
    return await waitForAgentCommandCall(params.runId);
  }
  return agentCommandCalls().at(-(params.fromEnd ?? 1))?.[0] ?? {};
}
