import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
  securityRuntime,
  securityRuntimeActual,
  sendMessageSpy,
  setTelegramRuntime,
  TELEGRAM_TEST_TIMINGS,
  waitForTelegramMockCalls,
} from "./bot.create-telegram-bot.ignore.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

export function registerTelegramIgnoreEditTests(): void {
  it("holds a debounced message while an edited /ignore is authorized, then cancels it", async () => {
    loadConfig.mockReturnValue({
      commands: { native: true },
      messages: { inbound: { debounceMs: 30 } },
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["999"],
          groups: { "*": { requireMention: false } },
        },
      },
    });
    const authorizationGate = createDeferred<string[]>();
    const expandAllowFrom = vi.mocked(securityRuntime.expandAllowFromWithAccessGroups);
    let delayAuthorization = false;
    let authorizationPending = false;
    expandAllowFrom.mockImplementation(async (params) => {
      if (delayAuthorization && !authorizationPending && params.senderId === "999") {
        authorizationPending = true;
        return await authorizationGate.promise;
      }
      return await securityRuntimeActual.expandAllowFromWithAccessGroups(params);
    });
    createTelegramBot({ token: "tok" });
    const messageHandler = getOnHandler("message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const editedHandler = getOnHandler("edited_message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const original = {
      chat: { id: -100123456789, type: "group", title: "Test Group" },
      message_id: 415,
      date: 2_000_000_000,
      text: "debounced private detail",
      from: { id: 999, username: "human" },
    };

    await messageHandler({
      message: original,
      me: { id: 7, username: "openclaw_bot" },
      getFile: async () => ({}),
    });
    delayAuthorization = true;
    const pendingEdit = editedHandler({
      editedMessage: {
        ...original,
        edit_date: 2_000_000_010,
        text: "/ignore hidden",
        entities: [{ type: "bot_command", offset: 0, length: 7 }],
      },
      me: { id: 7, username: "openclaw_bot" },
      getFile: async () => ({}),
    });
    await vi.waitFor(() => expect(authorizationPending).toBe(true));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 60);
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

    authorizationGate.resolve(["999"]);
    await pendingEdit;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("cancels a buffered text fragment when it is edited to /ignore", async () => {
    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    vi.useFakeTimers();
    try {
      createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
      const messageHandler = getOnHandler("message") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      const editedHandler = getOnHandler("edited_message") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      const original = {
        chat: { id: 1234, type: "private" },
        message_id: 416,
        date: 2_000_000_000,
        text: "private fragment ".repeat(260),
        from: { id: 999, username: "human" },
      };

      await messageHandler({
        message: original,
        me: { id: 7, username: "openclaw_bot" },
        getFile: async () => ({}),
      });
      await editedHandler({
        editedMessage: {
          ...original,
          edit_date: 2_000_000_010,
          text: "/ignore hidden",
          entities: [{ type: "bot_command", offset: 0, length: 7 }],
        },
        me: { id: 7, username: "openclaw_bot" },
        getFile: async () => ({}),
      });
      await vi.advanceTimersByTimeAsync(TELEGRAM_TEST_TIMINGS.textFragmentGapMs + 1);

      expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes an edited /ignore message from the live group history", async () => {
    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const editedHandler = getOnHandler("edited_message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const messageHandler = getOnHandler("message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const chat = { id: -100123456789, type: "group", title: "Test Group" };

    await messageHandler({
      message: {
        chat,
        message_id: 416,
        date: 2_000_000_000,
        text: "live private detail",
        from: { id: 999, username: "human" },
      },
      me: { id: 7, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
    await editedHandler({
      editedMessage: {
        chat,
        message_id: 416,
        date: 2_000_000_000,
        edit_date: 2_000_000_010,
        text: "/ignore hidden",
        entities: [{ type: "bot_command", offset: 0, length: 7 }],
        from: { id: 999, username: "human" },
      },
      me: { id: 7, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
    dispatchReplyWithBufferedBlockDispatcher.mockClear();
    replySpy.mockClear();

    await messageHandler({
      message: {
        chat,
        message_id: 417,
        date: 2_000_000_060,
        text: "same-process follow-up",
        from: { id: 999, username: "human" },
      },
      me: { id: 7, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    const context = JSON.stringify(replySpy.mock.calls.at(0)?.[0].ChannelStructuredContext ?? []);
    expect(context).not.toContain("live private detail");
  });

  it("removes a flushed multi-caption album when a non-primary member is edited to /ignore", async () => {
    const openKeyedStore: TelegramRuntime["state"]["openKeyedStore"] = <T>(
      options: Parameters<TelegramRuntime["state"]["openKeyedStore"]>[0],
    ) => pluginStateTestRuntime.createPluginStateKeyedStoreForTests<T>("telegram", options);
    setTelegramRuntime({ state: { openKeyedStore }, channel: {} } as TelegramRuntime);
    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    try {
      createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
      const editedHandler = getOnHandler("edited_message") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      const messageHandler = getOnHandler("message") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      const chat = { id: -100123456789, type: "group", title: "Test Group" };
      const album = {
        chat,
        date: 2_000_000_000,
        media_group_id: "flushed-multi-caption-ignore",
        from: { id: 999, username: "human" },
        photo: [{ file_id: "p1", file_unique_id: "u1", width: 1, height: 1 }],
      };
      const getFile = async () => ({ file_path: "photos/p1.jpg" });
      const primaryMessage = {
        ...album,
        message_id: 418,
        caption: "primary private detail",
      };

      await messageHandler({
        message: primaryMessage,
        me: { id: 7, username: "openclaw_bot" },
        getFile,
      });
      await messageHandler({
        message: { ...album, message_id: 419, caption: "secondary private detail" },
        me: { id: 7, username: "openclaw_bot" },
        getFile: async () => {
          throw new Error("secondary media unavailable");
        },
      });
      await waitForTelegramMockCalls(dispatchReplyWithBufferedBlockDispatcher, 1);
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
      const albumBody = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0].Body;
      expect(albumBody).toContain("primary private detail");
      expect(albumBody).toContain("secondary private detail");
      const ordinaryReply = {
        chat,
        message_id: 420,
        date: 2_000_000_005,
        text: "ordinary album reply",
        from: { id: 999, username: "human" },
      };
      await messageHandler({
        message: { ...ordinaryReply, reply_to_message: primaryMessage },
        me: { id: 7, username: "openclaw_bot" },
        getFile,
      });

      await editedHandler({
        editedMessage: {
          ...album,
          message_id: 419,
          edit_date: 2_000_000_010,
          caption: "/ignore hidden",
          caption_entities: [{ type: "bot_command", offset: 0, length: 7 }],
        },
        me: { id: 7, username: "openclaw_bot" },
        getFile,
      });
      dispatchReplyWithBufferedBlockDispatcher.mockClear();
      replySpy.mockClear();

      await messageHandler({
        message: {
          chat,
          message_id: 421,
          date: 2_000_000_060,
          text: "same-process follow-up",
          from: { id: 999, username: "human" },
        },
        me: { id: 7, username: "openclaw_bot" },
        getFile,
      });

      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
      const context = JSON.stringify(replySpy.mock.calls.at(0)?.[0].ChannelStructuredContext ?? []);
      expect(context).not.toContain("primary private detail");
      expect(context).not.toContain("secondary private detail");

      resetTelegramMessageCacheForTest();
      const priorHandlerCount = onSpy.mock.calls.length;
      createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
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
          chat,
          message_id: 422,
          date: 2_000_000_120,
          text: "post-restart follow-up",
          from: { id: 999, username: "human" },
          reply_to_message: ordinaryReply,
        },
        me: { id: 7, username: "openclaw_bot" },
        getFile,
      });

      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
      const restartedContext = JSON.stringify(
        replySpy.mock.calls.at(0)?.[0].ChannelStructuredContext ?? [],
      );
      expect(restartedContext).toContain("ordinary album reply");
      expect(restartedContext).not.toContain("primary private detail");
      expect(restartedContext).not.toContain("secondary private detail");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("removes an edited /ignore message from persisted reply descendants", async () => {
    const openKeyedStore: TelegramRuntime["state"]["openKeyedStore"] = <T>(
      options: Parameters<TelegramRuntime["state"]["openKeyedStore"]>[0],
    ) => pluginStateTestRuntime.createPluginStateKeyedStoreForTests<T>("telegram", options);
    setTelegramRuntime({ state: { openKeyedStore }, channel: {} } as TelegramRuntime);
    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const editedHandler = getOnHandler("edited_message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const messageHandler = getOnHandler("message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    const privateDetail = {
      chat: { id: -100123456789, type: "group", title: "Test Group" },
      message_id: 418,
      date: 2_000_000_000,
      text: "original private detail",
      from: { id: 999, username: "human" },
    };
    await messageHandler({
      message: privateDetail,
      me: { id: 7, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
    const ordinaryReply = {
      chat: { id: -100123456789, type: "group", title: "Test Group" },
      message_id: 419,
      date: 2_000_000_005,
      text: "ordinary reply",
      from: { id: 999, username: "human" },
    };
    await messageHandler({
      message: {
        ...ordinaryReply,
        reply_to_message: privateDetail,
      },
      me: { id: 7, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
    dispatchReplyWithBufferedBlockDispatcher.mockClear();
    replySpy.mockClear();

    await editedHandler({
      editedMessage: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        message_id: 418,
        date: 2_000_000_000,
        edit_date: 2_000_000_010,
        text: "/ignore",
        entities: [{ type: "bot_command", offset: 0, length: 7 }],
        from: { id: 999, username: "human" },
      },
      me: { id: 7, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
    expect(sendMessageSpy).toHaveBeenCalledWith(
      -100123456789,
      expect.stringContaining("Use /ignore <message>"),
      expect.objectContaining({
        reply_parameters: { message_id: 418, allow_sending_without_reply: true },
      }),
    );

    resetTelegramMessageCacheForTest();
    const priorHandlerCount = onSpy.mock.calls.length;
    createTelegramBot({ token: "tok" });
    const restartedHandler = requireValue(
      onSpy.mock.calls.slice(priorHandlerCount).find((call) => call[0] === "message")?.[1] as
        | ((ctx: Record<string, unknown>) => Promise<void>)
        | undefined,
      "restarted Telegram message handler",
    );
    await restartedHandler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        message_id: 420,
        date: 2_000_000_060,
        text: "ordinary follow-up",
        from: { id: 999, username: "human" },
        reply_to_message: ordinaryReply,
      },
      me: { id: 7, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    const context = JSON.stringify(replySpy.mock.calls.at(0)?.[0].ChannelStructuredContext ?? []);
    expect(context).toContain("ordinary reply");
    expect(context).not.toContain("original private detail");
  });
}
