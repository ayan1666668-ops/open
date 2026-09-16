import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  resolveManualCompactionCliTarget,
  resolvePersistedSessionRuntimeId,
} from "./session-runtime-compat.js";

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
    expect(resolvePersistedSessionRuntimeId(entry)).toBe("fixture-cli");
  });

  it("does not recover intent from history, a binding, or a reset's previous selection", () => {
    const history: Partial<SessionEntry> = {
      agentHarnessId: "fixture-cli",
      modelSelectionLocked: true,
      cliSessionBindings: { "fixture-cli": { sessionId: "old-handle" } },
    };
    expect(resolvePersistedSessionRuntimeId(history)).toBeUndefined();
    expect(resolveManualCompactionCliTarget({ entry: history })).toEqual({});
    history.executionSelection = {
      state: "deferred",
      request: {},
      fallbackPermission: "configured",
      previous: {
        model: { provider: "fixture", id: "old" },
        executor: { kind: "cli", id: "fixture-cli" },
      },
    };
    expect(resolvePersistedSessionRuntimeId(history)).toBeUndefined();
  });

  it("keeps native-managed ownership independent of concrete output", () => {
    expect(
      resolvePersistedSessionRuntimeId({
        agentHarnessId: "observed",
        executionSelection: {
          state: "accepted",
          selection: { model: "native-managed", executor: { kind: "harness", id: "native-app" } },
          fallbackPermission: "explicit",
        },
      }),
    ).toBe("native-app");
  });

  it("uses only the selected executor's transcript and account binding for compaction", () => {
    const binding = { sessionId: "selected-handle", authProfileId: "fixture:account" };
    expect(
      resolveManualCompactionCliTarget({
        entry: {
          ...selected,
          cliSessionBindings: {
            "fixture-cli": binding,
            "historical-cli": { sessionId: "old-handle" },
          },
        },
      }),
    ).toEqual({
      agentHarnessId: "fixture-cli",
      cliSessionBinding: binding,
      cliSessionId: binding.sessionId,
    });
    expect(resolveManualCompactionCliTarget({ entry: selected })).toEqual({
      agentHarnessId: "fixture-cli",
      cliSessionBinding: undefined,
      cliSessionId: undefined,
    });
  });
});
