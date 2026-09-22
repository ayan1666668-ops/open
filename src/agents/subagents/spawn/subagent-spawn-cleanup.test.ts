import { describe, expect, it, vi } from "vitest";
import type { callGateway } from "../../../gateway/call.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  cleanupProvisionalSession,
  terminateAcceptedCollectorRun,
} from "./subagent-spawn-cleanup.js";

// Mirrors the module-local GatewayCall parameter. Declaring it keeps
// callGateway.mock.calls a one-element tuple so request assertions can
// destructure it instead of indexing an empty tuple.
type GatewayRequest = Parameters<typeof callGateway>[0];

function sessionChangedError(): Error {
  return Object.assign(new Error("session changed"), {
    name: "GatewayClientRequestError",
    gatewayCode: "INVALID_REQUEST",
    details: { reason: "session-changed" },
  });
}

describe("subagent spawn cleanup identity", () => {
  it("returns truthful one-shot termination confirmation", async () => {
    const confirmedGateway = vi.fn(async () => ({
      ok: true,
      aborted: true,
      runIds: ["gateway-run"],
    }));
    await expect(
      terminateAcceptedCollectorRun({
        childSessionKey: "agent:main:subagent:child",
        gatewayRunId: "gateway-run",
        retry: false,
        sessionCleanup: "preserve",
        callGateway: confirmedGateway,
      }),
    ).resolves.toBe(true);

    const unavailableGateway = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });
    await expect(
      terminateAcceptedCollectorRun({
        childSessionKey: "agent:main:subagent:child",
        gatewayRunId: "gateway-run",
        retry: false,
        sessionCleanup: "preserve",
        callGateway: unavailableGateway,
      }),
    ).resolves.toBe(false);
    expect(unavailableGateway).toHaveBeenCalledOnce();
  });

  it("requires both frozen session identities before deletion", async () => {
    const callGateway = vi.fn();

    await expect(
      cleanupProvisionalSession("agent:main:subagent:child", {
        expectedSessionId: "session-id",
        callGateway,
      }),
    ).resolves.toBe(false);

    expect(callGateway).not.toHaveBeenCalled();
  });

  // Ronan's ruling on the fourth absorb: termination is the ONLY place the live
  // ownership predicate is consumed. When ownership flips after acceptance but before
  // cleanup, termination makes one bounded attempt and must not delete a
  // successor-owned session or retry.
  it("makes one bounded attempt and deletes nothing once cleanup ownership has flipped", async () => {
    const callGateway = vi.fn(async (_request: GatewayRequest) => ({
      ok: true,
      aborted: false,
      runIds: [],
    }));

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      expectedSessionId: "session-id",
      expectedLifecycleRevision: "session-revision",
      isCurrent: () => false,
      callGateway,
    });

    // No successor-owned session deletion.
    expect(
      callGateway.mock.calls.filter(
        ([request]) => (request as { method?: string }).method === "sessions.delete",
      ),
    ).toHaveLength(0);
    // Bounded: the conjunctive shouldRetry short-circuits on the flipped predicate,
    // so there is no second abort attempt either.
    expect(
      callGateway.mock.calls.filter(
        ([request]) => (request as { method?: string }).method === "chat.abort",
      ).length,
    ).toBeLessThanOrEqual(1);
  });

  it("accepts chat.abort only when it confirms the exact run", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, aborted: false, runIds: [] })
      .mockResolvedValueOnce({ deleted: true });

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      expectedSessionId: "session-id",
      expectedLifecycleRevision: "session-revision",
      callGateway,
    });

    expect(callGateway).toHaveBeenNthCalledWith(2, {
      method: "sessions.delete",
      params: {
        key: "agent:main:subagent:child",
        emitLifecycleHooks: false,
        deleteTranscript: true,
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
      },
      timeoutMs: 60_000,
    });
  });

  it("does not delete after chat.abort confirms the matching run", async () => {
    const callGateway = vi.fn(async () => ({
      ok: true,
      aborted: true,
      runIds: ["gateway-run"],
    }));

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      expectedSessionId: "session-id",
      expectedLifecycleRevision: "session-revision",
      callGateway,
    });

    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("stops without deleting a durable session when the accepted run already ended", async () => {
    const callGateway = vi.fn(async () => ({
      ok: true,
      aborted: false,
      runIds: [],
    }));

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      sessionCleanup: "preserve",
      callGateway,
    });

    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("retries abort without deleting a durable session after a gateway error", async () => {
    const callGateway = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValueOnce({ ok: true, aborted: false, runIds: [] });

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      sessionCleanup: "preserve",
      callGateway,
    });

    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(callGateway).toHaveBeenNthCalledWith(2, {
      method: "chat.abort",
      params: {
        sessionKey: "agent:main:subagent:child",
        runId: "gateway-run",
      },
      timeoutMs: 60_000,
    });
  });

  it("stops accepted-run cleanup when its Gateway request owner is retired", async () => {
    const callGateway = vi
      .fn()
      .mockRejectedValueOnce(new Error("Gateway request owner is retired"))
      .mockResolvedValue({ aborted: false, runIds: [] });

    await withPluginRuntimeGatewayRequestScope(
      { resolveGatewayContext: () => undefined, isWebchatConnect: () => false },
      () =>
        terminateAcceptedCollectorRun({
          childSessionKey: "agent:main:subagent:child",
          gatewayRunId: "gateway-run",
          sessionCleanup: "preserve",
          callGateway,
        }),
    );

    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("stops cleanup when guarded deletion observes a successor lifecycle", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, aborted: true, runIds: ["different-run"] })
      .mockRejectedValueOnce(sessionChangedError());

    // BELLED ROPE for an absorb that reverts our return contract. Upstream declares
    // terminateAcceptedCollectorRun as Promise<void> and this shared case asserted
    // toBeUndefined(). Our fork returns Promise<boolean> per Ronan's ruling on the
    // operator-authority merge, and that verdict is load-bearing: it is consumed by
    // subagent-spawn-rollback, subagent-registry-sweep-kill (both call sites), and
    // returned by subagent-registry. If this assertion has to go back to
    // toBeUndefined(), the boolean contract was dropped and those consumers are
    // silently reading undefined.
    //
    // true is the truthful verdict here, not a success claim about deletion: the
    // abort confirmed a DIFFERENT run, so deletion was attempted and refused with
    // session-changed, which proves a successor owns the session. The accepted run
    // is therefore no longer ours to clean up.
    await expect(
      terminateAcceptedCollectorRun({
        childSessionKey: "agent:main:subagent:child",
        gatewayRunId: "gateway-run",
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
        callGateway,
      }),
    ).resolves.toBe(true);

    // Unchanged and the point of the case: bounded at exactly one abort plus one
    // guarded deletion, and no successor-owned session was deleted.
    expect(callGateway).toHaveBeenCalledTimes(2);
  });
});
