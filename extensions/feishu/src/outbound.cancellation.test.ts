// Feishu tests cover cancellation during the outbound fanouts that send several messages.
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { FeishuClientCredentials } from "./client.js";

const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendStructuredCardFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() =>
  vi.fn((_account: FeishuClientCredentials) => ({ request: vi.fn() })),
);
const deliverCommentThreadTextMock = vi.hoisted(() => vi.fn());
const cleanupAmbientCommentTypingReactionMock = vi.hoisted(() => vi.fn(async () => false));

vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
  sendStickerFeishu: vi.fn(),
  shouldSuppressFeishuTextForVoiceMedia: () => false,
}));

vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  editMessageFeishu: vi.fn(),
  getMessageFeishu: vi.fn(),
  sendCardFeishu: sendCardFeishuMock,
  sendMessageFeishu: sendMessageFeishuMock,
  sendStructuredCardFeishu: sendStructuredCardFeishuMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./drive.js", () => ({
  deliverCommentThreadText: deliverCommentThreadTextMock,
}));

vi.mock("./comment-reaction.js", () => ({
  cleanupAmbientCommentTypingReaction: cleanupAmbientCommentTypingReactionMock,
}));

import { feishuPlugin } from "./channel.js";
import { feishuOutbound } from "./outbound.js";

afterAll(() => {
  vi.doUnmock("./media.js");
  vi.doUnmock("./send.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./drive.js");
  vi.doUnmock("./comment-reaction.js");
  vi.resetModules();
});

describe("feishu outbound cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageFeishuMock.mockResolvedValue({ messageId: "text_msg" });
    sendCardFeishuMock.mockResolvedValue({ messageId: "native_card_msg" });
    sendStructuredCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
    sendMediaFeishuMock.mockResolvedValue({ messageId: "media_msg" });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "feishu", source: "test", plugin: feishuPlugin }]),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  const longText = Array.from(
    { length: 400 },
    (_entry, index) => `Line ${index} of a long outbound reply.`,
  ).join("\n");

  function abortingDelivery() {
    const controller = new AbortController();
    const delivered: string[] = [];
    return {
      controller,
      delivered,
      onDeliveryResult: (result: { messageId?: string }) => {
        delivered.push(result.messageId ?? "");
      },
      // Synchronous on purpose: the senders await whatever comes back, and an async
      // implementation here would hand a promise to a mock typed for a void return.
      abortOnFirst: (mock: ReturnType<typeof vi.fn>, result: Record<string, unknown>) => {
        mock.mockImplementation(() => {
          controller.abort();
          return result;
        });
      },
    };
  }

  function abortName(outcome: unknown): string {
    return outcome instanceof Error ? outcome.name : String(outcome);
  }

  // Core checks the delivery signal before every text unit it cuts itself. This channel
  // renders and cuts its own text, so a cancellation raised while its messages are going
  // out only reaches the next payload unless the same question is asked here.
  it("stops the formatted text fanout at the first abort", async () => {
    const run = abortingDelivery();
    run.abortOnFirst(sendMessageFeishuMock, { messageId: "text_msg" });
    // The case only means anything while the text needs more than one message.
    expect(longText.length).toBeGreaterThan(4000);

    const outcome = await feishuOutbound
      .sendFormattedText?.({
        cfg: {} as ClawdbotConfig,
        to: "chat_1",
        text: longText,
        accountId: "main",
        signal: run.controller.signal,
        onDeliveryResult: run.onDeliveryResult,
      } as never)
      .catch((error: unknown) => error);

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    // An abort is not a send failure, and the message the peer already has is still ours
    // to report, so it reaches the caller before the cancellation does.
    expect(abortName(outcome)).toBe("AbortError");
    expect(run.delivered).toEqual(["text_msg"]);
  });

  // The same fanout, one function further in: a comment thread takes as many replies as
  // the cut produced.
  it("stops the comment thread fanout at the first abort", async () => {
    const run = abortingDelivery();
    run.abortOnFirst(deliverCommentThreadTextMock, {
      delivery_mode: "reply_comment",
      reply_id: "reply_1",
    });

    const outcome = await feishuOutbound
      .sendFormattedText?.({
        cfg: {} as ClawdbotConfig,
        to: "comment:docx:doc_token_1:comment_1",
        text: longText,
        accountId: "main",
        signal: run.controller.signal,
        onDeliveryResult: run.onDeliveryResult,
      } as never)
      .catch((error: unknown) => error);

    expect(deliverCommentThreadTextMock).toHaveBeenCalledTimes(1);
    expect(abortName(outcome)).toBe("AbortError");
    expect(run.delivered).toEqual(["reply_1"]);
  });

  // A caption and its attachment are two sends inside one media delivery, and core asks
  // the question once for the pair.
  it("stops before the attachment when the caption send is aborted", async () => {
    const run = abortingDelivery();
    run.abortOnFirst(sendMessageFeishuMock, { messageId: "text_msg" });

    const outcome = await feishuOutbound
      .sendMedia?.({
        cfg: {} as ClawdbotConfig,
        to: "chat_1",
        text: "Here is the chart.",
        mediaUrl: "https://example.test/chart.png",
        accountId: "main",
        signal: run.controller.signal,
        onDeliveryResult: run.onDeliveryResult,
      } as never)
      .catch((error: unknown) => error);

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(abortName(outcome)).toBe("AbortError");
  });
});
