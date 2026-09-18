// Telegram tests cover bot-pair loop protection on the assembled dispatch turn.
import { expect, it, vi } from "vitest";
import {
  createContext,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";

// The harness hands the assembled turn to the real core runner, so these cases exercise the
// shared pair guard itself. That guard is process-wide: every case uses its own account id.
const RECEIVER_BOT_ID = 4242;
const PEER_BOT = { id: 5151, is_bot: true, first_name: "Peer" } as const;
const cfg = {
  channels: {
    defaults: {
      botLoopProtection: { maxEventsPerWindow: 2, windowSeconds: 60, cooldownSeconds: 60 },
    },
  },
};

type Sender = NonNullable<TelegramMessageContext["msg"]["from"]>;
type Inbound = { from: Sender; messageId: number; channelPost?: boolean };

function inboundContext(accountId: string, inbound: Inbound): TelegramMessageContext {
  const chatId = inbound.from.id;
  return createContext({
    primaryCtx: {
      me: { id: RECEIVER_BOT_ID, is_bot: true, first_name: "Receiver", username: "receiver_bot" },
    } as unknown as TelegramMessageContext["primaryCtx"],
    msg: {
      chat: { id: chatId, type: inbound.channelPost ? "supergroup" : "private" },
      message_id: inbound.messageId,
      date: 1_700_000_000 + inbound.messageId,
      from: inbound.from,
    } as unknown as TelegramMessageContext["msg"],
    chatId,
    ...(inbound.channelPost ? { isGroup: true, threadSpec: { scope: "none" as const } } : {}),
    route: { accountId } as unknown as TelegramMessageContext["route"],
  });
}

async function dispatchInbound(accountId: string, messages: readonly Inbound[]) {
  const recordCalls: number[] = [];
  for (const inbound of messages) {
    const context = inboundContext(accountId, inbound);
    await expect(dispatchWithContext({ context, cfg })).resolves.toEqual({ kind: "completed" });
    recordCalls.push(vi.mocked(context.turn.recordInboundSession).mock.calls.length);
  }
  return { recordCalls, dispatchCalls: dispatchReplyWithBufferedBlockDispatcher.mock.calls.length };
}

describeTelegramDispatch("dispatchTelegramMessage bot-loop protection", () => {
  it("drops another bot's turn before record and dispatch once the pair exceeds its budget", async () => {
    const result = await dispatchInbound("loop-peer-bot", [
      { from: PEER_BOT, messageId: 1 },
      { from: PEER_BOT, messageId: 2 },
      { from: PEER_BOT, messageId: 3 },
    ]);

    expect(result).toEqual({ recordCalls: [1, 1, 0], dispatchCalls: 2 });
  });

  it("counts channel posts, whose synthetic sender is a bot", async () => {
    // normalizeChannelPostMessage stamps is_bot on the channel as sender.
    const channel = { id: -1005550001, is_bot: true, first_name: "Channel" } as const;
    const result = await dispatchInbound("loop-channel-post", [
      { from: channel, messageId: 1, channelPost: true },
      { from: channel, messageId: 2, channelPost: true },
      { from: channel, messageId: 3, channelPost: true },
    ]);

    expect(result).toEqual({ recordCalls: [1, 1, 0], dispatchCalls: 2 });
  });

  it("does not spend the budget on a replay of the same Telegram message", async () => {
    const result = await dispatchInbound("loop-replay", [
      { from: PEER_BOT, messageId: 1 },
      { from: PEER_BOT, messageId: 1 },
      { from: PEER_BOT, messageId: 1 },
      { from: PEER_BOT, messageId: 2 },
      { from: PEER_BOT, messageId: 3 },
    ]);

    expect(result).toEqual({ recordCalls: [1, 1, 1, 1, 0], dispatchCalls: 4 });
  });

  it.each([
    ["a human sender", { id: 7001, is_bot: false, first_name: "Alice" }],
    ["this bot itself", { id: RECEIVER_BOT_ID, is_bot: true, first_name: "Receiver" }],
  ] as const)("never suppresses %s", async (label, from) => {
    const result = await dispatchInbound(`loop-exempt-${label}`, [
      { from, messageId: 1 },
      { from, messageId: 2 },
      { from, messageId: 3 },
    ]);

    expect(result).toEqual({ recordCalls: [1, 1, 1], dispatchCalls: 3 });
  });
});
