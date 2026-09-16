import { describe, expect, it, vi } from "vitest";
import {
  createBot,
  commandMessage,
  harness,
  chat,
  from,
  photo,
  apiCalls,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";

const { loginExecutor } = vi.hoisted(() => ({ loginExecutor: vi.fn(async () => false) }));
vi.mock("./bot-native-command-login.js", () => ({ executeTelegramLoginCommand: loginExecutor }));
vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>()),
  loadPreparedModelCatalog: vi.fn(async () => []),
}));

describe("createTelegramBot typed command pipeline", () => {
  it("keeps the replied-to photo and quote on a native command turn", async () => {
    const bot = createBot();
    await bot.handleUpdate({
      update_id: 1001,
      message: {
        ...commandMessage("/btw check this pls"),
        reply_to_message: {
          message_id: 100,
          date: 1736380790,
          chat,
          from,
          photo,
          caption: "Photo to check",
          reply_to_message: undefined,
        },
        quote: { text: "Photo to check", position: 0 },
      },
    });
    expect(harness.replySpy).toHaveBeenCalledTimes(1);
    expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
      CommandSource: "native",
      CommandTurn: { kind: "native", body: "/btw check this pls" },
      ReplyToBody: expect.stringContaining("Photo to check"),
      media: expect.arrayContaining([expect.objectContaining({ path: "/tmp/replied-photo.jpg" })]),
    });
  });

  it("keeps caption commands in the message pipeline", async () => {
    const bot = createBot();
    const { text, entities, ...message } = commandMessage("/status");
    await bot.handleUpdate({
      update_id: 1002,
      message: { ...message, caption: text, caption_entities: entities, photo },
    });
    expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
      CommandSource: "text",
      CommandBody: "/status",
      media: expect.arrayContaining([expect.objectContaining({ path: "/tmp/replied-photo.jpg" })]),
    });
  });

  it("renders the argument menu without dispatching a turn", async () => {
    const bot = createBot();
    await bot.handleUpdate({ update_id: 1003, message: commandMessage("/think") });
    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(apiCalls).toHaveBeenCalledWith(
      "sendMessage",
      expect.objectContaining({
        reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
      }),
    );
  });

  it("dispatches completed thinking arguments through the message pipeline", async () => {
    const bot = createBot();
    await bot.handleUpdate({ update_id: 1005, message: commandMessage("/think high") });
    expect(harness.replySpy).toHaveBeenCalledTimes(1);
    expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
      CommandSource: "native",
      CommandTurn: { kind: "native", body: "/think high" },
    });
    expect(apiCalls.mock.calls).not.toEqual(
      expect.arrayContaining([
        ["sendMessage", expect.objectContaining({ reply_markup: expect.anything() })],
      ]),
    );
  });

  it("runs the login executor without dispatching a turn", async () => {
    const bot = createBot();
    await bot.handleUpdate({ update_id: 1004, message: commandMessage("/login") });
    expect(loginExecutor).toHaveBeenCalledWith(expect.objectContaining({ commandText: "/login" }));
    expect(harness.replySpy).not.toHaveBeenCalled();
  });
});
