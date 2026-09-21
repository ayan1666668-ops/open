import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { createChatSendReplyDispatch } from "../../../gateway/server-methods/chat-send-reply-dispatch.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";

registerAgentSessionLoopTestLifecycle();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .join("\n");
}

describe("pre-dispatch notice prompt exclusion", () => {
  it("keeps a reloaded routing notice out of the subsequent provider request", async () => {
    await withOpenClawTestState({ label: "pre-dispatch-notice-prompt" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "prompt-exclusion-session",
        sessionKey: "agent:main:prompt-exclusion",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });

      const original = SessionManager.open(target, state.workspaceDir);
      original.appendMessage({
        role: "user",
        content: "ordinary user context",
        timestamp: 1,
      });
      original.appendMessage(
        createAssistant(testModel, [{ type: "text", text: "ordinary assistant context" }]),
      );

      const notice = "Auto router: dispatching the selected provider.";
      const dispatch = createChatSendReplyDispatch({
        accountId: undefined,
        isAgentRunStarted: () => true,
        isRunCurrent: () => true,
        abortSignal: new AbortController().signal,
        logGateway: {
          ...createSubsystemLogger("test/pre-dispatch-notice-prompt-exclusion"),
          warn: () => {},
        },
        session: {
          agentId: target.agentId,
          backingSessionId: target.sessionId,
          cfg: {},
          clientRunId: "prompt-exclusion-run",
          sessionKey: target.sessionKey,
          sessionLoadOptions: { agentId: target.agentId },
        },
        userTurnRecorder: { markBlocked: () => {}, getAdmissionReceipt: () => undefined },
      });
      await expect(
        dispatch.onPreDispatchNotice({ text: notice, isStatusNotice: true }),
      ).resolves.toBe(true);

      const savedNotice = loadTranscriptEventsSync(target).find(
        (event) =>
          event &&
          typeof event === "object" &&
          "message" in event &&
          messageText((event as { message?: unknown }).message) === notice,
      );
      expect(savedNotice).toMatchObject({
        message: expect.objectContaining({
          excludeFromContext: true,
          __openclaw: { contextFreeCommand: true },
        }),
      });

      // Force a fresh SQLite read before constructing the next AgentSession.
      closeOpenClawAgentDatabasesForTest();
      const reloaded = SessionManager.open(target, state.workspaceDir);
      expect(reloaded.buildSessionContext().messages.map(messageText)).toEqual([
        "ordinary user context",
        "ordinary assistant context",
      ]);

      const providerRequests: unknown[][] = [];
      streamMocks.streamSimple.mockImplementation((model, context) => {
        providerRequests.push(structuredClone(context.messages));
        return createAssistantResultStream(
          createAssistant(model, [{ type: "text", text: "subsequent response" }]),
        );
      });
      const { session } = await createTestSession({ sessionManager: reloaded });
      try {
        await session.prompt("subsequent user request", {
          expandPromptTemplates: false,
        });
      } finally {
        session.dispose();
      }

      expect(providerRequests).toHaveLength(1);
      const request = providerRequests[0] ?? [];
      const requestText = JSON.stringify(request);
      expect(requestText).not.toContain(notice);
      expect(requestText).toContain("ordinary user context");
      expect(requestText).toContain("ordinary assistant context");
      expect(requestText).toContain("subsequent user request");
    });
  });
});
