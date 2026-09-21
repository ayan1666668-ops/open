import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import {
  createTestApprovalManager,
  startTestApprovalRequest,
} from "../exec-approval-manager.test-support.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const requests: ReturnType<typeof startTestApprovalRequest>[] = [];
async function cleanupRequests() {
  await runQaGatewayFixture(
    async () => {},
    ...requests.splice(0).map((request) => request.cleanup),
  );
}

afterEach(cleanupRequests);

function createApprovalScopeRequest(testContext: TestContext, scope: unknown) {
  const manager = createTestApprovalManager<PluginApprovalRequestPayload>(testContext, {
    approvalKind: "plugin",
  });
  const respond = vi.fn();
  const params = {
    title: "Sensitive action",
    description: "Review the action",
    scope,
    twoPhase: true,
  };
  const options = {
    req: { method: "plugin.approval.request", params, id: "request" },
    params,
    respond,
    client: { connId: "reviewer", connect: { client: { id: "reviewer" } } },
    context: {
      broadcast: vi.fn(),
      logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      hasExecApprovalClients: () => true,
    },
  } as unknown as GatewayRequestHandlerOptions;
  const handler = expectDefined(
    createPluginApprovalHandlers(manager)["plugin.approval.request"],
    "plugin approval request handler",
  );
  return { manager, respond, handler, options };
}

describe("plugin approval request scopes", () => {
  it("sanitizes owner-declared scope before storing or broadcasting the approval", async (testContext) => {
    const { manager, handler, options } = createApprovalScopeRequest(testContext, {
      kind: "message-send",
      target: "email\u202Esystem",
      recipientCount: 3,
      recipients: ["alice\u200B@example.com", "bob@example.com"],
      audience: "external",
    });
    const request = startTestApprovalRequest(manager, handler, options);
    requests.push(request);
    await runQaGatewayFixture(async () => {
      const pending = request.pending;
      const approvalId = await request.accepted();
      expect(await manager.listPendingRecords()).toHaveLength(1);
      const record = expectDefined(
        (await manager.listPendingRecords())[0],
        "pending plugin approval",
      );
      expect(record.id).toBe(approvalId);

      expect(record.request.scope).toEqual({
        kind: "message-send",
        target: "email\\u{202E}system",
        recipientCount: 3,
        recipients: ["alice\\u{200B}@example.com", "bob@example.com"],
        audience: "external",
      });
      await manager.resolve(record.id, "allow-once");
      await pending;
    }, request.cleanup);
  });

  it("drops scope after escaped text exceeds its bounds without rejecting approval", async (testContext) => {
    const { manager, handler, options } = createApprovalScopeRequest(testContext, {
      kind: "external-post",
      target: `github${"\u202E".repeat(20)}`,
      visibility: "public",
    });
    const request = startTestApprovalRequest(manager, handler, options);
    requests.push(request);
    await runQaGatewayFixture(async () => {
      const pending = request.pending;
      const approvalId = await request.accepted();
      expect(await manager.listPendingRecords()).toHaveLength(1);
      const record = expectDefined(
        (await manager.listPendingRecords())[0],
        "pending plugin approval",
      );
      expect(record.id).toBe(approvalId);

      expect(record.request.scope).toBeNull();
      await manager.resolve(record.id, "allow-once");
      await pending;
    }, request.cleanup);
  });

  it("waits for real registration before accepting a held approval request", async (testContext) => {
    const { manager, handler, options, respond } = createApprovalScopeRequest(testContext, {
      kind: "external-post",
      target: "github",
      visibility: "public",
    });
    const entered = createDeferred();
    const release = createDeferred();
    const register = manager.register.bind(manager);
    const spy = vi.spyOn(manager, "register").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return await register(...args);
    });
    const request = startTestApprovalRequest(manager, handler, options);
    let closing: Promise<void> | undefined;
    const cleanup = () =>
      (closing ??= runQaGatewayFixture(
        async () => {
          release.resolve();
        },
        request.cleanup,
        () => spy.mockRestore(),
      ));
    requests.push({ ...request, cleanup });
    await runQaGatewayFixture(async () => {
      const accepted = request.accepted();
      const settled = vi.fn();
      void accepted.then(settled, settled);
      await entered.promise;
      expect(respond).not.toHaveBeenCalled();
      expect(manager.listLocalPendingRecords()).toHaveLength(0);
      expect(settled).not.toHaveBeenCalled();
      release.resolve();
      const approvalId = await accepted;
      const records = await manager.listPendingRecords();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        id: approvalId,
        request: {
          scope: {
            kind: "external-post",
            target: "github",
            visibility: "public",
          },
        },
      });
      await manager.resolve(approvalId, "deny");
      await request.pending;
    }, cleanup);
  });

  it("fails the accepted handshake when registration is rejected", async (testContext) => {
    const { manager, handler, options, respond } = createApprovalScopeRequest(testContext, {
      kind: "external-post",
      target: "github",
      visibility: "public",
    });
    const spy = vi.spyOn(manager, "register").mockRejectedValueOnce(new Error("admission refused"));
    const request = startTestApprovalRequest(manager, handler, options);
    requests.push(request);
    await runQaGatewayFixture(
      async () => {
        await expect(request.accepted()).rejects.toThrow();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE" }),
        );
        expect(manager.listLocalPendingRecords()).toHaveLength(0);
        await request.pending;
      },
      request.cleanup,
      () => spy.mockRestore(),
    );
  });

  it.for([
    { kind: "untyped", target: "email" },
    { kind: "external-post", target: "github", visibility: "public", extra: true },
  ])("rejects malformed or non-closed owner-declared scope", async (scope, testContext) => {
    const { manager, respond, handler, options } = createApprovalScopeRequest(testContext, scope);
    await handler(options);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: expect.any(String) }),
    );
    expect(await manager.listPendingRecords()).toHaveLength(0);
  });
});
