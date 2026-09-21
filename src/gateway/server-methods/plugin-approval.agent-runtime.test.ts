import fs from "node:fs";
import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function createPersistenceFixture(test: TestContext) {
  const lifetime = createFixtureLifetime();
  const stateDir = fs.realpathSync(lifetime.createTempDir("plugin-approval-id-"));
  const options: OpenClawStateDatabaseOptions = {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  };
  const manager = new ExecApprovalManager<PluginApprovalRequestPayload>({
    approvalKind: "plugin",
    persistence: { runtimeEpoch: "runtime-a", databaseOptions: options },
    validateAgentRuntimeDelegatedAuthority: () => true,
  });
  let body: Promise<void> | undefined;
  let pending: Promise<void> | undefined;
  test.onTestFinished(() => {
    void lifetime.verifyCleanup(async () => {
      // Retire observers before joining the fixture body, which can still await its request.
      await manager.drain();
      await Promise.allSettled([body, pending]);
      await closeOpenClawStateDatabaseByPathAsync(
        resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
      );
    });
    return lifetime.cleanup();
  });
  // Match Gateway startup: initialize the real schema before request admission.
  try {
    openOpenClawStateDatabase(options);
  } catch (error) {
    void lifetime.track(
      Promise.reject(new Error("Approval fixture initialization failed", { cause: error })),
      true,
    );
    throw error;
  }
  return {
    options,
    manager,
    run: (run: () => Promise<void>) => (body = lifetime.run(run)),
    request: (opts: GatewayRequestHandlerOptions) =>
      (pending = lifetime.track(Promise.resolve(requestHandler(manager)(opts)))),
  };
}

function executionIdentity() {
  return {
    tokenVersion: 1 as const,
    createdAt: 1,
    runId: "run-1",
    contextId: "context-1",
    executionId: "execution-1",
  };
}

function identityWithoutExecution(): AgentRuntimeIdentity {
  const operationalRunInstance = { instanceId: "instance-run-1", runId: "run-1" };
  return {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:session-1",
    operationalRunInstance,
    delegatedAuthority: {
      kind: "local",
      operationalRunInstance,
      lifecycleGeneration: "generation-1",
      claimId: "claim-1",
    },
  };
}

function requestOptions(params: {
  request: Record<string, unknown>;
  identity: AgentRuntimeIdentity;
  validateAuthority?: () => boolean;
}): { options: GatewayRequestHandlerOptions; responseSent: Promise<void> } {
  const responseSent = createDeferred();
  const options = {
    req: { method: "plugin.approval.request", params: params.request, id: "req-1" },
    params: params.request,
    client: {
      connId: "conn-agent-runtime",
      connect: { client: { id: "test-client", displayName: "Test Client" } },
      internal: { agentRuntimeIdentity: params.identity },
    },
    isWebchatConnect: () => false,
    respond: vi.fn(() => responseSent.resolve()),
    context: {
      broadcast: vi.fn(),
      getRuntimeConfig: () => ({ agents: { list: [{ id: "main" }] } }),
      logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      hasExecApprovalClients: () => true,
      validateAgentRuntimeApprovalAuthority: params.validateAuthority ?? (() => true),
    },
  } as unknown as GatewayRequestHandlerOptions;
  return { options, responseSent: responseSent.promise };
}

function requestHandler(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
): NonNullable<ReturnType<typeof createPluginApprovalHandlers>["plugin.approval.request"]> {
  const handler = createPluginApprovalHandlers(manager)["plugin.approval.request"];
  if (!handler) {
    throw new Error("plugin approval request handler is unavailable");
  }
  return handler;
}

async function waitForAcceptedRequest(
  opts: GatewayRequestHandlerOptions,
  responseSent: Promise<void>,
  pending: void | Promise<void>,
) {
  await Promise.race([responseSent, pending]);
  expect(opts.context.broadcast).toHaveBeenCalledWith(
    "plugin.approval.requested",
    expect.objectContaining({ id: expect.any(String) }),
    { dropIfSlow: true },
  );
  const payload = vi.mocked(opts.context.broadcast).mock.calls[0]?.[1] as { id: string };
  expect(opts.respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ status: "accepted", id: payload.id }),
    undefined,
  );
  return payload.id;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plugin approval signed agent runtime", () => {
  it("rejects closed authority before creating a plugin approval", async (testContext) => {
    const manager = createTestApprovalManager<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
      validateAgentRuntimeDelegatedAuthority: () => false,
    });
    const { options: opts } = requestOptions({
      request: { title: "Sensitive action", description: "D" },
      identity: {
        ...identityWithoutExecution(),
        approvalOwnerPluginId: "codex",
      },
      validateAuthority: () => false,
    });

    await requestHandler(manager)(opts);

    expect(await manager.listPendingRecords()).toHaveLength(0);
    expect(vi.mocked(opts.respond).mock.calls[0]?.[2]).toMatchObject({
      message: expect.stringContaining("no longer active"),
    });
  });

  it("cancels a plugin approval when authority closes after the handshake", async (testContext) => {
    let active = true;
    const manager = createTestApprovalManager<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
      validateAgentRuntimeDelegatedAuthority: () => active,
    });
    const { options: opts, responseSent } = requestOptions({
      request: { title: "Sensitive action", description: "D", twoPhase: true },
      identity: {
        ...identityWithoutExecution(),
        approvalOwnerPluginId: "codex",
      },
      validateAuthority: () => active,
    });
    const pending = requestHandler(manager)(opts);
    const approvalId = await waitForAcceptedRequest(opts, responseSent, pending);
    active = false;

    await expect(manager.awaitDecision(approvalId)).resolves.toBeNull();
    await pending;
    expect(await manager.getSnapshot(approvalId)).toMatchObject({ status: "cancelled" });
  });

  it("rejects a signed runtime without a host-resolved approval owner", async (testContext) => {
    const manager = createTestApprovalManager<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const { options: opts } = requestOptions({
      request: { pluginId: "forged", title: "Sensitive action", description: "D" },
      identity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:session-1",
        operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
        delegatedAuthority: {
          kind: "local",
          operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
          lifecycleGeneration: "generation-1",
          claimId: "claim-1",
        },
      },
    });

    await requestHandler(manager)(opts);

    expect(vi.mocked(opts.respond).mock.calls[0]?.[2]).toMatchObject({
      message: expect.stringContaining("signed plugin approval owner is unavailable"),
    });
  });

  it("uses signed runtime owner and route instead of forged request metadata", async (testContext) => {
    const fixture = createPersistenceFixture(testContext);
    const { options, manager } = fixture;
    await fixture.run(async () => {
      const { options: opts, responseSent } = requestOptions({
        request: {
          pluginId: "forged-plugin",
          title: "Sensitive action",
          description: "D",
          agentId: "forged-agent",
          sessionKey: "forged-session",
          turnSourceChannel: "forged-channel",
          turnSourceTo: "forged-target",
          twoPhase: true,
        },
        identity: {
          kind: "agentRuntime",
          operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
          delegatedAuthority: {
            kind: "local",
            operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
            lifecycleGeneration: "generation-1",
            claimId: "claim-1",
          },
          executionIdentity: executionIdentity(),
          approvalOwnerPluginId: "codex",
          agentId: "main",
          sessionKey: "agent:main:session-1",
          turnSourceChannel: "telegram",
          turnSourceTo: "chat-1",
          turnSourceAccountId: "default",
          turnSourceThreadId: "thread-1",
        },
      });

      const pending = fixture.request(opts);
      const approvalId = await waitForAcceptedRequest(opts, responseSent, pending);
      expect((await manager.getSnapshot(approvalId))?.request).toMatchObject({
        pluginId: "codex",
        agentId: "main",
        sessionKey: "agent:main:session-1",
        turnSourceChannel: "telegram",
        turnSourceTo: "chat-1",
        turnSourceAccountId: "default",
        turnSourceThreadId: "thread-1",
      });
      expect(
        openOpenClawStateDatabase(options)
          .db.prepare(
            "SELECT approval_id, source_context_id, source_execution_id FROM operator_approval_execution_identities WHERE approval_id = ?",
          )
          .get(approvalId),
      ).toEqual({
        approval_id: approvalId,
        source_context_id: "context-1",
        source_execution_id: "execution-1",
      });
      await manager.resolve(approvalId, "deny");
      await pending;
    });
  });

  it("does not create execution identity storage when collection is disabled", async (testContext) => {
    const fixture = createPersistenceFixture(testContext);
    const { options, manager } = fixture;
    await fixture.run(async () => {
      const { options: opts, responseSent } = requestOptions({
        request: { title: "Sensitive action", description: "D", twoPhase: true },
        identity: {
          kind: "agentRuntime",
          operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
          delegatedAuthority: {
            kind: "local",
            operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
            lifecycleGeneration: "generation-1",
            claimId: "claim-1",
          },
          approvalOwnerPluginId: "codex",
          agentId: "main",
          sessionKey: "agent:main:session-1",
        },
      });

      const pending = fixture.request(opts);
      const approvalId = await waitForAcceptedRequest(opts, responseSent, pending);
      expect(
        openOpenClawStateDatabase(options)
          .db.prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'operator_approval_execution_identities'",
          )
          .get(),
      ).toBeUndefined();
      await manager.resolve(approvalId, "deny");
      await pending;
    });
  });
});
