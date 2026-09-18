import { expect, it, vi } from "vitest";
import {
  createTelegramBot,
  dispatchReplyWithBufferedBlockDispatcher,
  getOnHandler,
  loadConfig,
  onSpy,
  pluginStateTestRuntime,
  replySpy,
  requireValue,
  resetTelegramMessageCacheForTest,
  sendMessageSpy,
  setTelegramRuntime,
  TELEGRAM_TEST_TIMINGS,
  waitForTelegramMockCalls,
} from "./bot.create-telegram-bot.ignore.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

export function registerTelegramIgnoreCommandAndAlbumTests(): void {
  it("drops /ignore before dispatch and replies with help for the bare command", async () => {
    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    const base = {
      chat: {
        id: -100123456789,
        type: "supergroup",
        title: "Channel Inbox",
        is_direct_messages: true,
      },
      date: 1736380800,
      direct_messages_topic: { topic_id: 77 },
      message_thread_id: 999,
      from: { id: 999, username: "human" },
    };

    for (const [message_id, text] of [
      [420, "/ignore side chatter"],
      [421, "/ignore"],
    ] as const) {
      await handler({
        message: {
          ...base,
          message_id,
          text,
          entities: [{ type: "bot_command", offset: 0, length: 7 }],
        },
        me: { id: 7, username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });
    }

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendChatActionSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(String(sendMessageSpy.mock.calls[0]?.[1])).toContain(
      "Replying to it may include it again",
    );
    expect(sendMessageSpy.mock.calls[0]?.[2]).toEqual({
      direct_messages_topic_id: 77,
      reply_parameters: { message_id: 421, allow_sending_without_reply: true },
    });
  });

  it("treats /ignore as ordinary text when native commands are disabled", async () => {
    loadConfig.mockReturnValue({
      commands: { native: false },
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 1234, type: "private" },
        message_id: 422,
        date: 1736380800,
        from: { id: 999, username: "human" },
        text: "/ignore ordinary text",
        entities: [{ type: "bot_command", offset: 0, length: 7 }],
      },
      me: { id: 7, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("preserves an account-scoped custom /ignore command when native commands are enabled", async () => {
    const openKeyedStore: TelegramRuntime["state"]["openKeyedStore"] = <T>(
      options: Parameters<TelegramRuntime["state"]["openKeyedStore"]>[0],
    ) => pluginStateTestRuntime.createPluginStateKeyedStoreForTests<T>("telegram", options);
    setTelegramRuntime({ state: { openKeyedStore }, channel: {} } as TelegramRuntime);
    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: {
            custom: {
              customCommands: [{ command: "ignore", description: "Custom ignore workflow" }],
            },
          },
        },
      },
    });
    createTelegramBot({ token: "tok", accountId: "custom" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    const customIgnore = {
      chat: { id: 1234, type: "private" },
      message_id: 427,
      date: 1736380800,
      from: { id: 999, username: "human" },
      text: "/ignore custom workflow input",
      entities: [{ type: "bot_command" as const, offset: 0, length: 7 }],
    };
    await handler({
      message: customIgnore,
      me: { id: 7, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).not.toHaveBeenCalled();

    const ordinaryReply = {
      chat: customIgnore.chat,
      message_id: 428,
      date: 1736380805,
      from: { id: 999, username: "human" },
      text: "ordinary reply",
      reply_to_message: customIgnore,
    };
    await handler({
      message: ordinaryReply,
      me: { id: 7, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    resetTelegramMessageCacheForTest();
    const priorHandlerCount = onSpy.mock.calls.length;
    createTelegramBot({ token: "tok", accountId: "custom" });
    const restartedHandler = requireValue(
      onSpy.mock.calls.slice(priorHandlerCount).find((call) => call[0] === "message")?.[1] as
        | ((ctx: Record<string, unknown>) => Promise<void>)
        | undefined,
      "restarted Telegram message handler",
    );
    dispatchReplyWithBufferedBlockDispatcher.mockClear();
    replySpy.mockClear();
    await restartedHandler({
      message: {
        chat: customIgnore.chat,
        message_id: 429,
        date: 1736380810,
        from: { id: 999, username: "human" },
        text: "post-restart reply",
        reply_to_message: {
          ...ordinaryReply,
          reply_to_message: undefined,
        },
      },
      me: { id: 7, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    const context = JSON.stringify(replySpy.mock.calls.at(0)?.[0].ChannelStructuredContext ?? []);
    expect(context).toContain("/ignore custom workflow input");
  });

  it("treats /ignore in an album as ordinary text when native commands are disabled", async () => {
    loadConfig.mockReturnValue({
      commands: { native: false },
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    const getFileSpy = vi.fn(async () => ({ file_path: "photos/p1.jpg" }));

    createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    const base = {
      chat: { id: 1234, type: "private" },
      date: 1736380800,
      from: { id: 999, username: "human" },
      media_group_id: "album-ignore-native-disabled",
    };

    for (const message of [
      {
        ...base,
        message_id: 425,
        caption: "/ignore trip photos",
        caption_entities: [{ type: "bot_command", offset: 0, length: 7 }],
        photo: [{ file_id: "p1", file_unique_id: "u1", width: 1, height: 1 }],
      },
      {
        ...base,
        message_id: 426,
        photo: [{ file_id: "p2", file_unique_id: "u2", width: 1, height: 1 }],
      },
    ]) {
      await handler({
        message,
        me: { id: 7, username: "openclaw_bot" },
        getFile: getFileSpy,
      });
    }
    await waitForTelegramMockCalls(dispatchReplyWithBufferedBlockDispatcher, 1);

    expect(getFileSpy).toHaveBeenCalledTimes(2);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("routes bare /ignore album help to its channel direct messages topic", async () => {
    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });
    const getFileSpy = vi.fn(async () => ({ file_path: "photos/p1.jpg" }));
    createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    const base = {
      chat: {
        id: -100123456789,
        type: "supergroup",
        title: "Channel Inbox",
        is_direct_messages: true,
      },
      date: 1736380800,
      direct_messages_topic: { topic_id: 77 },
      message_thread_id: 999,
      media_group_id: "direct-topic-ignore-help",
      from: { id: 999, username: "human" },
      photo: [{ file_id: "p1", file_unique_id: "u1", width: 1, height: 1 }],
    };

    await handler({
      message: {
        ...base,
        message_id: 431,
        caption: "/ignore",
        caption_entities: [{ type: "bot_command", offset: 0, length: 7 }],
      },
      me: { id: 7, username: "openclaw_bot" },
      getFile: getFileSpy,
    });
    await handler({
      message: { ...base, message_id: 432 },
      me: { id: 7, username: "openclaw_bot" },
      getFile: getFileSpy,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs + 20);
    });

    expect(getFileSpy).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledWith(
      base.chat.id,
      expect.stringContaining("Use /ignore <message>"),
      {
        direct_messages_topic_id: 77,
        reply_parameters: { message_id: 431, allow_sending_without_reply: true },
      },
    );
  });

  it.each(["first", "last"] as const)(
    "suppresses an album when /ignore arrives %s",
    async (position) => {
      loadConfig.mockReturnValue({
        commands: { native: true },
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      });
      const getFileSpy = vi.fn(async () => ({ file_path: "photos/p1.jpg" }));
      createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      const base = {
        chat: { id: 1234, type: "private" },
        date: 1736380800,
        from: { id: 999, username: "human" },
        media_group_id: `album-ignore-${position}`,
        photo: [{ file_id: "p1", file_unique_id: "u1", width: 1, height: 1 }],
      };
      const ignored = {
        ...base,
        message_id: position === "first" ? 423 : 424,
        caption: "/ignore trip photos",
        caption_entities: [{ type: "bot_command", offset: 0, length: 7 }],
      };
      const ordinary = { ...base, message_id: position === "first" ? 424 : 423 };

      for (const message of position === "first" ? [ignored, ordinary] : [ordinary, ignored]) {
        await handler({
          message,
          me: { id: 7, username: "openclaw_bot" },
          getFile: getFileSpy,
        });
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs + 20);
      });

      expect(getFileSpy).not.toHaveBeenCalled();
      expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    },
  );

  it("keeps an authorized /ignore album tombstoned for late quiet-window siblings", async () => {
    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    const getFileSpy = vi.fn(async () => ({ file_path: "photos/p1.jpg" }));
    const base = {
      chat: { id: 1234, type: "private" },
      date: 1_736_380_800,
      from: { id: 999, username: "human" },
      media_group_id: "album-ignore-late-quiet-window",
      photo: [{ file_id: "p1", file_unique_id: "u1", width: 1, height: 1 }],
    };

    vi.useFakeTimers();
    try {
      createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      await handler({
        message: {
          ...base,
          message_id: 425,
          caption: "/ignore hidden",
          caption_entities: [{ type: "bot_command", offset: 0, length: 7 }],
        },
        me: { id: 7, username: "openclaw_bot" },
        getFile: getFileSpy,
      });
      await handler({
        message: { ...base, message_id: 426 },
        me: { id: 7, username: "openclaw_bot" },
        getFile: getFileSpy,
      });
      await vi.advanceTimersByTimeAsync(TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs - 1);

      await handler({
        message: { ...base, message_id: 427, caption: "late sibling" },
        me: { id: 7, username: "openclaw_bot" },
        getFile: getFileSpy,
      });
      // Cross the original tombstone's deadline; the suppressed sibling must have extended it.
      await vi.advanceTimersByTimeAsync(2);
      await handler({
        message: { ...base, message_id: 428, caption: "later sibling" },
        me: { id: 7, username: "openclaw_bot" },
        getFile: getFileSpy,
      });
      await vi.advanceTimersByTimeAsync(TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs + 1);
    } finally {
      vi.useRealTimers();
    }

    expect(getFileSpy).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("suppresses an addressed /ignore album when grammY context has no bot identity", async () => {
    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    const getFileSpy = vi.fn(async () => ({ file_path: "photos/p1.jpg" }));
    createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    const base = {
      chat: { id: 1234, type: "private" },
      date: 1736380800,
      from: { id: 999, username: "human" },
      media_group_id: "album-ignore-addressed-no-me",
      photo: [{ file_id: "p1", file_unique_id: "u1", width: 1, height: 1 }],
    };

    await handler({
      message: {
        ...base,
        message_id: 425,
        caption: "/ignore@openclaw_bot trip photos",
        caption_entities: [{ type: "bot_command", offset: 0, length: 20 }],
      },
      getFile: getFileSpy,
    });
    await handler({ message: { ...base, message_id: 426 }, getFile: getFileSpy });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs + 20);
    });

    expect(getFileSpy).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });
}
