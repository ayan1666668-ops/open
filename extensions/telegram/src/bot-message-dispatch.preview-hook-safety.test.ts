import { expect, it, vi } from "vitest";
import {
  allDeliveredReplyTexts,
  createContext,
  createReasoningStreamContext,
  createTelegramDraftStream,
  deliverInboundReplyWithMessageSendContext,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  expectDispatchParams,
  getGlobalHookRunner,
  setupDraftStreams,
} from "./bot-message-dispatch.test-harness.js";

function registerHooks(...hooks: string[]) {
  const registered = new Set(hooks);
  getGlobalHookRunner.mockReturnValue({
    hasHooks: vi.fn((hookName: string) => registered.has(hookName)),
  });
}

describeTelegramDispatch("Telegram provider preview hook safety", () => {
  it.each([
    {
      label: "streaming is off",
      streamMode: "off",
      telegramCfg: {},
    },
    {
      label: "partial tool progress is off",
      streamMode: "partial",
      telegramCfg: { streaming: { preview: { toolProgress: false } } },
    },
    {
      label: "progress tool progress is off",
      streamMode: "progress",
      telegramCfg: { streaming: { progress: { toolProgress: false } } },
    },
  ] as const)(
    "suppresses standalone tool progress when $label",
    async ({ streamMode, telegramCfg }) => {
      await dispatchWithContext({ context: createContext(), streamMode, telegramCfg });

      expectDispatchParams({
        replyOptions: expect.objectContaining({ suppressToolProgressMessages: true }),
      });
    },
  );

  it("allows verbose progress when progress rendering is enabled", async () => {
    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { progress: { toolProgress: true } } },
    });

    expectDispatchParams({
      replyOptions: expect.objectContaining({ suppressToolProgressMessages: false }),
    });
  });

  it("preserves answer previews when no hooks are registered", async () => {
    await dispatchWithContext({ context: createContext() });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
    expectDispatchParams({
      replyOptions: expect.objectContaining({ disableBlockStreaming: true }),
    });
  });

  it("preserves answer previews for observer-only hooks", async () => {
    registerHooks("message_sent");

    await dispatchWithContext({ context: createContext() });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
  });

  it.each(["reply_payload_sending", "message_sending"])(
    "suppresses answer and progress previews when %s is registered",
    async (hookName) => {
      registerHooks(hookName);

      await dispatchWithContext({ context: createContext(), streamMode: "progress" });

      expect(createTelegramDraftStream).not.toHaveBeenCalled();
      const params = expectDispatchParams({
        replyOptions: expect.objectContaining({
          onPartialReply: undefined,
          disableBlockStreaming: undefined,
        }),
      });
      expect(params.replyOptions).not.toHaveProperty("forceToolResultProgress");
    },
  );

  it("keeps the progress draft with a modifying hook when previewWithHooks opts in", async () => {
    registerHooks("reply_payload_sending");

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { previewWithHooks: true } } },
    });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
  });

  it("keeps the final answer on the hooked durable path when previewWithHooks keeps the draft", async () => {
    registerHooks("reply_payload_sending");
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { previewWithHooks: true, toolProgress: true } },
      },
    });

    // The waiver covers the draft only: answer text never enters it, and the
    // final still goes through the durable delivery owner where the hooks run.
    expect(answerDraftStream.update.mock.calls.map((call) => call[0])).not.toContain(
      "Final answer",
    );
    const durablyDelivered = [
      ...allDeliveredReplyTexts(),
      ...deliverInboundReplyWithMessageSendContext.mock.calls.map(
        (call) => (call[0] as { payload?: { text?: string } }).payload?.text ?? "",
      ),
    ];
    expect(durablyDelivered).toContain("Final answer");
  });

  it.each([
    {
      label: "outside progress mode",
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial", progress: { previewWithHooks: true } } },
    },
    {
      label: "when the commentary lane is enabled",
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { previewWithHooks: true, commentary: true } },
      },
    },
  ] as const)("ignores previewWithHooks $label", async ({ streamMode, telegramCfg }) => {
    registerHooks("message_sending");

    await dispatchWithContext({ context: createContext(), streamMode, telegramCfg });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
  });

  it("ignores previewWithHooks when reasoning would stream into the progress draft", async () => {
    registerHooks("reply_payload_sending");

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { previewWithHooks: true } } },
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
  });

  it("suppresses previews when both modifying hooks are registered", async () => {
    registerHooks("reply_payload_sending", "message_sending");

    await dispatchWithContext({ context: createContext() });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
  });

  it("suppresses the independent reasoning preview when streaming is otherwise off", async () => {
    registerHooks("message_sending");

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "off" });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
  });

  it("preserves the independent reasoning preview without modifying hooks", async () => {
    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "off" });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
  });
});
