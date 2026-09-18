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
// Channel posts reach this path through the real channel_post handler in
// bot.create-telegram-bot.bot-loop-protection.test.ts.
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
type Inbound = {
  from: Sender;
  messageId: number;
  /** Receiving account and bot; defaults to the case account and RECEIVER_BOT_ID. */
  to?: { accountId: string; botId: number };
  /** Group chat and forum topic; omitted means a private chat, whose id is the peer's user id. */
  group?: { chatId: number; topicId: number };
};

function inboundContext(accountId: string, inbound: Inbound): TelegramMessageContext {
  const to = inbound.to ?? { accountId, botId: RECEIVER_BOT_ID };
  const chatId = inbound.group?.chatId ?? inbound.from.id;
  const topicId = inbound.group?.topicId;
  return createContext({
    primaryCtx: {
      me: { id: to.botId, is_bot: true, first_name: "Receiver", username: "receiver_bot" },
    } as unknown as TelegramMessageContext["primaryCtx"],
    msg: {
      chat: inbound.group
        ? { id: chatId, type: "supergroup", is_forum: true }
        : { id: chatId, type: "private" },
      message_id: inbound.messageId,
      ...(topicId !== undefined ? { message_thread_id: topicId, is_topic_message: true } : {}),
      date: 1_700_000_000 + inbound.messageId,
      from: inbound.from,
    } as unknown as TelegramMessageContext["msg"],
    chatId,
    ...(topicId !== undefined
      ? {
          isGroup: true,
          resolvedThreadId: topicId,
          replyThreadId: topicId,
          threadSpec: { id: topicId, scope: "forum" as const },
        }
      : {}),
    route: { accountId: to.accountId } as unknown as TelegramMessageContext["route"],
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

  it("bounds each side of a private bot DM in the receiving account's own budget", async () => {
    // Each bot sees the DM under the other's user id, and each account records only its own
    // inbound, so every inbound on one side lands in one bucket and that side stops at its third.
    const botA = { id: 6161, is_bot: true, first_name: "A" } as const;
    const botB = { id: 6262, is_bot: true, first_name: "B" } as const;
    const toA = { accountId: "loop-dm-a", botId: botA.id };
    const toB = { accountId: "loop-dm-b", botId: botB.id };
    const result = await dispatchInbound("loop-dm", [
      { from: botB, to: toA, messageId: 1 },
      { from: botA, to: toB, messageId: 2 },
      { from: botB, to: toA, messageId: 3 },
      { from: botA, to: toB, messageId: 4 },
      { from: botB, to: toA, messageId: 5 },
      { from: botA, to: toB, messageId: 6 },
    ]);

    expect(result).toEqual({ recordCalls: [1, 1, 1, 1, 0, 0], dispatchCalls: 4 });
  });

  it("spends one chat budget across forum topics, so topic hopping does not reset it", async () => {
    const group = { chatId: -1005550002 };
    const result = await dispatchInbound("loop-topics", [
      { from: PEER_BOT, messageId: 1, group: { ...group, topicId: 11 } },
      { from: PEER_BOT, messageId: 2, group: { ...group, topicId: 22 } },
      { from: PEER_BOT, messageId: 3, group: { ...group, topicId: 33 } },
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
