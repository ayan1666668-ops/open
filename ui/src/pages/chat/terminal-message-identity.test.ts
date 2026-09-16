import { describe, expect, it } from "vitest";
import {
  armPendingAuthoritativeTerminal,
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

    // The run-clear reconcile arms the deferred terminal, so the history reload
    // that follows retires the live copy instead of stacking two renders.
    armPendingAuthoritativeTerminal({ host, runId: "run-1", sessionKey: "main" });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [liveTerminal],
        sessionKey: "main",
        visibleMessages: [persistedFinal()],
      }),
    ).toEqual([]);
  });

  it("keeps the deferred terminal pending for a different run", () => {
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

    armPendingAuthoritativeTerminal({ host, runId: "run-2", sessionKey: "main" });
    expect(
      reconcileAuthoritativeTerminalHistory({
        host,
        previousMessages: [liveTerminal],
        sessionKey: "main",
        visibleMessages: [persistedFinal()],
      }),
    ).toEqual([liveTerminal]);

    // A later clear for the owning run still retires it.
    armPendingAuthoritativeTerminal({ host, runId: "run-1", sessionKey: "main" });
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
