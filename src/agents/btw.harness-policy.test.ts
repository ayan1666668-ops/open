import "./btw.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { acceptedModelSelection } from "../test-utils/session-execution-selection.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_SESSION_KEY,
  createSessionEntry,
  registerAgentHarness,
  runSideQuestion,
  createAgentHarnessHostCapabilitiesMock,
  closeAgentHarnessHostCapabilitiesMock,
  registerCodexSideQuestionHarness,
  mockOpenAIPlatformProfile,
  resolveModelWithRegistryMock,
  resolveModelAsyncMock,
  mockArg,
  setupBtwTestHooks,
} from "./btw.test-support.js";

describe("BTW harness policy and authority", () => {
  setupBtwTestHooks();

  it("uses registry ownership and closes host capabilities when a BTW hook rejects", async () => {
    const selection = acceptedModelSelection(DEFAULT_PROVIDER, DEFAULT_MODEL, {
      executor: { kind: "harness", id: "spoofed" },
    });
    const entry = createSessionEntry({
      executionSelection: selection,
      modelFallback: {
        previous: selection,
        prevModel: DEFAULT_MODEL,
        prevProvider: DEFAULT_PROVIDER,
        ts: 1,
        source: "agent-patch",
      },
    });
    registerAgentHarness(
      {
        id: "spoofed",
        label: "Spoofed BTW harness",
        pluginId: "codex",
        supports: () => ({ supported: true, priority: 100 }),
        runAttempt: vi.fn(),
        runSideQuestion: async (params) => {
          expect(params.sessionEntry).toMatchObject({
            providerOverride: DEFAULT_PROVIDER,
            modelOverride: DEFAULT_MODEL,
            agentRuntimeOverride: "spoofed",
            modelFallback: { prevModelOverride: DEFAULT_MODEL },
          });
          expect(params.sessionEntry).not.toHaveProperty("executionSelection");
          expect(params.sessionEntry.modelFallback).not.toHaveProperty("previous");
          expect(params.sessionStore?.[DEFAULT_SESSION_KEY]).toEqual(params.sessionEntry);
          throw new Error("side question failed");
        },
      },
      { ownerPluginId: "actual-owner" },
    );

    await expect(
      runSideQuestion({ sessionEntry: entry, sessionStore: { [DEFAULT_SESSION_KEY]: entry } }),
    ).rejects.toThrow("side question failed");
    expect(entry.modelFallback?.previous).toEqual(selection);

    expect(createAgentHarnessHostCapabilitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "actual-owner" }),
    );
    expect(closeAgentHarnessHostCapabilitiesMock).toHaveBeenCalledOnce();
  });

  it("prepares deny-all sender policy before calling a plugin side-question hook", async () => {
    const codexSideQuestionMock = registerCodexSideQuestionHarness();
    mockOpenAIPlatformProfile();
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
    });
    resolveModelAsyncMock.mockResolvedValue({
      model: {
        provider: "openai",
        id: "gpt-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    });
    await runSideQuestion({
      cfg: {
        channels: {
          telegram: {
            groups: {
              "deny-room": {
                toolsBySender: {
                  "id:restricted-sender": { deny: ["*"] },
                },
              },
            },
          },
        },
      } as never,
      provider: "openai",
      model: "gpt-5.5",
      sessionKey: "agent:main:telegram:group:deny-room",
      messageProvider: "telegram",
      groupId: "deny-room",
      senderId: "restricted-sender",
    });

    expect(codexSideQuestionMock).toHaveBeenCalledOnce();
    expect(mockArg(codexSideQuestionMock, 0, 0)).toMatchObject({ toolsAllow: [] });
  });
});
