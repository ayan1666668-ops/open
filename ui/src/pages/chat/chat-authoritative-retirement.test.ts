// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { assistantStreamPartOccurrence } from "./chat-progress.ts";
import {
  getChatSessionProjection,
  publishChatSessionProjectionMessages,
  readChatSessionProjectionScope,
} from "./history-merge.ts";
import { reconcileChatRunFromSessionRow } from "./run-lifecycle.ts";
import {
  appendTerminalAssistantMessage,
  visibleAssistantStreamParts,
} from "./stream-reconciliation.ts";
import {
  authoritativeHistoryAppliedForRun,
  rememberAuthoritativeTerminal,
} from "./terminal-message-identity.ts";

function message(text: string, metadata?: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    ...(metadata ? { __openclaw: metadata } : {}),
  };
}

function fixture(shape: "single" | "combined" | "ambiguous" | "adopted" = "single") {
  const user = {
    role: "user",
    content: "Ask",
    __openclaw: { id: "prompt", seq: 1, idempotencyKey: "run-1:user" },
  };
  const saved = message("First. Second.", { id: "answer", seq: 2 });
  const savedMessages: unknown[] = [
    user,
    saved,
    ...(shape === "ambiguous" ? [message("First. Second.", { id: "answer", seq: 3 })] : []),
  ];
  const history: { messages: unknown[]; sessionId?: string } = { messages: savedMessages };
  const state = makeChatHost({
    sessionKey: "agent:main:main",
    chatRunId: "run-1",
    chatStream: "First. Second.",
    chatStreamStartedAt: 2,
    chatStreamSegments: shape === "combined" ? [{ text: "First. ", ts: 1, runId: "run-1" }] : [],
    chatMessages: [
      user,
      ...(shape === "adopted" ? [message("Earlier saved text.", { id: "answer", seq: 2 })] : []),
    ],
    requestHandlers: { "chat.history": () => structuredClone(history) },
  });
  const before = visibleAssistantStreamParts(state, { isHiddenStreamText: () => false }).map(
    (part) => assistantStreamPartOccurrence(state, part),
  );
  const scope = readChatSessionProjectionScope(state, { agentId: "main" });
  getChatSessionProjection(state, scope);
  const retire = () =>
    reconcileChatRunFromSessionRow(
      state,
      {
        key: state.sessionKey,
        kind: "direct",
        lastRunId: "run-1",
        status: "done",
        hasActiveRun: false,
      },
      { publishRunStatus: false },
    );
  const remember = (runIdBeforeApply: string | null = state.chatRunId) =>
    rememberAuthoritativeTerminal({
      host: state,
      event: { key: state.sessionKey, clientRunId: "run-1", hasActiveRun: false },
      matchesChat: true,
      payload: { message: saved },
      runIdBeforeApply,
      scope,
    });
  return { state, saved, savedMessages, history, scope, before, retire, remember };
}

function keys(state: ReturnType<typeof fixture>["state"]) {
  const result = getChatSessionProjection(state).entries.flatMap((entry) =>
    entry.occurrenceKey ? [entry.occurrenceKey] : [],
  );
  expect(new Set(result).size).toBe(result.length);
  return result;
}

describe("authoritative terminal history retirement", () => {
  it.each(["pane-first", "subscription-first", "main-alias"] as const)(
    "consumes a terminal body for %s",
    async (arrival) => {
      const f = fixture();
      f.history.sessionId = "learned-session";
      if (arrival !== "pane-first") {
        f.retire();
        expect(f.state.chatRunId).toBeNull();
        if (arrival === "main-alias" && f.state.lastLocalTerminalReconcile) {
          f.state.lastLocalTerminalReconcile.sessionKey = "main";
        }
      }
      f.remember();
      if (arrival === "pane-first") {
        f.retire();
      }
      for (let reload = 0; reload < 2; reload += 1) {
        await loadChatHistory(f.state, { deferBranches: true });
        expect(f.state.lastError).toBeNull();
        expect(f.state.chatMessages).toEqual(f.savedMessages);
        expect(keys(f.state)).toEqual(f.before);
        expect(getChatSessionProjection(f.state).entries.at(-1)?.displayRunId).toBe("run-1");
        expect(getChatSessionProjection(f.state).scope.sessionId).toBe("learned-session");
      }
      for (const runId of ["run-1", "different-run"]) {
        handleChatGatewayEvent(f.state, {
          sessionKey: f.state.sessionKey,
          runId,
          state: "final",
          message: message("First. Second."),
        });
        expect(f.state.chatMessages).toHaveLength(runId === "run-1" ? 2 : 3);
      }
      expect(f.saved).toEqual(message("First. Second.", { id: "answer", seq: 2 }));
    },
  );

  it("does not treat a retained native-ID live row as a snapshot receipt", async () => {
    const f = fixture();
    handleChatGatewayEvent(f.state, {
      sessionKey: f.state.sessionKey,
      runId: "run-1",
      state: "final",
      message: f.saved,
    });
    f.remember("run-1");
    f.savedMessages.splice(1);
    await loadChatHistory(f.state, { deferBranches: true });
    expect(f.state.lastError).toBeNull();
    expect(authoritativeHistoryAppliedForRun(f.state, "run-1")).toBe(false);
    expect(f.state.chatMessages).toHaveLength(2);
    expect(keys(f.state)).toEqual(f.before);
  });

  it.each(["combined", "ambiguous", "adopted"] as const)(
    "resets occurrence ownership for %s output",
    async (shape) => {
      const f = fixture(shape);
      f.retire();
      f.remember();
      await loadChatHistory(f.state, { deferBranches: true });
      expect(f.state.lastError).toBeNull();
      expect(f.state.chatMessages).toEqual(f.savedMessages);
      expect(keys(f.state)).toEqual([]);
      expect(getChatSessionProjection(f.state).entries.at(-1)?.displayRunId).toBe(
        shape === "ambiguous" ? undefined : "run-1",
      );
    },
  );

  it.each(["foreign", "unknown", "keyed", "durable"] as const)(
    "preserves %s same-text predecessors in the receipt interval",
    async (kind) => {
      const f = fixture();
      const retained = {
        ...message(
          "First. Second.",
          kind === "durable" ? { id: "other-saved", seq: 3, runId: "run-1" } : undefined,
        ),
        openclawStreamFallback: {
          replacementText: "First. Second.",
          source: "segment",
          ...(kind === "unknown" ? {} : { runId: kind === "foreign" ? "foreign-run" : "run-1" }),
          ...(kind === "keyed" ? { itemId: "commentary" } : {}),
        },
      };
      f.retire();
      // Publish through history so the retained row is a canonical, admitted predecessor.
      const projection = getChatSessionProjection(f.state);
      publishChatSessionProjectionMessages(f.state, [...projection.messages, retained]);
      if (kind === "durable") {
        f.savedMessages.push(retained);
      }
      f.remember();
      await loadChatHistory(f.state, { deferBranches: true });
      expect(f.state.lastError).toBeNull();
      expect(f.state.chatMessages).toContainEqual(retained);
      expect(f.state.chatMessages).toHaveLength(3);
      expect(
        getChatSessionProjection(f.state).entries.find((entry) => entry.identity?.id === "answer")
          ?.occurrenceKey,
      ).toBe(f.before[0]);
    },
  );

  it.each(["missing", "imported", "foreign-run", "session", "agent", "leaf"] as const)(
    "does not retire for a %s target or receipt scope",
    async (invalid) => {
      const f = fixture();
      f.retire();
      f.remember();
      if (invalid === "missing") {
        f.savedMessages.splice(1);
      } else if (invalid === "imported") {
        f.savedMessages[1] = message("First. Second.", {
          id: "answer",
          seq: 2,
          importedFrom: "external",
          externalId: "answer",
          cliSessionId: "foreign",
        });
      } else if (invalid === "foreign-run") {
        f.savedMessages[1] = message("First. Second.", {
          id: "answer",
          seq: 2,
          runId: "foreign-run",
        });
      } else {
        // Capture a receipt from a different owned scope, not a matching-text heuristic.
        rememberAuthoritativeTerminal({
          host: f.state,
          event: { key: f.state.sessionKey, clientRunId: "run-1", hasActiveRun: false },
          matchesChat: true,
          payload: { message: f.saved },
          runIdBeforeApply: "run-1",
          scope: {
            ...f.scope,
            ...(invalid === "session"
              ? { sessionId: "old-session" }
              : invalid === "agent"
                ? { agentId: "other" }
                : { activeLeafEntryId: "old-leaf" }),
          },
        });
      }
      await loadChatHistory(f.state, { deferBranches: true });
      expect(f.state.lastError).toBeNull();
      expect(authoritativeHistoryAppliedForRun(f.state, "run-1")).toBe(false);
      expect(keys(f.state)).toEqual(f.before);
      expect(getChatSessionProjection(f.state).entries.some((entry) => entry.live)).toBe(true);
    },
  );

  it.each(["session", "agent", "opposing-run", "missing"] as const)(
    "does not borrow a %s terminal tombstone",
    async (invalid) => {
      const f = fixture();
      f.retire();
      const recent = expectDefined(f.state.lastLocalTerminalReconcile, "terminal tombstone");
      f.state.lastLocalTerminalReconcile =
        invalid === "missing"
          ? null
          : {
              ...recent,
              sessionKey: invalid === "session" ? "agent:main:other" : f.state.sessionKey,
              agentId: invalid === "agent" ? "other" : "main",
            };
      rememberAuthoritativeTerminal({
        host: f.state,
        event: {
          key: f.state.sessionKey,
          clientRunId: "run-1",
          hasActiveRun: false,
          ...(invalid === "opposing-run" ? { runId: "other-run" } : {}),
        },
        matchesChat: true,
        payload: { message: f.saved },
        runIdBeforeApply: null,
        scope: f.scope,
      });
      await loadChatHistory(f.state, { deferBranches: true });
      expect(authoritativeHistoryAppliedForRun(f.state, "run-1")).toBe(false);
      expect(f.state.chatMessages).toHaveLength(3);
      expect(keys(f.state)).toEqual(f.before);
    },
  );

  it("rejects a conflicting target at the consumption boundary", () => {
    const fallback = {
      ...message("Same text"),
      openclawStreamFallback: { source: "current", runId: "run-1" },
    };
    const target = message("Same text", { id: "saved", runId: "foreign-run" });
    const messages = [fallback, target];
    expect(appendTerminalAssistantMessage(messages, target, { authoritativeRunId: "run-1" })).toBe(
      messages,
    );
  });
});
