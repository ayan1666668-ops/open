import { afterEach, describe, expect, it, vi } from "vitest";
import { abortContinuationDispatchClaims } from "./continuation-dispatch-claims.js";
import { registerContinuationDelegateDispatchClaim } from "./delegate-spawn-authority.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("continuation delegate claim construction", () => {
  it("does not register a claim when loading owner identity throws", () => {
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    const ownerSessionKey = "agent:main:owner-load-throws";

    expect(() =>
      registerContinuationDelegateDispatchClaim({
        controller: "pending",
        delegate: { task: "must not leak a claim" },
        ownerSession: {
          agentId: "main",
          load: () => {
            throw new Error("owner store unavailable");
          },
        },
        ownerSessionKey,
      }),
    ).toThrow("owner store unavailable");

    abortContinuationDispatchClaims(ownerSessionKey);
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it("rejects a missing source owner before registering a claim", () => {
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    const ownerSessionKey = "agent:main:missing-owner";

    expect(() =>
      registerContinuationDelegateDispatchClaim({
        controller: "pending",
        delegate: { task: "must not register" },
        ownerSession: { agentId: "main", load: () => undefined },
        ownerSessionKey,
      }),
    ).toThrow("Continuation delegate source session owner is unavailable.");

    abortContinuationDispatchClaims(ownerSessionKey);
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it.each(["gateway-dispatch", "final-acceptance"] as const)(
    "rejects an owner deleted before %s",
    (boundary) => {
      const ownerSessionKey = `agent:main:deleted-${boundary}`;
      let current: { sessionId: string; lifecycleRevision: string; updatedAt: number } | undefined =
        {
          sessionId: "session-1",
          lifecycleRevision: "revision-1",
          updatedAt: 1,
        };
      const claim = registerContinuationDelegateDispatchClaim({
        controller: "pending",
        delegate: { task: "owned delegate" },
        ownerSession: { agentId: "main", load: () => current },
        ownerSessionKey,
      });
      current = undefined;

      expect(() => claim.authority.assertCurrent(boundary, null)).toThrow(
        "Continuation delegate source session lifecycle changed.",
      );
      claim.release();
    },
  );

  it("returns the persisted owner and rejects a replaced lifecycle", () => {
    const ownerSessionKey = "agent:main:owner";
    let current = {
      sessionId: "session-1",
      lifecycleRevision: "revision-1",
      updatedAt: 1,
    };
    const claim = registerContinuationDelegateDispatchClaim({
      controller: "pending",
      delegate: { task: "owned delegate" },
      ownerSession: {
        agentId: "main",
        load: () => current,
      },
      ownerSessionKey,
    });

    expect(claim.ownerAgentId).toBe("main");
    expect(() => claim.authority.assertCurrent("gateway-dispatch")).not.toThrow();
    current = {
      sessionId: "session-2",
      lifecycleRevision: "revision-2",
      updatedAt: 2,
    };
    expect(() => claim.authority.assertCurrent("registry-acceptance")).toThrow(
      "Continuation delegate source session lifecycle changed.",
    );
    claim.release();
  });
});
