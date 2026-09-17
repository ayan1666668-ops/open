// Feishu tests cover the custody handoff each physical message of an outbound fanout owes.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
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
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
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

const CUSTODY_LOST = "Feishu outbound custody changed before this message.";

type HandoffStep = "refresh" | "fence" | "send";

// Records the order core requires around every recipient-visible send: refresh the durable
// timing, fence custody synchronously, then call the transport with nothing awaited in
// between. A microtask queued by the fence has not run yet while the transport call still
// sits in the fence's own synchronous stack, so `drainedAtSend` reads false only while that
// gap stays closed.
function handoffRecorder() {
  const steps: HandoffStep[] = [];
  const drainedAtSend: boolean[] = [];
  let fenceMicrotaskDrained = false;
  let fenceCalls = 0;
  let failFenceCall: number | undefined;
  return {
    steps,
    drainedAtSend,
    failFenceAt: (call: number) => {
      failFenceCall = call;
    },
    counts: () => ({
      refresh: steps.filter((step) => step === "refresh").length,
      fence: steps.filter((step) => step === "fence").length,
      send: steps.filter((step) => step === "send").length,
    }),
    hooks: {
      onPlatformSendDispatch: async () => {
        steps.push("refresh");
      },
      assertDirectAdapterHandoff: () => {
        fenceCalls += 1;
        steps.push("fence");
        fenceMicrotaskDrained = false;
        queueMicrotask(() => {
          fenceMicrotaskDrained = true;
        });
        if (fenceCalls === failFenceCall) {
          // The shape core throws when the writer that owns this answer is revoked or
          // replaced: a permanent no-dispatch rejection for the message that was about to go.
          throw new PlatformMessageNotDispatchedError(CUSTODY_LOST, {
            cause: undefined,
            retryable: false,
          });
        }
      },
    },
    recordSend: <T>(result: T): T => {
      steps.push("send");
      drainedAtSend.push(fenceMicrotaskDrained);
      return result;
    },
  };
}

describe("feishu outbound custody handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageFeishuMock.mockResolvedValue({ messageId: "text_msg" });
    sendStructuredCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
    sendMediaFeishuMock.mockResolvedValue({ messageId: "media_msg" });
    sendCardFeishuMock.mockResolvedValue({ messageId: "card_msg", chatId: "chat_1" });
    deliverCommentThreadTextMock.mockResolvedValue({
      delivery_mode: "reply_comment",
      reply_id: "reply_1",
    });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "feishu", source: "test", plugin: feishuPlugin }]),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  // Three chunks at the 4000 default, so the loop has to ask twice more after the check
  // core made around the whole adapter call.
  const longText = Array.from(
    { length: 300 },
    (_entry, index) => `Line ${index} of a long outbound reply.`,
  ).join("\n");

  function errorMessage(outcome: unknown): string {
    return outcome instanceof Error ? outcome.message : String(outcome);
  }

  function partialDelivery(outcome: unknown) {
    return isChannelPartialDeliveryError(outcome) ? outcome.deliveryResult : undefined;
  }

  it("refreshes and fences custody before every formatted chunk", async () => {
    const run = handoffRecorder();
    sendMessageFeishuMock.mockImplementation(async () => run.recordSend({ messageId: "text_msg" }));
    // The case only means anything while the text needs more than one message.
    expect(longText.length).toBeGreaterThan(8000);

    await feishuOutbound.sendFormattedText?.({
      cfg: {} as ClawdbotConfig,
      to: "chat_1",
      text: longText,
      accountId: "main",
      ...run.hooks,
    } as never);

    expect(run.counts()).toEqual({ refresh: 3, fence: 3, send: 3 });
    expect(run.steps.join(" ")).toBe("refresh fence send refresh fence send refresh fence send");
    // Every send still sits in the synchronous stack of the fence that cleared it.
    expect(run.drainedAtSend).toEqual([false, false, false]);
  });

  it("stops the formatted fanout once custody is lost after an earlier chunk", async () => {
    const run = handoffRecorder();
    run.failFenceAt(2);
    sendMessageFeishuMock.mockImplementation(async () => run.recordSend({ messageId: "text_msg" }));
    const delivered: string[] = [];

    const outcome = await feishuOutbound
      .sendFormattedText?.({
        cfg: {} as ClawdbotConfig,
        to: "chat_1",
        text: longText,
        accountId: "main",
        onDeliveryResult: (result: { messageId?: string }) => {
          delivered.push(result.messageId ?? "");
        },
        ...run.hooks,
      } as never)
      .catch((error: unknown) => error);

    expect(run.counts()).toEqual({ refresh: 2, fence: 2, send: 1 });
    expect(errorMessage(outcome)).toContain(CUSTODY_LOST);
    expect(delivered).toEqual(["text_msg"]);
  });

  // Losing custody mid-fanout must not lose the receipts of the messages that already
  // reached the reader: the turn would then record the whole answer as undelivered and a
  // retry would repeat the text the reader is looking at.
  it("reports the chunk the reader received when custody is lost mid-fanout", async () => {
    const run = handoffRecorder();
    run.failFenceAt(2);
    let sendIndex = 0;
    sendMessageFeishuMock.mockImplementation(async () => {
      sendIndex += 1;
      return run.recordSend({ messageId: `text_msg_${sendIndex}` });
    });

    const outcome = await feishuOutbound
      .sendFormattedText?.({
        cfg: {} as ClawdbotConfig,
        to: "chat_1",
        text: longText,
        accountId: "main",
        ...run.hooks,
      } as never)
      .catch((error: unknown) => error);

    const sentTexts = sendMessageFeishuMock.mock.calls.map((call) => String(call[0]?.text ?? ""));
    expect(sentTexts).toHaveLength(1);
    const delivery = partialDelivery(outcome);
    // A rejection that threw the accepted receipts away reports none of them.
    expect(delivery?.messageIds ?? []).toHaveLength(1);
    expect(delivery?.visibleReplySent).toBe(true);
    expect(delivery?.messageIds).toEqual(["text_msg_1"]);
    expect(delivery?.receipt?.platformMessageIds).toEqual(["text_msg_1"]);
    // Two numbers rather than two walls of prose when this regresses.
    expect(delivery?.content?.length ?? 0).toBe(sentTexts[0]?.length);
    expect(delivery?.content).toBe(sentTexts[0]);
    // The evidence the delivery layer reads to tell a refused message apart from an answer
    // that partly reached the reader. A raw no-dispatch rejection carries none of it.
    expect(delivery?.visibleReplySent).toBe(true);
  });

  it("stops the comment thread fanout once custody is lost after an earlier reply", async () => {
    const run = handoffRecorder();
    run.failFenceAt(2);
    deliverCommentThreadTextMock.mockImplementation(async () =>
      run.recordSend({ delivery_mode: "reply_comment", reply_id: "reply_1" }),
    );

    const outcome = await feishuOutbound
      .sendFormattedText?.({
        cfg: {} as ClawdbotConfig,
        to: "comment:docx:doc_token_1:comment_1",
        text: longText,
        accountId: "main",
        ...run.hooks,
      } as never)
      .catch((error: unknown) => error);

    expect(run.counts()).toEqual({ refresh: 2, fence: 2, send: 1 });
    expect(run.drainedAtSend).toEqual([false]);
    expect(errorMessage(outcome)).toContain(CUSTODY_LOST);
  });

  // A presentation payload with attachments is several platform messages behind the single
  // handoff core made around this call: each upload, then the card that finalizes it.
  it("fences custody before every message a payload fans out", async () => {
    const run = handoffRecorder();
    run.failFenceAt(2);
    sendMediaFeishuMock.mockImplementation(async () =>
      run.recordSend({ messageId: "media_msg", chatId: "chat_1" }),
    );
    sendCardFeishuMock.mockImplementation(async () =>
      run.recordSend({ messageId: "card_msg", chatId: "chat_1" }),
    );

    const outcome = await feishuOutbound
      .sendPayload?.({
        cfg: {} as ClawdbotConfig,
        to: "chat_1",
        text: "Two charts.",
        accountId: "main",
        payload: {
          text: "Two charts.",
          mediaUrls: ["https://example.test/a.png", "https://example.test/b.png"],
          presentation: {
            blocks: [{ type: "text", text: "Two charts." }],
          },
        },
        ...run.hooks,
      } as never)
      .catch((error: unknown) => error);

    expect(run.counts()).toEqual({ refresh: 2, fence: 2, send: 1 });
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(errorMessage(outcome)).toContain(CUSTODY_LOST);
  });

  it("fences custody before the attachment, and keeps the caption receipt", async () => {
    const run = handoffRecorder();
    run.failFenceAt(2);
    sendMessageFeishuMock.mockImplementation(async () => run.recordSend({ messageId: "text_msg" }));
    sendMediaFeishuMock.mockImplementation(async () => run.recordSend({ messageId: "media_msg" }));

    const outcome = await feishuOutbound
      .sendMedia?.({
        cfg: {} as ClawdbotConfig,
        to: "chat_1",
        text: "Here is the chart.",
        mediaUrl: "https://example.test/chart.png",
        accountId: "main",
        ...run.hooks,
      } as never)
      .catch((error: unknown) => error);

    expect(run.counts()).toEqual({ refresh: 2, fence: 2, send: 1 });
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    // The refused attachment is not an upload failure, so no fallback text follows it, and
    // the caption the reader already has keeps its receipt.
    const delivery = partialDelivery(outcome);
    expect(delivery?.messageIds ?? []).toHaveLength(1);
    expect(delivery?.messageIds).toEqual(["text_msg"]);
    expect(delivery?.visibleReplySent).toBe(true);
    expect(errorMessage(outcome)).toContain(CUSTODY_LOST);
  });
});
