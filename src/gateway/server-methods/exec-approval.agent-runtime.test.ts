import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { createChatRunState } from "../server-chat-state.js";
import { createExecApprovalHandlers } from "./exec-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

vi.mock("../../infra/command-analysis/explain.js", () => ({
  resolveCommandAnalysisSummaryForDisplay: vi.fn(async () => null),
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await closeOpenClawStateDatabaseByPathAsync(
        resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: dir }),
      );
    }
    cleanup();
  }),
);

function databaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(tempDirs.make("exec-approval-id-"));
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function identity(enabled: boolean): AgentRuntimeIdentity {
  return {
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
    turnSourceChannel: "telegram",
    turnSourceTo: "chat-1",
    turnSourceAccountId: "default",
    turnSourceThreadId: "thread-1",
    ...(enabled
      ? {
          executionIdentity: {
            tokenVersion: 1,
            createdAt: 1,
            runId: "run-1",
            contextId: "context-1",
            executionId: "execution-1",
          },
        }
      : {}),
  };
}

function requestOptions(
  runtimeIdentity: AgentRuntimeIdentity,
  validateAuthority: () => boolean = () => true,
): GatewayRequestHandlerOptions {
  const request = {
    command: "echo ok",
    cwd: "/tmp",
    agentId: "forged-agent",
    sessionKey: "forged-session",
    sessionId: "forged-session-id",
    runId: "forged-run",
    turnSourceChannel: "forged-channel",
    turnSourceTo: "forged-target",
    turnSourceAccountId: "forged-account",
    turnSourceThreadId: "forged-thread",
    timeoutMs: 2_000,
    twoPhase: true,
  };
  return {
    req: { method: "exec.approval.request", params: request, id: "req-1" },
    params: request,
    client: {
      connId: "conn-agent-runtime",
      connect: { client: { id: "test-client", displayName: "Test Client" } },
      internal: { agentRuntimeIdentity: runtimeIdentity },
    },
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      broadcast: vi.fn(),
      getRuntimeConfig: () => ({}),
      hasExecApprovalClients: () => true,
      chatRunState: createChatRunState(),
      validateAgentRuntimeApprovalAuthority: validateAuthority,
      logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    },
  } as unknown as GatewayRequestHandlerOptions;
}

async function withAcceptedRequest(
  manager: ExecApprovalManager,
  opts: GatewayRequestHandlerOptions,
  check: (approvalId: string) => Promise<void>,
): Promise<void> {
  const responseSent = createDeferred();
  const respond = vi.mocked(opts.respond);
  respond.mockImplementation(() => responseSent.resolve());
  const pending = createExecApprovalHandlers(manager)["exec.approval.request"]!(opts);
  try {
    // Acceptance follows worker persistence and delivery; a local pending row alone
    // does not prove the handshake finished. Surface early failures too.
    await Promise.race([responseSent.promise, pending]);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "accepted", deliveryRoute: "approval-client" }),
      undefined,
    );
    const records = await manager.listPendingRecords();
    expect(records).toHaveLength(1);
    await check(records[0]!.id);
    await pending;
  } finally {
    await Promise.all([manager.drain(), Promise.allSettled([pending])]);
  }
}

describe("exec approval signed agent runtime", () => {
  it("rejects closed authority before creating an exec approval", async (testContext) => {
    const manager = createTestApprovalManager(testContext, {
      validateAgentRuntimeDelegatedAuthority: () => false,
    });
    const handler = createExecApprovalHandlers(manager)["exec.approval.request"]!;
    const opts = requestOptions(identity(false), () => false);

    await handler(opts);

    expect(await manager.listPendingRecords()).toHaveLength(0);
    expect(vi.mocked(opts.respond).mock.calls[0]?.[2]).toMatchObject({
      message: expect.stringContaining("no longer active"),
    });
  });

  it("sanitizes display-only cwd and resolvedPath in the stored request", async (testContext) => {
    const manager = createTestApprovalManager(testContext, {
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const opts = requestOptions(identity(false));
    // Bidi override in cwd/resolvedPath can spoof what path reviewers see.
    (opts.params as Record<string, unknown>).cwd = "/tmp/safe‮evil";
    (opts.params as Record<string, unknown>).resolvedPath = "/usr/bin/echo​x";
    // Free-form policy strings must not reach reviewer meta rows: security/ask
    // are closed enums (arbitrary values null out), host is escape-hardened.
    (opts.params as Record<string, unknown>).security = "full‮looks-deny";
    (opts.params as Record<string, unknown>).ask = "always​ish";
    await withAcceptedRequest(manager, opts, async (approvalId) => {
      const record = (await manager.getSnapshot(approvalId))!;
      expect(record.request.cwd).toBe("/tmp/safe\\u{202E}evil");
      expect(record.request.resolvedPath).toBe("/usr/bin/echo\\u{200B}x");
      expect(record.request.security).toBeNull();
      expect(record.request.ask).toBeNull();
      expect(await manager.resolve(record.id, "deny")).toBe(true);
    });
  });

  it("cancels an exec approval when authority closes after the handshake", async (testContext) => {
    let active = true;
    const manager = createTestApprovalManager(testContext, {
      validateAgentRuntimeDelegatedAuthority: () => active,
    });
    const opts = requestOptions(identity(false), () => active);
    await withAcceptedRequest(manager, opts, async (approvalId) => {
      active = false;
      await expect(manager.awaitDecision(approvalId)).resolves.toBeNull();
      expect(await manager.getSnapshot(approvalId)).toMatchObject({ status: "cancelled" });
    });
  });

  it.each([
    ["enabled", true],
    ["disabled", false],
  ] as const)("uses signed runtime provenance with collection %s", async (_label, enabled) => {
    const options = databaseOptions();
    const manager = new ExecApprovalManager({
      approvalKind: "exec",
      persistence: { runtimeEpoch: "runtime-a", databaseOptions: options },
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const opts = requestOptions(identity(enabled));

    await withAcceptedRequest(manager, opts, async (approvalId) => {
      expect(opts.context.broadcast).toHaveBeenCalledWith(
        "exec.approval.requested",
        expect.objectContaining({ id: approvalId }),
        { dropIfSlow: true },
      );
      expect((await manager.getSnapshot(approvalId))?.request).toMatchObject({
        agentId: "main",
        sessionKey: "agent:main:session-1",
        sessionId: null,
        runId: "run-1",
        turnSourceChannel: "telegram",
        turnSourceTo: "chat-1",
        turnSourceAccountId: "default",
        turnSourceThreadId: "thread-1",
      });
      const db = openOpenClawStateDatabase(options).db;
      if (enabled) {
        expect(
          db
            .prepare(
              "SELECT approval_id, source_context_id, source_execution_id FROM operator_approval_execution_identities WHERE approval_id = ?",
            )
            .get(approvalId),
        ).toEqual({
          approval_id: approvalId,
          source_context_id: "context-1",
          source_execution_id: "execution-1",
        });
      } else {
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'operator_approval_execution_identities'",
            )
            .get(),
        ).toBeUndefined();
      }
      expect(await manager.resolve(approvalId, "deny")).toBe(true);
    });
  });
});
