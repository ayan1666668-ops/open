// Install the shared runtime and store boundaries before importing their consumers.
// oxfmt-ignore
import {
  dispatchCronDeliveryMock,
  getModelRefStatusMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  readSessionMessagesAsyncMock,
  resolveCronSessionMock,
  resolveConfiguredModelRefMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";
import { describe, expect, it } from "vitest";
import { getModelRefStatus } from "../../agents/model-selection-shared.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { commitSessionExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const sourceSessionKey = "agent:default:telegram:direct:42";

function embeddedPrompt(): string {
  const prompt = runEmbeddedAgentMock.mock.calls[0]?.[0]?.prompt;
  if (typeof prompt !== "string") {
    throw new Error("expected embedded run prompt");
  }
  return prompt;
}

describe("runCronIsolatedAgentTurn — current conversation context", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("prepends the bound source conversation to a current-target payload", async () => {
    mockRunCronFallbackPassthrough();
    const sourceSessionEntry = makeCronSessionEntry({
      sessionId: "source-session",
      lifecycleRevision: "source-revision",
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({ store: { [sourceSessionKey]: sourceSessionEntry } }),
    );
    readSessionMessagesAsyncMock.mockResolvedValue([
      { role: "user", content: "Otters hold hands while sleeping." },
      { role: "assistant", content: "Got it." },
    ]);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          sessionKey: sourceSessionKey,
          sessionTarget: "current",
          payload: { kind: "agentTurn", message: "Summarize the animal fact." },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(readSessionMessagesAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry: sourceSessionEntry,
        sessionId: "source-session",
        sessionKey: sourceSessionKey,
      }),
      { mode: "recent", maxBytes: 256 * 1024, maxLines: 220, maxMessages: 220 },
    );
    expect(embeddedPrompt()).toContain(
      "Recent conversation:\n- User: Otters hold hands while sleeping.\n- Assistant: Got it.\n\nSummarize the animal fact.",
    );
    expect(dispatchCronDeliveryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSessionKey,
        sourceSessionGeneration: {
          sessionId: "source-session",
          lifecycleRevision: "source-revision",
        },
      }),
    );
  });

  it.each(["configured", "explicit"] as const)(
    "inherits the source thread's parent selection with %s fallback permission",
    async (fallbackPermission) => {
      mockRunCronFallbackPassthrough();
      resolveConfiguredModelRefMock.mockReturnValue({ provider: "fixture", model: "default" });
      getModelRefStatusMock.mockImplementation(getModelRefStatus);
      const parentKey = "agent:default:webchat:channel:parent";
      const threadKey = `${parentKey}:thread:child`;
      const parent: SessionEntry = {
        sessionId: "parent-session",
        lifecycleRevision: "parent-revision",
        updatedAt: 1,
      };
      const selection = {
        model: { provider: "fixture", id: "parent" },
        executor: { kind: "harness" as const, id: "openclaw" },
      };
      commitSessionExecutionSelection(parent, selection, {
        cause: { kind: "initialize", fallbackPermission },
      });
      const source: SessionEntry = {
        sessionId: "source-session",
        lifecycleRevision: "source-revision",
        updatedAt: 1,
        executionSelection: {
          state: "deferred",
          request: { defaultSelection: "inherit" },
          fallbackPermission: "configured",
        },
      };
      const sourceBefore = structuredClone(source);
      const session = makeCronSession({ store: { [threadKey]: source } });
      resolveCronSessionMock.mockReturnValue(session);
      expect(source.executionSelection).toMatchObject({
        state: "deferred",
        request: { defaultSelection: "inherit" },
      });
      const parentScope = {
        agentId: "default",
        sessionKey: parentKey,
        storePath: session.storePath,
      };
      await replaceSessionEntry(parentScope, parent);
      expect(loadSessionEntryReadOnly(parentScope)?.executionSelection).toEqual(
        parent.executionSelection,
      );
      const result = await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          cfg: {
            agents: {
              defaults: {
                model: "fixture/default",
                models: { "fixture/default": {}, "fixture/parent": {} },
              },
            },
          },
          job: makeIsolatedAgentJobFixture({
            sessionKey: threadKey,
            sessionTarget: "current",
          }),
        }),
      );
      expect(result.status).toBe("ok");
      expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "fixture",
          model: "parent",
          agentHarnessRuntimeOverride: "openclaw",
        }),
      );
      expect(session.sessionEntry.executionSelection).toEqual({
        state: "accepted",
        selection,
        fallbackPermission,
      });
      expect(source).toEqual(sourceBefore);
    },
  );

  it("leaves isolated-target payloads unchanged", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        store: {
          [sourceSessionKey]: makeCronSessionEntry({ sessionId: "source-session" }),
        },
      }),
    );
    readSessionMessagesAsyncMock.mockResolvedValue([
      { role: "user", content: "This must not be carried." },
    ]);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          sessionKey: sourceSessionKey,
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "Run independently." },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(readSessionMessagesAsyncMock).not.toHaveBeenCalled();
    expect(embeddedPrompt()).toContain("Run independently.");
    expect(embeddedPrompt()).not.toContain("Recent conversation:");
  });
});
