import { describe, expect, it, vi } from "vitest";
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequest,
} from "../../infra/exec-approvals.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { approveSessionEnvironmentCommand } from "./environments.session-exec-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const binding = {
  environmentId: "worker:preview",
  ownerEpoch: 2,
  generation: 1,
  sessionId: "conversation",
  sessionKey: "agent:main:preview",
  agentId: "main",
};

describe("attached command approval custody", () => {
  for (const decision of ["allow-once", "deny"] as const) {
    it(`shows stdin and honors ${decision} exactly once`, async (test) => {
      const manager = createTestApprovalManager(test, {
        resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
      });
      const broadcast = vi.fn((_event: string, request: ExecApprovalRequest) => {
        expect(request.request.command).toContain("script-from-stdin");
        expect(request.request.allowedDecisions).toEqual(["allow-once", "deny"]);
        manager.resolve(request.id, decision, "reviewer");
      });
      const options = {
        client: null,
        context: {
          execApprovalManager: manager,
          broadcast,
          hasExecApprovalClients: () => true,
          logGateway: { error: vi.fn() },
        },
      } as unknown as GatewayRequestHandlerOptions;
      const operation = approveSessionEnvironmentCommand({
        options,
        binding,
        argv: ["node"],
        input: "console.log('script-from-stdin')",
        background: true,
        assertCurrent: () => {},
      });
      if (decision === "allow-once") {
        await expect(operation).resolves.toBeUndefined();
        const id = broadcast.mock.calls[0]![1].id;
        expect(manager.consumeAllowOnce(id)).toBe(false);
      } else {
        await expect(operation).rejects.toThrow("not approved");
      }
    });
  }

  it("refuses approval when the complete command cannot be shown", async (test) => {
    const manager = createTestApprovalManager(test);
    const broadcast = vi.fn();
    const options = {
      client: null,
      context: { execApprovalManager: manager, broadcast },
    } as unknown as GatewayRequestHandlerOptions;
    await expect(
      approveSessionEnvironmentCommand({
        options,
        binding,
        argv: ["node"],
        input: "x".repeat(20_000),
        background: false,
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("too large to review");
    expect(broadcast).not.toHaveBeenCalled();
  });
});
