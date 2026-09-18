import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { resolveAcceptedSessionRuntimeId } from "./session-runtime-compat.js";

const selected: Partial<SessionEntry> = {
  executionSelection: {
    state: "accepted",
    selection: {
      model: { provider: "fixture", id: "selected" },
      executor: { kind: "cli", id: "fixture-cli" },
    },
    fallbackPermission: "explicit",
  },
};

describe("accepted execution authority", () => {
  it("keeps the accepted executor when observed output and requested provider differ", () => {
    const entry = { ...selected, agentHarnessId: "observed", modelSelectionLocked: true };
    expect(resolveAcceptedSessionRuntimeId(entry)).toBe("fixture-cli");
  });

  it("does not recover intent from history, a binding, or a reset's previous selection", () => {
    const history: Partial<SessionEntry> = {
      agentHarnessId: "fixture-cli",
      modelSelectionLocked: true,
      cliSessionBindings: { "fixture-cli": { sessionId: "old-handle" } },
    };
    expect(resolveAcceptedSessionRuntimeId(history)).toBeUndefined();
    history.executionSelection = {
      state: "deferred",
      request: {},
      fallbackPermission: "configured",
      previous: {
        model: { provider: "fixture", id: "old" },
        executor: { kind: "cli", id: "fixture-cli" },
      },
    };
    expect(resolveAcceptedSessionRuntimeId(history)).toBeUndefined();
  });

  it("keeps native-managed ownership independent of concrete output", () => {
    const entry: Partial<SessionEntry> = {
      agentHarnessId: "observed",
      executionSelection: {
        state: "accepted",
        selection: { model: "native-managed", executor: { kind: "harness", id: "native-app" } },
        fallbackPermission: "explicit",
      },
    };
    expect(resolveAcceptedSessionRuntimeId(entry)).toBe("native-app");
  });
});
