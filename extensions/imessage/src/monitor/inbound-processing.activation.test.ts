import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { createIMessageGroupActivationResolver } from "./group-activation.js";
import { resolveIMessageInboundDecision } from "./inbound-processing.js";

const sessionStoreMocks = vi.hoisted(() => ({
  getSessionEntry: vi.fn(),
  resolveStorePath: vi.fn(() => "/tmp/openclaw-imessage-activation-test.sqlite"),
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => sessionStoreMocks);

const SENDER = "+15550001111";
const GROUP_ID = 99;

function createConfig(requireMention: boolean): OpenClawConfig {
  return {
    channels: {
      imessage: {
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        groups: { [String(GROUP_ID)]: { requireMention } },
      },
    },
    commands: { ownerAllowFrom: [`imessage:${SENDER}`] },
    messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
  } as OpenClawConfig;
}

async function resolve(params: {
  cfg: OpenClawConfig;
  text: string;
  resolveGroupActivation: (params: {
    agentId: string;
    sessionKey: string;
    cfg: OpenClawConfig;
  }) => boolean | undefined;
}) {
  return await resolveIMessageInboundDecision({
    cfg: params.cfg,
    accountId: "default",
    message: {
      id: 1,
      chat_id: GROUP_ID,
      sender: SENDER,
      is_from_me: false,
      text: params.text,
      is_group: true,
    },
    resolveGroupActivation: params.resolveGroupActivation,
    opts: {},
    messageText: params.text,
    bodyText: params.text,
    allowFrom: ["*"],
    groupAllowFrom: [],
    groupPolicy: "open",
    dmPolicy: "open",
    storeAllowFrom: [],
    historyLimit: 0,
    groupHistories: new Map(),
  });
}

describe("iMessage session activation gating", () => {
  it("loads persisted group activation from the routed session", async () => {
    const cfg = createConfig(false);
    const sessionKey = "agent:main:imessage:group:99";
    sessionStoreMocks.getSessionEntry.mockReturnValue({ groupActivation: "mention" });
    const resolveGroupActivation = createIMessageGroupActivationResolver(vi.fn());

    expect(resolveGroupActivation({ agentId: "main", sessionKey, cfg })).toBe(true);
    expect(sessionStoreMocks.getSessionEntry).toHaveBeenCalledWith({
      storePath: "/tmp/openclaw-imessage-activation-test.sqlite",
      sessionKey,
    });
  });

  it("lets session mention activation override always-on group config", async () => {
    const cfg = createConfig(false);
    const resolveGroupActivation = vi.fn(() => true);

    const decision = await resolve({ cfg, text: "hello group", resolveGroupActivation });

    expect(decision).toEqual({ kind: "drop", reason: "no mention" });
    expect(resolveGroupActivation).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:imessage:group:99",
      cfg,
    });
  });

  it("lets session always activation override mention-only group config", async () => {
    const decision = await resolve({
      cfg: createConfig(true),
      text: "hello group",
      resolveGroupActivation: () => false,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("still admits authorized activation commands in mention mode", async () => {
    const decision = await resolve({
      cfg: createConfig(true),
      text: "/activation always",
      resolveGroupActivation: () => true,
    });

    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.commandAuthorized).toBe(true);
    expect(decision.hasControlCommand).toBe(true);
  });
});
