import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import {
  createTelegramBot,
  dispatchReplyWithBufferedBlockDispatcher,
  getOnHandler,
  loadConfig,
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
import type { TelegramBotOptions } from "./bot.types.js";
import type { TelegramRuntime } from "./runtime.types.js";

export function registerTelegramIgnoreAlbumRaceTests(): void {
  it("suppresses an album edited to /ignore before flush without restoring it after restart", async () => {
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
    const getFileSpy = vi.fn(async () => ({ file_path: "photos/private.jpg" }));
    const chat = {
      id: -100123456789,
      type: "supergroup",
      title: "Channel Inbox",
      is_direct_messages: true,
    } as const;
    const base = {
      chat,
      date: 2_000_000_000,
      direct_messages_topic: { topic_id: 77 },
      message_thread_id: 999,
      media_group_id: "edited-ignore-album",
      from: { id: 999, username: "human" },
      photo: [{ file_id: "private", file_unique_id: "private-unique", width: 1, height: 1 }],
    };

    vi.useFakeTimers();
    try {
      createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
      const messageHandler = getOnHandler("message") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      const editedHandler = getOnHandler("edited_message") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;

      await messageHandler({
        message: { ...base, message_id: 428, caption: "classified album context" },
        me: { id: 7, username: "openclaw_bot" },
        getFile: getFileSpy,
      });
      await messageHandler({
        message: { ...base, message_id: 429 },
        me: { id: 7, username: "openclaw_bot" },
        getFile: getFileSpy,
      });
      await editedHandler({
        editedMessage: {
          ...base,
          message_id: 428,
          edit_date: 2_000_000_010,
          caption: "/ignore",
          caption_entities: [{ type: "bot_command", offset: 0, length: 7 }],
        },
        me: { id: 7, username: "openclaw_bot" },
        getFile: getFileSpy,
      });
      await vi.advanceTimersByTimeAsync(TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs + 1);
    } finally {
      vi.useRealTimers();
    }

    expect(getFileSpy).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledWith(
      chat.id,
      expect.stringContaining("Use /ignore <message>"),
      {
        direct_messages_topic_id: 77,
        reply_parameters: { message_id: 428, allow_sending_without_reply: true },
      },
    );

    resetTelegramMessageCacheForTest();
    dispatchReplyWithBufferedBlockDispatcher.mockClear();
    replySpy.mockClear();
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
        chat,
        message_id: 430,
        date: 2_000_000_060,
        direct_messages_topic: { topic_id: 77 },
        message_thread_id: 999,
        text: "ordinary follow-up",
        from: { id: 999, username: "human" },
      },
      me: { id: 7, username: "openclaw_bot" },
      getFile: getFileSpy,
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    const context = JSON.stringify(replySpy.mock.calls.at(0)?.[0].ChannelStructuredContext ?? []);
    expect(context).not.toContain("classified album context");
  });

  it("keeps an authorized middle /ignore as the album owner through the quiet window", async () => {
    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });
    const getFileSpy = vi.fn(async () => ({ file_path: "photos/private.jpg" }));
    createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
    const messageHandler = getOnHandler("message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const base = {
      chat: { id: -100123456789, type: "group", title: "Test Group" },
      date: 2_000_000_000,
      media_group_id: "middle-ignore-tombstone",
      from: { id: 999, username: "human" },
      photo: [{ file_id: "private", file_unique_id: "private-unique", width: 1, height: 1 }],
    };

    await messageHandler({
      message: { ...base, message_id: 431, caption: "first album member" },
      me: { id: 7, username: "openclaw_bot" },
      getFile: getFileSpy,
    });
    await messageHandler({
      message: {
        ...base,
        message_id: 432,
        caption: "/ignore hidden",
        caption_entities: [{ type: "bot_command", offset: 0, length: 7 }],
      },
      me: { id: 7, username: "openclaw_bot" },
      getFile: getFileSpy,
    });
    await messageHandler({
      message: { ...base, message_id: 433, caption: "late album member" },
      me: { id: 7, username: "openclaw_bot" },
      getFile: getFileSpy,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs + 20);
    });

    expect(getFileSpy).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("gives a post-flush album member its own queued dispatch owner", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });
    const firstDispatchGate = createDeferred<{
      queuedFinal: false;
      counts: { block: number; final: number; tool: number };
    }>();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async () => await firstDispatchGate.promise,
    );
    const getFileSpy = vi.fn(async () => ({ file_path: "photos/private.jpg" }));
    const mediaFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    createTelegramBot({
      token: "tok",
      testTimings: TELEGRAM_TEST_TIMINGS,
      telegramTransport: {
        fetch: mediaFetch as typeof fetch,
        sourceFetch: mediaFetch as typeof fetch,
        close: async () => {},
      },
    });
    const messageHandler = getOnHandler("message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const base = {
      chat: { id: -100123456789, type: "group", title: "Test Group" },
      date: 2_000_000_000,
      media_group_id: "late-member-after-flush",
      from: { id: 999, username: "human" },
      photo: [{ file_id: "private", file_unique_id: "private-unique", width: 1, height: 1 }],
    };

    await messageHandler({
      message: { ...base, message_id: 434, caption: "first owner" },
      me: { id: 7, username: "openclaw_bot" },
      getFile: getFileSpy,
    });
    await waitForTelegramMockCalls(dispatchReplyWithBufferedBlockDispatcher, 1);
    await messageHandler({
      message: { ...base, message_id: 435, caption: "late owner" },
      me: { id: 7, username: "openclaw_bot" },
      getFile: getFileSpy,
    });
    firstDispatchGate.resolve({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });
    await waitForTelegramMockCalls(dispatchReplyWithBufferedBlockDispatcher, 2);

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
    expect(dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0].ctx.RawBody).toContain(
      "first owner",
    );
    expect(dispatchReplyWithBufferedBlockDispatcher.mock.calls[1]?.[0].ctx.RawBody).toContain(
      "late owner",
    );
  });

  it("removes admitted album history when a late member carries /ignore", async () => {
    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });
    const mediaFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    try {
      createTelegramBot({
        token: "tok",
        testTimings: { ...TELEGRAM_TEST_TIMINGS, mediaGroupFlushMs: 100 },
      });
      const messageHandler = getOnHandler("message") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      const chat = { id: -100123456789, type: "group", title: "Test Group" };
      const album = {
        chat,
        date: 2_000_000_000,
        media_group_id: "late-ignore-after-admission",
        from: { id: 999, username: "human" },
        photo: [{ file_id: "private", file_unique_id: "private-unique", width: 1, height: 1 }],
      };
      const getFile = async () => ({ file_path: "photos/private.jpg" });

      await messageHandler({
        message: { ...album, message_id: 436, caption: "admitted album private detail" },
        me: { id: 7, username: "openclaw_bot" },
        getFile,
      });
      await waitForTelegramMockCalls(dispatchReplyWithBufferedBlockDispatcher, 1);
      await messageHandler({
        message: {
          ...album,
          message_id: 437,
          caption: "/ignore hidden",
          caption_entities: [{ type: "bot_command", offset: 0, length: 7 }],
        },
        me: { id: 7, username: "openclaw_bot" },
        getFile,
      });
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
      dispatchReplyWithBufferedBlockDispatcher.mockClear();
      replySpy.mockClear();

      await messageHandler({
        message: {
          chat,
          message_id: 438,
          date: 2_000_000_060,
          text: "same-process follow-up",
          from: { id: 999, username: "human" },
        },
        me: { id: 7, username: "openclaw_bot" },
        getFile,
      });

      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
      const context = JSON.stringify(replySpy.mock.calls.at(0)?.[0].ChannelStructuredContext ?? []);
      expect(context).not.toContain("admitted album private detail");
    } finally {
      mediaFetch.mockRestore();
    }
  });

  it("cancels an in-flight album when a member is edited to /ignore after flush", async () => {
    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });
    let getFileSignal: AbortSignal | undefined;
    const getFileSpy = vi.fn(
      async (signal?: AbortSignal): Promise<{ file_path: string }> =>
        await new Promise((_, reject) => {
          getFileSignal = signal;
          const rejectAborted = () =>
            reject(
              signal?.reason instanceof Error
                ? signal.reason
                : new Error(String(signal?.reason ?? "aborted")),
            );
          if (signal?.aborted) {
            rejectAborted();
            return;
          }
          signal?.addEventListener("abort", rejectAborted, { once: true });
        }),
    );
    const runtimeError = vi.fn();
    const mediaFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    createTelegramBot({
      token: "tok",
      testTimings: TELEGRAM_TEST_TIMINGS,
      runtime: { error: runtimeError } as unknown as NonNullable<TelegramBotOptions["runtime"]>,
      telegramTransport: {
        fetch: mediaFetch as typeof fetch,
        sourceFetch: mediaFetch as typeof fetch,
        close: async () => {},
      },
    });
    const messageHandler = getOnHandler("message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const editedHandler = getOnHandler("edited_message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const base = {
      chat: { id: -100123456789, type: "group", title: "Test Group" },
      date: 2_000_000_000,
      media_group_id: "in-flight-edited-ignore",
      from: { id: 999, username: "human" },
      photo: [{ file_id: "private", file_unique_id: "private-unique", width: 1, height: 1 }],
    };

    await messageHandler({
      message: { ...base, message_id: 433, caption: "classified album context" },
      me: { id: 7, username: "openclaw_bot" },
      getFile: getFileSpy,
    });
    await messageHandler({
      message: { ...base, message_id: 434 },
      me: { id: 7, username: "openclaw_bot" },
      getFile: getFileSpy,
    });
    await vi.waitFor(() => expect(getFileSpy).toHaveBeenCalledOnce());

    await editedHandler({
      editedMessage: {
        ...base,
        message_id: 434,
        edit_date: 2_000_000_010,
        caption: "/ignore hidden",
        caption_entities: [{ type: "bot_command", offset: 0, length: 7 }],
      },
      me: { id: 7, username: "openclaw_bot" },
      getFile: getFileSpy,
    });
    await vi.waitFor(() => expect(getFileSignal?.aborted).toBe(true));

    expect(getFileSpy).toHaveBeenCalledOnce();
    expect(mediaFetch).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(runtimeError).not.toHaveBeenCalled();
  });

  it.each([
    { label: "authorized", senderId: 999, expectedDispatches: 0 },
    { label: "unauthorized", senderId: 888, expectedDispatches: 1 },
  ] as const)(
    "pauses an album for a delayed $label /ignore member until authorization resolves",
    async ({ senderId, expectedDispatches }) => {
      loadConfig.mockReturnValue({
        commands: { native: true },
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["777", "999"],
            groups: { "*": { requireMention: false } },
          },
        },
      });
      const authorizationGate = createDeferred<string[]>();
      const expandAllowFrom = vi.mocked(securityRuntime.expandAllowFromWithAccessGroups);
      expandAllowFrom.mockClear();
      let delayedCandidate = false;
      expandAllowFrom.mockImplementation(async (params) => {
        if (!delayedCandidate && params.senderId === String(senderId)) {
          delayedCandidate = true;
          return await authorizationGate.promise;
        }
        return await securityRuntimeActual.expandAllowFromWithAccessGroups(params);
      });
      const getFileSpy = vi.fn(async () => ({ file_path: "photos/private.jpg" }));
      const mediaFetch = vi.fn(
        async () =>
          new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          }),
      );
      createTelegramBot({
        token: "tok",
        testTimings: TELEGRAM_TEST_TIMINGS,
        telegramTransport: {
          fetch: mediaFetch as typeof fetch,
          sourceFetch: mediaFetch as typeof fetch,
          close: async () => {},
        },
      });
      const messageHandler = getOnHandler("message") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      const base = {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        date: 2_000_000_000,
        media_group_id: `delayed-ignore-${senderId}`,
        photo: [{ file_id: "private", file_unique_id: "private-unique", width: 1, height: 1 }],
      };

      await messageHandler({
        message: {
          ...base,
          message_id: 435,
          caption: "authorized album context",
          from: { id: 777, username: "album-author" },
        },
        me: { id: 7, username: "openclaw_bot" },
        getFile: getFileSpy,
      });
      const pendingIgnore = messageHandler({
        message: {
          ...base,
          message_id: 436,
          caption: "/ignore hidden",
          caption_entities: [{ type: "bot_command", offset: 0, length: 7 }],
          from: { id: senderId, username: `sender-${senderId}` },
        },
        me: { id: 7, username: "openclaw_bot" },
        getFile: getFileSpy,
      });
      await vi.waitFor(() => expect(delayedCandidate).toBe(true));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs + 20);
      });

      expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

      authorizationGate.resolve(["777", "999"]);
      await pendingIgnore;
      if (expectedDispatches > 0) {
        await waitForTelegramMockCalls(
          dispatchReplyWithBufferedBlockDispatcher,
          expectedDispatches,
        );
      } else {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs + 20);
        });
      }

      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(expectedDispatches);
    },
  );
}
