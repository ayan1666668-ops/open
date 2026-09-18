import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionReceiptV1 } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import { configureRuntimeActionDecisionSink } from "../../audit/runtime-action-decision.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ExecutionSelectionRequest } from "../../model-picker/apply-session-model-selection.js";
import { withPluginRuntimePluginScope } from "./gateway-request-scope.js";
import type { PluginRuntime } from "./types.js";

const mocks = vi.hoisted(() => ({
  authorityActive: true,
  close: vi.fn(),
  createOperationalRunInstanceRef: vi.fn((runId: string) => ({
    instanceId: `instance:${runId}`,
    runId,
  })),
  getRuntimeConfig: vi.fn(() => ({}) as OpenClawConfig),
  loadSessionEntryReadOnly: vi.fn<() => InternalSessionEntry | undefined>(),
  prepareAgentRunAdmission: vi.fn(),
  prepareExecutionSelection: vi.fn(),
  selection: {
    model: { provider: "qa-provider", id: "qa-model" },
    executor: { kind: "harness" as const, id: "openclaw" },
  },
  runEmbeddedAgentCore: vi.fn(),
}));

vi.mock("../../agents/admitted-run-context.js", () => ({
  createOperationalRunInstanceRef: mocks.createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority: vi.fn(() =>
    mocks.authorityActive ? { runId: "run-plugin" } : undefined,
  ),
  prepareAgentRunAdmission: mocks.prepareAgentRunAdmission,
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgentCore,
}));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: mocks.getRuntimeConfig }));
vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntryReadOnly: mocks.loadSessionEntryReadOnly,
}));
vi.mock("../../model-picker/apply-session-model-selection.js", () => ({
  resolveExecutionSelectionExecutorKind: () => "harness",
  resolveSessionModelFallbacks: () => ({ kind: "disabled_by_model_override" }),
  prepareSessionExecutionSelection: (...args: unknown[]) =>
    mocks.prepareExecutionSelection(...args),
}));

import { runPluginEmbeddedAgent } from "./runtime-embedded-agent.runtime.js";

const config = {} as OpenClawConfig;
const params = {
  config,
  prompt: "check",
  runId: "run-plugin",
  sessionId: "session-plugin",
  sessionTarget: {
    agentId: "researcher",
    sessionId: "session-plugin",
    sessionKey: "agent:researcher:plugin",
    storePath: "/tmp/sessions",
  },
  timeoutMs: 1,
  workspaceDir: "/tmp/workspace",
} as Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];

describe("plugin embedded-agent runtime admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorityActive = true;
    mocks.loadSessionEntryReadOnly.mockReturnValue({
      sessionId: "session-plugin",
      updatedAt: 1,
      executionSelection: {
        state: "accepted",
        selection: mocks.selection,
        fallbackPermission: "explicit",
      },
    });
    mocks.prepareExecutionSelection.mockImplementation(
      async ({
        request,
        sessionEntry,
      }: {
        request: ExecutionSelectionRequest;
        sessionEntry?: InternalSessionEntry;
      }) => ({
        status: "ready",
        selection:
          sessionEntry?.executionSelection?.state === "accepted" &&
          sessionEntry.executionSelection.selection.executor.kind === "acp"
            ? sessionEntry.executionSelection.selection
            : request.kind === "model"
              ? { model: request.model, executor: request.executor ?? mocks.selection.executor }
              : request.kind === "selection" || request.kind === "fallback"
                ? request.selection
                : sessionEntry?.executionSelection?.state === "accepted"
                  ? sessionEntry.executionSelection.selection
                  : mocks.selection,
        before: mocks.selection,
        reason: "model",
        message: "Selection prepared.",
        validateCommit: () => undefined,
      }),
    );
    mocks.close.mockImplementation(() => {
      mocks.authorityActive = false;
    });
    mocks.prepareAgentRunAdmission.mockReturnValue({
      operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
      admit: vi.fn(),
      close: mocks.close,
    });
    mocks.runEmbeddedAgentCore.mockResolvedValue({ payloads: [] });
  });

  it.each(["explicit", "runtime"] as const)(
    "shares %s config between admission and execution and closes admission",
    async (configSource) => {
      const runParams = configSource === "explicit" ? params : { ...params, config: undefined };
      if (configSource === "runtime") {
        mocks.getRuntimeConfig.mockReturnValueOnce(config);
      }
      await expect(
        withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
          runPluginEmbeddedAgent(runParams),
        ),
      ).resolves.toEqual({ payloads: [] });

      expect(mocks.prepareAgentRunAdmission).toHaveBeenCalledWith({
        cfg: config,
        operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
        facts: {
          runId: "run-plugin",
          agentId: "researcher",
          ingress: {
            kind: "plugin",
            boundary: "plugin-runtime",
            rawSourceRef: "memory-plugin",
            state: "present",
          },
        },
        onAdmitted: expect.any(Function),
      });
      expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledWith(
        expect.objectContaining({
          ...params,
          preparedRunAdmission: expect.objectContaining({ close: mocks.close }),
        }),
      );
      expect(mocks.getRuntimeConfig).toHaveBeenCalledTimes(configSource === "runtime" ? 1 : 0);
      expect(mocks.close).toHaveBeenCalledOnce();
    },
  );

  it("closes the prepared admission when core execution throws", async () => {
    mocks.runEmbeddedAgentCore.mockRejectedValueOnce(new Error("core failed"));

    await expect(
      withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
        runPluginEmbeddedAgent(params),
      ),
    ).rejects.toThrow("core failed");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("records exact admission and attribution-only completion without plugin identifiers", async () => {
    const executionIdentityToken = {
      tokenVersion: 1,
      contextId: "context-plugin",
      executionId: "execution-plugin",
      runId: "run-plugin",
      createdAt: 100,
    } as const;
    const admittedRunContext: AdmittedRunContext = {
      operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
      executionIdentityToken,
    };
    mocks.prepareAgentRunAdmission.mockImplementationOnce(
      (input: { onAdmitted?: (context: AdmittedRunContext) => void | Promise<void> }) => ({
        operationalRunInstance: admittedRunContext.operationalRunInstance,
        admit: async () => {
          await input.onAdmitted?.(admittedRunContext);
          return admittedRunContext;
        },
        close: mocks.close,
      }),
    );
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async (input) => {
      await input.preparedRunAdmission.admit("plugin-harness");
      return { payloads: [] };
    });
    const receipts: DecisionReceiptV1[] = [];
    const clear = configureRuntimeActionDecisionSink((receipt) => {
      receipts.push(receipt);
      return true;
    });
    try {
      await withPluginRuntimePluginScope({ pluginId: "private-plugin-id" }, () =>
        runPluginEmbeddedAgent(params),
      );
    } finally {
      clear();
    }
    expect(receipts).toMatchObject([
      {
        decision: { outcome: "allowed", reasonCode: "plugin_runtime_owner_admitted" },
        enforcement: { coverageState: "enforced" },
      },
      {
        decision: { outcome: "allowed", reasonCode: "plugin_runtime_completed" },
        enforcement: { coverageState: "attribution-only" },
      },
    ]);
    expect(JSON.stringify(receipts)).not.toContain("private-plugin-id");
  });

  it("revokes admission immediately when a pending plugin run aborts", async () => {
    const core = createDeferred<{ payloads: never[] }>();
    const admittedRunContext: AdmittedRunContext = {
      operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
      executionIdentityToken: {
        tokenVersion: 1,
        contextId: "context-plugin-abort",
        executionId: "execution-plugin-abort",
        runId: "run-plugin",
        createdAt: 100,
      },
    };
    mocks.prepareAgentRunAdmission.mockImplementationOnce(
      (input: { onAdmitted?: (context: AdmittedRunContext) => void | Promise<void> }) => ({
        operationalRunInstance: admittedRunContext.operationalRunInstance,
        admit: async () => {
          await input.onAdmitted?.(admittedRunContext);
          return admittedRunContext;
        },
        close: mocks.close,
      }),
    );
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async (input) => {
      await input.preparedRunAdmission.admit("plugin-harness");
      return core.promise;
    });
    const receipts: DecisionReceiptV1[] = [];
    const clear = configureRuntimeActionDecisionSink((receipt) => {
      receipts.push(receipt);
      return true;
    });
    const controller = new AbortController();
    const run = withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
      runPluginEmbeddedAgent({ ...params, abortSignal: controller.signal }),
    );
    try {
      await vi.waitFor(() => expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce());

      controller.abort(new Error("cancelled"));
      expect(mocks.close).toHaveBeenCalledOnce();
      core.resolve({ payloads: [] });
      await expect(run).resolves.toEqual({ payloads: [] });
      expect(mocks.close).toHaveBeenCalledOnce();
      expect(receipts.map((receipt) => receipt.decision.reasonCode)).toEqual([
        "plugin_runtime_owner_admitted",
      ]);
    } finally {
      clear();
    }
  });

  it("closes admission when abort races with listener registration", async () => {
    const controller = new AbortController();
    mocks.prepareAgentRunAdmission.mockImplementationOnce(() => {
      controller.abort(new Error("raced cancellation"));
      return {
        operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
        admit: vi.fn(),
        close: mocks.close,
      };
    });

    await expect(
      withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
        runPluginEmbeddedAgent({ ...params, abortSignal: controller.signal }),
      ),
    ).rejects.toThrow("raced cancellation");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it("does not create admission for an already-aborted plugin run", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));

    await expect(
      withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
        runPluginEmbeddedAgent({ ...params, abortSignal: controller.signal }),
      ),
    ).rejects.toThrow("already cancelled");
    expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it("fails closed outside a plugin scope", async () => {
    await expect(runPluginEmbeddedAgent(params)).rejects.toThrow("active plugin runtime scope");
    expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it.each([
    "admittedRunContext",
    "preparedRunAdmission",
    "onDeferredLifecycleOwner",
    "onDeferredLifecycleAbort",
    "onRetryWait",
    "compactionCountOwner",
    "onCompactionAccounting",
    "onContextAccountingEvent",
  ] as const)("rejects a plugin-supplied %s", async (field) => {
    const value = field === "compactionCountOwner" ? "caller" : {};
    const input = { ...params, [field]: value };
    await expect(
      withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
        runPluginEmbeddedAgent(input),
      ),
    ).rejects.toThrow("cannot supply host run authority");
    expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it.each(["compactionCountOwner", "onCompactionAccounting", "onContextAccountingEvent"])(
    "rejects inherited %s before admission",
    async (field) => {
      const input = { ...params };
      Object.setPrototypeOf(input, {
        [field]: field === "compactionCountOwner" ? "caller" : vi.fn(),
      });

      await expect(
        withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
          runPluginEmbeddedAgent(input),
        ),
      ).rejects.toThrow("cannot supply host run authority");
      expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
      expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "detached", mode: { sessionPersistence: "detached" as const }, executor: "qa-harness" },
    { name: "raw model", mode: { modelRun: true }, executor: "openclaw" },
    { name: "raw prompt", mode: { promptMode: "none" as const }, executor: "openclaw" },
    { name: "session-bound", mode: {}, executor: undefined },
  ])(
    "keeps $name execution separate from an unrelated ACP selection",
    async ({ mode, executor }) => {
      mocks.loadSessionEntryReadOnly.mockReturnValue({
        sessionId: "session-plugin",
        updatedAt: 1,
        executionSelection: {
          state: "accepted",
          selection: {
            executor: { kind: "acp", agent: "qa-acp", backend: "qa-backend" },
            model: "native-managed",
          },
          fallbackPermission: "explicit",
        },
      });
      const run = withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
        runPluginEmbeddedAgent({
          ...params,
          ...mode,
          ...(executor
            ? {
                provider: "independent-provider",
                model: "independent-model",
                agentHarnessId: "qa-harness",
                authProfileId: "independent-profile",
                authProfileIdSource: "user" as const,
              }
            : {}),
        }),
      );
      if (executor) {
        await expect(run).resolves.toEqual({ payloads: [] });
        expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: "independent-provider",
            model: "independent-model",
            agentHarnessId: executor,
            agentHarnessRuntimeOverride: executor,
            authProfileId: "independent-profile",
            authProfileIdSource: "user",
            sessionTarget: params.sessionTarget,
          }),
        );
      } else {
        await expect(run).rejects.toThrow("cannot run this embedded operation");
        expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
      }
      expect(mocks.close).toHaveBeenCalledOnce();
    },
  );

  it("refuses an unconfirmed selection before invoking the backend", async () => {
    mocks.prepareExecutionSelection.mockResolvedValueOnce({
      status: "rejected",
      reason: "unknown",
      message: "Could not confirm support for the selected model. Your selection is unchanged.",
    });
    await expect(
      withPluginRuntimePluginScope({ pluginId: "memory-plugin" }, () =>
        runPluginEmbeddedAgent(params),
      ),
    ).rejects.toThrow("Could not confirm support");
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
