import { describe, expect, it } from "vitest";
import {
  armPendingAuthoritativeTerminalForHistory,
  reconcileAuthoritativeTerminalHistory,
  rememberAuthoritativeTerminal,
  rememberLiveTerminalRun,
} from "./terminal-message-identity.ts";

function persistedFinal() {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Final answer" }],
    __openclaw: { id: "final-message" },
  };
}

describe("deferred authoritative terminals", () => {
  it("retires the live copy once the run clears after an active-run persist", () => {
    const host = {};
    const liveTerminal = rememberLiveTerminalRun(
      { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
      "run-1",
    );

    // The persisted final lands while the run still reads active: without a
    // deferred record the live copy has no dedup owner yet (#149153).
    rememberAuthoritativeTerminal({
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      host,
      matchesChat: true,
      payload: { message: persistedFinal(), messageId: "final-message" },
      runIdBeforeApply: "run-1",
    });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [liveTerminal],
        sessionKey: "main",
        visibleMessages: [persistedFinal()],
      }),
    ).toEqual([liveTerminal]);

    // The history reload that carries the persisted terminal arms the deferred
    // record, so that same reconcile retires the live copy instead of stacking
    // two renders — this is the path chat.final already reaches.
    armPendingAuthoritativeTerminalForHistory({
      host,
      sessionKey: "main",
      visibleMessages: [persistedFinal()],
    });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [liveTerminal],
        sessionKey: "main",
        visibleMessages: [persistedFinal()],
      }),
    ).toEqual([]);
  });

  it("keeps the deferred terminal pending until its own history arrives", () => {
    const host = {};
    const liveTerminal = rememberLiveTerminalRun(
      { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
      "run-1",
    );
    rememberAuthoritativeTerminal({
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      host,
      matchesChat: true,
      payload: { message: persistedFinal(), messageId: "final-message" },
      runIdBeforeApply: "run-1",
    });

    armPendingAuthoritativeTerminalForHistory({
      host,
      sessionKey: "main",
      visibleMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Other reply" }],
          __openclaw: { id: "other-message" },
        },
      ],
    });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [liveTerminal],
        sessionKey: "main",
        visibleMessages: [persistedFinal()],
      }),
    ).toEqual([liveTerminal]);

    // The owning terminal's own history still retires it.
    armPendingAuthoritativeTerminalForHistory({
      host,
      sessionKey: "main",
      visibleMessages: [persistedFinal()],
    });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [liveTerminal],
        sessionKey: "main",
        visibleMessages: [persistedFinal()],
      }),
    ).toEqual([]);
  });

  it("still arms immediately when the run is already clear", () => {
    const host = {};
    const liveTerminal = rememberLiveTerminalRun(
      { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
      "run-1",
    );
    rememberAuthoritativeTerminal({
      event: { key: "main", runId: "run-1", hasActiveRun: false },
      host,
      matchesChat: true,
      payload: { message: persistedFinal(), messageId: "final-message" },
      runIdBeforeApply: "run-1",
    });

    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [liveTerminal],
        sessionKey: "main",
        visibleMessages: [persistedFinal()],
      }),
    ).toEqual([]);
  });
});
