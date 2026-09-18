import * as pluginStateTestRuntime from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { vi } from "vitest";
import {
  telegramBotInfoForTest,
  waitForTelegramMockCalls,
} from "./bot.create-telegram-bot.test-support.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { setTelegramRuntime } from "./runtime.js";
import { resetTelegramMessageCacheForTest } from "./runtime.test-support.js";

const harness = await import("./bot.create-telegram-bot.test-harness.js");
const securityRuntime = await import("openclaw/plugin-sdk/security-runtime");
const securityRuntimeActual = await vi.importActual<
  typeof import("openclaw/plugin-sdk/security-runtime")
>("openclaw/plugin-sdk/security-runtime");
const { createTelegramBotCore } = await import("./bot-core.js");

const {
  answerCallbackQuerySpy,
  dispatchReplyWithBufferedBlockDispatcher,
  getLoadConfigMock,
  getOnHandler,
  onSpy,
  replySpy,
  sendChatActionSpy,
  sendMessageSpy,
  telegramBotDepsForTest,
} = harness;

const loadConfig = getLoadConfigMock();
const TELEGRAM_TEST_TIMINGS = {
  mediaGroupFlushMs: 20,
  textFragmentGapMs: 30,
} as const;

function createTelegramBot(opts: TelegramBotOptions) {
  return createTelegramBotCore({
    botInfo: telegramBotInfoForTest,
    ...opts,
    telegramDeps: telegramBotDepsForTest,
  });
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value == null) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

export {
  answerCallbackQuerySpy,
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
  sendChatActionSpy,
  sendMessageSpy,
  setTelegramRuntime,
  TELEGRAM_TEST_TIMINGS,
  waitForTelegramMockCalls,
};
