import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import {
  cleanupTestApprovalFixtures,
  createTestApprovalFixture,
} from "../exec-approval-manager.test-support.js";
import { waitForApprovalAccepted } from "./approval-request.test-support.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

afterEach(cleanupTestApprovalFixtures);

function createApprovalScopeRequest(testContext: TestContext, scope: unknown) {
  const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(testContext, {
    approvalKind: "plugin",
  });
  const { manager } = fixture;
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
  return { fixture, manager, respond, handler, options };
}

describe("plugin approval request scopes", () => {
  it("sanitizes owner-declared scope before storing or broadcasting the approval", async (testContext) => {
    const { fixture, manager, handler, options } = createApprovalScopeRequest(testContext, {
      kind: "message-send",
      target: "email\u202Esystem",
      recipientCount: 3,
      recipients: ["alice\u200B@example.com", "bob@example.com"],
      audience: "external",
    });
    await fixture.run(async () => {
      const { pending, response } = await waitForApprovalAccepted(
        options.respond,
        (observedRespond) =>
          fixture.track(Promise.resolve(handler({ ...options, respond: observedRespond }))),
      );
      expect(await manager.listPendingRecords()).toHaveLength(1);
      const record = expectDefined(
        (await manager.listPendingRecords())[0],
        "pending plugin approval",
      );
      expect(response[1]).toMatchObject({ id: record.id });

      expect(record.request.scope).toEqual({
        kind: "message-send",
        target: "email\\u{202E}system",
        recipientCount: 3,
        recipients: ["alice\\u{200B}@example.com", "bob@example.com"],
        audience: "external",
      });
      await manager.resolve(record.id, "allow-once");
      await pending;
    });
  });

  it("drops scope after escaped text exceeds its bounds without rejecting approval", async (testContext) => {
    const { fixture, manager, handler, options } = createApprovalScopeRequest(testContext, {
      kind: "external-post",
      target: `github${"\u202E".repeat(20)}`,
      visibility: "public",
    });
    await fixture.run(async () => {
      const { pending, response } = await waitForApprovalAccepted(
        options.respond,
        (observedRespond) =>
          fixture.track(Promise.resolve(handler({ ...options, respond: observedRespond }))),
      );
      expect(await manager.listPendingRecords()).toHaveLength(1);
      const record = expectDefined(
        (await manager.listPendingRecords())[0],
        "pending plugin approval",
      );
      expect(response[1]).toMatchObject({ id: record.id });

      expect(record.request.scope).toBeNull();
      await manager.resolve(record.id, "allow-once");
      await pending;
    });
  });

  it("waits for real registration before accepting a held approval request", async (testContext) => {
    const { fixture, manager, handler, options, respond } = createApprovalScopeRequest(
      testContext,
      {
        kind: "external-post",
        target: "github",
        visibility: "public",
      },
    );
    await fixture.run(async () => {
      const entered = createDeferred();
      const release = createDeferred();
      const register = manager.register.bind(manager);
      const spy = vi.spyOn(manager, "register").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await racePromiseWithAbortSignal(release.promise, testContext.signal);
        return await register(...args);
      });
      const accepted = waitForApprovalAccepted(options.respond, (observedRespond) =>
        fixture.track(Promise.resolve(handler({ ...options, respond: observedRespond }))),
      );
      const settled = vi.fn();
      void accepted.then(settled, settled);
      try {
        await Promise.race([entered.promise, accepted]);
        expect(respond).not.toHaveBeenCalled();
        expect(manager.listLocalPendingRecords()).toHaveLength(0);
        expect(settled).not.toHaveBeenCalled();
        release.resolve();
        const { pending, response } = await accepted;
        const records = await manager.listPendingRecords();
        expect(records).toHaveLength(1);
        expect(response[1]).toMatchObject({ id: records[0]!.id });
        expect(records[0]).toMatchObject({
          request: {
            scope: {
              kind: "external-post",
              target: "github",
              visibility: "public",
            },
          },
        });
        await manager.resolve(records[0]!.id, "deny");
        await pending;
      } finally {
        release.resolve();
        await Promise.allSettled([accepted]);
        spy.mockRestore();
      }
    });
  });

  it("fails the accepted handshake when registration is rejected", async (testContext) => {
    const { fixture, manager, handler, options, respond } = createApprovalScopeRequest(
      testContext,
      {
        kind: "external-post",
        target: "github",
        visibility: "public",
      },
    );
    await fixture.run(async () => {
      const spy = vi
        .spyOn(manager, "register")
        .mockRejectedValueOnce(new Error("admission refused"));
      try {
        await expect(
          waitForApprovalAccepted(options.respond, (observedRespond) =>
            fixture.track(Promise.resolve(handler({ ...options, respond: observedRespond }))),
          ),
        ).rejects.toThrow();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE" }),
        );
        expect(manager.listLocalPendingRecords()).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it.for([
    { kind: "untyped", target: "email" },
    { kind: "external-post", target: "github", visibility: "public", extra: true },
  ])("rejects malformed or non-closed owner-declared scope", async (scope, testContext) => {
    const { fixture, manager, respond, handler, options } = createApprovalScopeRequest(
      testContext,
      scope,
    );
    await fixture.run(async () => {
      await handler(options);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: expect.any(String) }),
      );
      expect(await manager.listPendingRecords()).toHaveLength(0);
    });
  });
});
