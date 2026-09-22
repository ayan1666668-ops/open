// Telegram tests cover message-session routing and persisted model inheritance.
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";
import { createTelegramMessageSessionRuntime } from "./bot-handlers.message-context.js";

describe("createTelegramMessageSessionRuntime", () => {
  it.each<{
    name: string;
    topic: Partial<SessionEntry>;
    channelModel?: string;
    channelModels?: Record<string, string>;
    model: string;
  }>([
    { name: "channel-mapped", topic: {}, channelModel: "openai/gpt-5.4", model: "openai/gpt-5.4" },
    {
      name: "prefixed channel-mapped",
      topic: {},
      channelModels: { "telegram:12345": "topic-model" },
      model: "anthropic/claude-sonnet-4-6",
    },
    {
      name: "prefixed mapping ahead of bare and wildcard mappings",
      topic: {},
      channelModels: {
        "telegram:12345": "topic-model",
        "12345": "openai/gpt-5.4",
        "*": "openai/gpt-5.5",
      },
      model: "anthropic/claude-sonnet-4-6",
    },
    {
      name: "channel alias with historical metadata",
      topic: { modelProvider: "anthropic", model: "claude-opus-4-7" },
      channelModel: "topic-model",
      model: "anthropic/claude-sonnet-4-6",
    },
    { name: "fresh", topic: {}, model: "openai/gpt-5.5" },
    {
      name: "previously used",
      topic: { modelProvider: "anthropic", model: "claude-opus-4-7" },
      model: "openai/gpt-5.5",
    },
    {
      name: "explicitly pinned",
      channelModel: "openai/gpt-5.4",
      topic: { providerOverride: "anthropic", modelOverride: "claude-opus-4-7" },
      model: "anthropic/claude-opus-4-7",
    },
    {
      name: "explicitly parented",
      channelModel: "openai/gpt-5.4",
      topic: { parentSessionKey: "agent:main:main" },
      model: "anthropic/claude-opus-4-7",
    },
  ])(
    "uses the effective model for a $name DM topic picker",
    ({ topic, model, channelModel, channelModels }) => {
      const storePath = "/tmp/telegram-sessions.sqlite";
      const childSessionKey = "agent:main:main:thread:12345:99";
      const parentSessionKey = "agent:main:main";
      const entries: Record<string, SessionEntry> = {
        [childSessionKey]: { sessionId: "child", updatedAt: 2, ...topic },
        [parentSessionKey]: {
          sessionId: "parent",
          updatedAt: 1,
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-7",
          modelOverrideSource: "user",
        },
      };
      const getSessionEntry = vi.fn<NonNullable<TelegramBotDeps["getSessionEntry"]>>(
        ({ sessionKey }) => entries[sessionKey],
      );
      const telegramDeps = {
        resolveStorePath: vi.fn(() => storePath),
        getSessionEntry,
      } as Pick<TelegramBotDeps, "resolveStorePath" | "getSessionEntry"> as TelegramBotDeps;
      const { resolveTelegramSessionState } = createTelegramMessageSessionRuntime({
        accountId: "default",
        resolveTelegramGroupConfig: () => ({}),
        telegramDeps,
      });

      const state = resolveTelegramSessionState({
        chatId: 12345,
        isGroup: false,
        threadSpec: { id: 99, scope: "dm" },
        botHasTopicsEnabled: true,
        senderId: 12345,
        runtimeCfg: {
          agents: {
            defaults: {
              model: "openai/gpt-5.5",
              models: { "anthropic/claude-sonnet-4-6": { alias: "topic-model" } },
            },
          },
          ...(channelModels
            ? { channels: { modelByChannel: { telegram: channelModels } } }
            : channelModel
              ? { channels: { modelByChannel: { telegram: { "12345": channelModel } } } }
              : {}),
        },
      });

      expect(state.sessionKey).toBe(childSessionKey);
      expect(state.model).toBe(model);
      expect(getSessionEntry).toHaveBeenCalledWith({ storePath, sessionKey: childSessionKey });
    },
  );
});
