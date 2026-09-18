import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { feishuPlugin } from "./channel.js";

const addReactionFeishuMock = vi.hoisted(() => vi.fn());
const listReactionsFeishuMock = vi.hoisted(() => vi.fn());
const removeReactionFeishuMock = vi.hoisted(() => vi.fn());
const getMessageFeishuMock = vi.hoisted(() => vi.fn());
const getChatInfoMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./channel.runtime.js", () => ({
  feishuChannelRuntime: {
    addReactionFeishu: addReactionFeishuMock,
    listReactionsFeishu: listReactionsFeishuMock,
    removeReactionFeishu: removeReactionFeishuMock,
    getMessageFeishu: getMessageFeishuMock,
    getChatInfo: getChatInfoMock,
  },
}));

const cfg = {
  channels: {
    feishu: {
      enabled: true,
      appId: "cli_main",
      appSecret: "secret_main",
      actions: { reactions: true },
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "open",
    },
  },
} as OpenClawConfig;

const currentChatId = "oc_group_1";
const currentMessageId = "om_current_inbound";

const toolContext = {
  currentChannelProvider: "feishu",
  currentChannelId: currentChatId,
  currentMessagingTarget: currentChatId,
  currentChatType: "group",
  currentMessageId,
};

async function runAction(action: "react" | "reactions", params: Record<string, unknown>) {
  return await feishuPlugin.actions?.handleAction?.({
    action,
    params,
    cfg,
    accountId: undefined,
    toolContext,
  } as never);
}

describe("feishu current-message reactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createFeishuClientMock.mockReturnValue({ tag: "client" });
    getChatInfoMock.mockResolvedValue({
      chat_id: currentChatId,
      chat_mode: "group",
      chat_type: "private",
    });
    getMessageFeishuMock.mockResolvedValue({
      messageId: currentMessageId,
      chatId: currentChatId,
      chatType: "group",
      content: "hello",
      contentType: "text",
    });
  });

  it("adds a reaction to the current inbound message when messageId is omitted", async () => {
    await runAction("react", { emoji: "THUMBSUP" });
    expect(addReactionFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: currentMessageId,
      emojiType: "THUMBSUP",
      accountId: undefined,
    });
  });

  it("lists reactions of the current inbound message when messageId is omitted", async () => {
    listReactionsFeishuMock.mockResolvedValueOnce([]);
    await runAction("reactions", {});
    expect(listReactionsFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: currentMessageId,
      accountId: undefined,
    });
  });

  it("still requires an explicit messageId for a different conversation", async () => {
    await expect(
      runAction("react", { to: "chat:oc_other_group", emoji: "THUMBSUP" }),
    ).rejects.toThrow("Feishu reaction requires messageId.");
    expect(addReactionFeishuMock).not.toHaveBeenCalled();
  });
});
