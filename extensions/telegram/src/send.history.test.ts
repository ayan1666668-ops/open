import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasProviderObservedTelegramThreadBinding } from "./message-cache-codec.js";
import {
  resolveTelegramMessageCacheScope,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
} from "./message-cache-persistence.js";
import { buildTelegramConversationContext, createTelegramMessageCache } from "./message-cache.js";
import { createTelegramPromptContextProjectionCursor } from "./prompt-context-projection.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import { getTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest as clearTelegramRuntime,
  resetTelegramMessageCacheForTest as resetTelegramMessageCacheBucketsForTest,
  resetTelegramSentMessageCacheForTest,
} from "./runtime.test-support.js";
import {
  getTelegramSendTestMocks,
  importTelegramSendModule,
  installTelegramSendTestHooks,
  makeTelegramApiTestMock,
} from "./send.test-harness.js";

installTelegramSendTestHooks();

const { botApi } = getTelegramSendTestMocks();
const { editMessageTelegram, sendLocationTelegram, sendMessageTelegram } =
  await importTelegramSendModule();
const TELEGRAM_TEST_CFG = {};

beforeEach(() => {
  resetPluginStateStoreForTests({ closeDatabase: false });
  resetTelegramMessageCacheBucketsForTest();
  resetTelegramSentMessageCacheForTest();
  setTelegramPluginStateRuntimeForTests();
});

afterEach(async () => {
  resetTelegramSentMessageCacheForTest();
  clearTelegramRuntime();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  resetTelegramMessageCacheBucketsForTest();
  vi.restoreAllMocks();
});

describe("Telegram sent message history", () => {
  it("records sent text messages into the Telegram prompt context cache", async () => {
    const storePath = `/tmp/openclaw-telegram-send-context-${process.pid}-${Date.now()}.json`;
    const cfg = { session: { store: storePath } };
    botApi.sendMessage.mockResolvedValueOnce({
      message_id: 1497,
      date: 1_779_394_740,
      chat: {
        id: "-1003966283270",
        type: "supergroup",
        title: "Keshav and Kelaw - Keshav's Bot",
      },
      from: { id: 42, is_bot: true, first_name: "Kelaw", username: "keshavbotagent" },
      text: "Done already: timeoutSeconds is now 7200s.",
      message_thread_id: 1154,
    });

    await sendMessageTelegram("-1003966283270", "Done already: timeoutSeconds is now 7200s.", {
      cfg,
      token: "tok",
      messageThreadId: 1154,
    });

    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    await cache.record({
      accountId: "default",
      chatId: "-1003966283270",
      threadId: 1154,
      msg: {
        chat: {
          id: -1003966283270,
          type: "supergroup",
          title: "Keshav and Kelaw - Keshav's Bot",
        },
        message_thread_id: 1154,
        message_id: 1521,
        date: 1_779_425_460,
        text: "Did all Amazon crons run fine",
        from: { id: 5185575566, is_bot: false, first_name: "Keshav" },
      },
    });

    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: "-1003966283270",
      threadId: 1154,
      messageId: "1521",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 2,
    });

    expect(context.map((entry) => entry.node.messageId)).toContain("1497");
    expect(context.map((entry) => entry.node.body)).toContain(
      "Done already: timeoutSeconds is now 7200s.",
    );
    expect(
      await cache.readHistory({
        accountId: "default",
        chatId: "-1003966283270",
        threadId: 1154,
        limit: 10,
      }),
    ).toMatchObject({
      messages: [{ messageId: "1497", body: "Done already: timeoutSeconds is now 7200s." }],
      hasMore: false,
    });
  });

  it.each([
    { name: "group text", kind: "text", chatId: "-100123", chatType: "supergroup" },
    { name: "group location", kind: "location", chatId: "-100123", chatType: "supergroup" },
    { name: "direct text", kind: "text", chatId: "123", chatType: "private" },
  ] as const)(
    "preserves provider acceptance when $name history storage fails",
    async (testCase) => {
      const failure = new Error("history storage unavailable");
      const runtime = getTelegramRuntime();
      const openKeyedStore = runtime.state.openKeyedStore;
      vi.spyOn(runtime.state, "openKeyedStore").mockImplementation((options) => {
        if (options.namespace === TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE) {
          throw failure;
        }
        return openKeyedStore(options);
      });
      const location = { latitude: 48.858844, longitude: 2.294351 };
      const providerSend = testCase.kind === "text" ? botApi.sendMessage : vi.fn();
      providerSend.mockResolvedValue({
        message_id: 1499,
        date: 1_779_394_746,
        chat: { id: testCase.chatId, type: testCase.chatType },
        from: { id: 42, is_bot: true, first_name: "OpenClaw" },
        ...(testCase.kind === "location" ? { location } : { text: "Delivered answer" }),
      });
      const cursor = createTelegramPromptContextProjectionCursor({
        transcriptMessageId: "assistant-history-failure",
      });
      const opts = {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api:
          testCase.kind === "location"
            ? makeTelegramApiTestMock({ sendLocation: providerSend })
            : undefined,
        promptContextProjectionPlan: { cursor, finalPart: true },
      };
      const delivery =
        testCase.kind === "location"
          ? sendLocationTelegram(testCase.chatId, location, opts)
          : sendMessageTelegram(testCase.chatId, "Delivered answer", opts);
      if (testCase.chatType === "private") {
        await expect(delivery).resolves.toMatchObject({ messageId: "1499", chatId: "123" });
      } else {
        let observed: unknown;
        try {
          await delivery;
        } catch (error) {
          observed = error;
        }
        expect(isChannelPartialDeliveryError(observed)).toBe(true);
        if (!(observed instanceof Error) || !isChannelPartialDeliveryError(observed)) {
          throw observed;
        }
        expect(observed.message).toContain(failure.message);
        expect(observed.deliveryResult).toMatchObject({
          messageIds: ["1499"],
          visibleReplySent: true,
        });
        expect(cursor.take(true).finalPart).toBe(false);
      }
      expect(providerSend).toHaveBeenCalledTimes(1);
    },
  );

  it("records a successful General-topic send when the response omits the thread id", async () => {
    const storePath = `/tmp/openclaw-telegram-general-context-${process.pid}-${Date.now()}.json`;
    const chatId = "-1003966283270";
    botApi.sendMessage.mockResolvedValueOnce({
      message_id: 1498,
      date: 1_779_394_741,
      chat: { id: chatId, type: "supergroup", title: "QA forum" },
      from: { id: 42, is_bot: true, first_name: "OpenClaw" },
      text: "Reply in General",
    });

    await sendMessageTelegram(`${chatId}:topic:1`, "Reply in General", {
      cfg: { session: { store: storePath } },
      token: "tok",
    });

    expect(botApi.sendMessage.mock.calls[0]?.[2]).not.toHaveProperty("message_thread_id");
    const cached = await createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    }).get({
      accountId: "default",
      chatId,
      messageId: "1498",
    });
    expect(hasProviderObservedTelegramThreadBinding(cached, 1)).toBe(true);
  });

  it("records transcript projection metadata without replacing Telegram time", async () => {
    const storePath = `/tmp/openclaw-telegram-send-context-override-${process.pid}-${Date.now()}.json`;
    const cfg = { session: { store: storePath } };
    const cursor = createTelegramPromptContextProjectionCursor({
      transcriptMessageId: "assistant-final",
    });
    botApi.sendMessage.mockResolvedValueOnce({
      message_id: 1497,
      date: 1_779_394_745,
      chat: { id: "123", type: "private" },
      from: { id: 42, is_bot: true, first_name: "Kelaw" },
      text: "Final answer",
    });

    await sendMessageTelegram("123", "Final answer", {
      cfg,
      token: "tok",
      promptContextProjectionPlan: { cursor, finalPart: true },
    });

    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    const node = await cache.get({
      accountId: "default",
      chatId: "123",
      messageId: "1497",
    });

    expect(node?.timestamp).toBe(1_779_394_745_000);
    expect(node?.promptContextProjectionMarker).toEqual({
      kind: "valid",
      projection: { ...cursor.source, partIndex: 0, finalPart: true },
    });
    expect(cursor.nextPartIndex).toBe(1);
  });
});

describe("Telegram location history", () => {
  it("records transcript projection metadata for native locations", async () => {
    const storePath = `/tmp/openclaw-telegram-location-context-${process.pid}-${Date.now()}.json`;
    const cfg = { session: { store: storePath } };
    const cursor = createTelegramPromptContextProjectionCursor({
      transcriptMessageId: "assistant-location",
    });
    const sendLocation = vi.fn().mockResolvedValue({
      message_id: 1498,
      date: 1_779_394_746,
      chat: { id: "123", type: "private" },
      from: { id: 42, is_bot: true, first_name: "Kelaw" },
      location: { latitude: 48.858844, longitude: 2.294351 },
    });

    await sendLocationTelegram(
      "123",
      { latitude: 48.858844, longitude: 2.294351 },
      {
        cfg,
        token: "tok",
        api: makeTelegramApiTestMock({ sendLocation }),
        promptContextProjectionPlan: { cursor, finalPart: true },
      },
    );

    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    const node = await cache.get({
      accountId: "default",
      chatId: "123",
      messageId: "1498",
    });

    expect(node?.timestamp).toBe(1_779_394_746_000);
    expect(node?.promptContextProjectionMarker).toEqual({
      kind: "valid",
      projection: { ...cursor.source, partIndex: 0, finalPart: true },
    });
    expect(cursor.nextPartIndex).toBe(1);
  });
});

describe("Telegram edited message history", () => {
  it.each([
    { name: "text", editMode: "text" as const, field: "text" as const },
    { name: "caption", editMode: "caption" as const, field: "caption" as const },
  ])("refreshes cached $name from Telegram's authoritative edit response", async (testCase) => {
    const storePath = `/tmp/openclaw-telegram-edited-context-${process.pid}-${Date.now()}-${testCase.name}.json`;
    const cfg = { session: { store: storePath } };
    const chat = {
      id: -100123,
      type: "supergroup" as const,
      title: "Ops",
      is_forum: true as const,
    };
    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    await cache.record({
      accountId: "default",
      chatId: chat.id,
      threadId: 77,
      msg: {
        chat,
        message_id: 902,
        message_thread_id: 77,
        date: 1_779_394_740,
        from: { id: 42, is_bot: true, first_name: "OpenClaw" },
        [testCase.field]: "outdated content",
      },
    });
    const editedMessage = {
      chat,
      message_id: 902,
      message_thread_id: 77,
      date: 1_779_394_740,
      edit_date: 1_779_394_750,
      from: { id: 42, is_bot: true, first_name: "OpenClaw" },
      [testCase.field]: "authoritative edited content",
    };
    if (testCase.editMode === "caption") {
      botApi.editMessageCaption.mockResolvedValue(editedMessage);
    } else {
      botApi.editMessageText.mockResolvedValue(editedMessage);
    }

    await editMessageTelegram(chat.id, 902, "authoritative edited content", {
      token: "42:test-token",
      cfg,
      editMode: testCase.editMode,
    });

    const cached = await cache.get({
      accountId: "default",
      chatId: chat.id,
      messageId: "902",
    });
    expect(cached?.body).toBe("authoritative edited content");
    expect(hasProviderObservedTelegramThreadBinding(cached, 77)).toBe(true);
  });

  it("refreshes edited group messages without duplicating self history or hiding later replies", async () => {
    const storePath = `/tmp/openclaw-telegram-edit-history-${process.pid}-${Date.now()}.json`;
    const cfg = { session: { store: storePath } };
    const chat = { id: -100123, type: "supergroup" as const, title: "Ops" };
    botApi.sendMessage.mockResolvedValueOnce({
      chat,
      message_id: 902,
      message_thread_id: 77,
      date: 1_779_394_740,
      from: { id: 42, is_bot: true, first_name: "OpenClaw" },
      text: "original response",
    });
    await sendMessageTelegram(String(chat.id), "original response", {
      token: "42:test-token",
      cfg,
      messageThreadId: 77,
    });
    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    await cache.record({
      accountId: "default",
      chatId: chat.id,
      threadId: 77,
      historyEligible: true,
      msg: {
        chat,
        message_id: 903,
        message_thread_id: 77,
        date: 1_779_394_741,
        from: { id: 43, is_bot: false, first_name: "Teammate" },
        text: "context that must remain visible",
      },
    });
    botApi.editMessageText.mockResolvedValue({
      chat,
      message_id: 902,
      message_thread_id: 77,
      date: 1_779_394_740,
      from: { id: 42, is_bot: true, first_name: "OpenClaw" },
      text: "authoritative edited response",
    });

    await editMessageTelegram(chat.id, 902, "authoritative edited response", {
      token: "42:test-token",
      cfg,
    });

    resetTelegramMessageCacheBucketsForTest();
    const reopened = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    const history = await reopened.readHistory({
      accountId: "default",
      chatId: chat.id,
      threadId: 77,
      limit: 50,
    });
    expect(history.messages).toMatchObject([
      {
        messageId: "902",
        sender: "OpenClaw (you)",
        body: "authoritative edited response",
        timestamp: 1_779_394_740_000,
      },
      {
        messageId: "903",
        sender: "Teammate",
        body: "context that must remain visible",
        timestamp: 1_779_394_741_000,
      },
    ]);
    expect(history.hasMore).toBe(false);
  });
});
