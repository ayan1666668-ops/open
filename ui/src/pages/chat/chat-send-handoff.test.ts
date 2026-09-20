// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { findChatSendPayload, makeChatHost } from "./chat-host.test-support.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";

beforeEach(() => {
  installOutboxBrowserStorage();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([false, true].flatMap((attachment) => [false, true].map((peer) => ({ attachment, peer }))))(
  "retains foreground leaf ownership during input handoff (attachment: $attachment, peer: $peer)",
  async ({ attachment, peer }) => {
    let releaseInput: (() => void) | undefined;
    vi.stubGlobal(
      "MessageChannel",
      class {
        port1 = {
          addEventListener: (_type: string, callback: () => void) => {
            releaseInput = callback;
          },
          start: () => undefined,
          close: () => undefined,
        };
        port2 = { postMessage: () => undefined, close: () => undefined };
      },
    );
    const history = createDeferred<ChatHistoryResult>();
    const snapshot: ChatHistoryResult = {
      messages: [],
      sessionInfo: {
        key: "agent:main:main",
        sessionId: "current-session",
        activeLeafEntryId: "terminal-leaf",
        kind: "direct",
        status: "done",
        updatedAt: 2,
      },
    };
    const host = makeChatHost({
      sessionKey: "agent:main:main",
      currentSessionId: "current-session",
      chatDisplayedLeafEntryId: "old-leaf",
      chatMessage: attachment ? "" : "Fresh follow-up",
      chatAttachments: attachment
        ? [
            {
              id: "follow-up-file",
              fileName: "follow-up.txt",
              mimeType: "text/plain",
              dataUrl: "data:text/plain;base64,aGVsbG8=",
            },
          ]
        : [],
      requestHandlers: {
        "chat.history": () => history.promise,
        "chat.send": { status: "started", messageSeq: 1 },
      },
    });
    const loading = loadChatHistory(host, { deferBranches: true });
    const sending = handleSendChat(host, undefined, undefined, new Event("submit"));
    await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
    expect(releaseInput).toBeTypeOf("function");
    try {
      history.resolve(snapshot);
      await loading;
      await resumeStoredChatOutboxes(peer ? { ...host, chatQueue: [] } : host);
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    } finally {
      releaseInput?.();
      await sending;
    }
    expect(findChatSendPayload(host)).toMatchObject({
      message: attachment ? "" : "Fresh follow-up",
      ...(attachment
        ? {
            attachments: [
              expect.objectContaining({ content: "aGVsbG8=", fileName: "follow-up.txt" }),
            ],
          }
        : {}),
      expectedLeafEntryId: "terminal-leaf",
    });
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  },
);

it.each(
  (["steer", "followup", "collect", undefined] as const).flatMap((queueMode) =>
    ["started", "in_flight"].map((status) => ({ queueMode, status })),
  ),
)("keeps the active reply on a $queueMode $status custody ACK", async ({ queueMode, status }) => {
  const acknowledgement = createDeferred<{ runId: string; status: string }>();
  const host = makeChatHost({
    chatMessage: "A follow-up while another participant's reply is streaming",
    chatRunId: "active-reply",
    chatStream: "Already visible response text",
    chatStreamStartedAt: 100,
    chatStreamSegments: [{ text: "Earlier live commentary", ts: 90, itemId: "commentary" }],
    chatRunStartup: { state: "activity", runId: "active-reply" },
    requestHandlers: { "chat.send": () => acknowledgement.promise },
  });
  const sending = handleSendChat(host, undefined, {
    followUpMode: queueMode,
  });
  await vi.waitFor(() => expect(host.request).toHaveBeenCalledWith("chat.send", expect.anything()));
  expect(host.chatStream).toBe("Already visible response text");
  acknowledgement.resolve({ runId: "accepted-input", status });
  await sending;
  expect(host.chatRunId).toBe("active-reply");
  expect(host.chatStream).toBe("Already visible response text");
  expect(host.chatStreamStartedAt).toBe(100);
  expect(host.chatStreamSegments).toEqual([
    { text: "Earlier live commentary", ts: 90, itemId: "commentary" },
  ]);
  expect(host.chatRunStartup).toEqual({ state: "activity", runId: "active-reply" });
});
