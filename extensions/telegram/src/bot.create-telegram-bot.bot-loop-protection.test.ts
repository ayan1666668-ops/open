// Telegram tests cover bot-pair loop protection for channel posts through the real channel_post handler.
import { beforeEach, describe, expect, it } from "vitest";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";

const {
  dispatchReplyWithBufferedBlockDispatcher,
  getLoadConfigMock,
  getOnHandler,
  telegramBotDepsForTest,
} = await import("./bot.create-telegram-bot.test-harness.js");
const { createTelegramBotCore } = await import("./bot-core.js");

type ChannelPostHandler = (ctx: Record<string, unknown>) => Promise<void>;

// The pair guard is process-wide, so each case posts in its own channel.
const CASES = [
  ["a channel post carrying sender_chat", -1005550101, true],
  ["a channel post without sender_chat", -1005550102, false],
] as const;

function channelPost(channelId: number, withSenderChat: boolean, messageId: number) {
  const channel = { id: channelId, type: "channel", title: "Loop Channel" } as const;
  return {
    update: { update_id: 7000 + messageId },
    // A Telegram channel post has no `from` user; the handler must stamp the synthetic sender.
    channelPost: {
      chat: channel,
      ...(withSenderChat ? { sender_chat: channel } : {}),
      message_id: messageId,
      date: 1_736_380_800 + messageId,
      text: `post ${messageId}`,
    },
    me: telegramBotInfoForTest,
    getFile: async () => ({}),
  };
}

describe("createTelegramBot channel_post bot-loop protection", () => {
  beforeEach(() => {
    setTelegramPluginStateRuntimeForTests();
  });

  it.each(CASES)(
    "counts %s against the channel's pair budget",
    async (_label, channelId, withSenderChat) => {
      getLoadConfigMock().mockReturnValue({
        channels: {
          defaults: {
            botLoopProtection: { maxEventsPerWindow: 2, windowSeconds: 60, cooldownSeconds: 60 },
          },
          telegram: {
            groupPolicy: "open",
            groups: { [String(channelId)]: { enabled: true, requireMention: false } },
          },
        },
      });
      createTelegramBotCore({
        token: "tok",
        botInfo: telegramBotInfoForTest,
        telegramDeps: telegramBotDepsForTest,
      });
      const handler = getOnHandler("channel_post") as ChannelPostHandler;

      const dispatchCallsAfterEachPost: number[] = [];
      for (const messageId of [1, 2, 3]) {
        await handler(channelPost(channelId, withSenderChat, messageId));
        dispatchCallsAfterEachPost.push(dispatchReplyWithBufferedBlockDispatcher.mock.calls.length);
      }

      expect(dispatchCallsAfterEachPost).toEqual([1, 2, 2]);
    },
  );
});
