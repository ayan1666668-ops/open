import { expect, it } from "vitest";
import {
  createContext,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  setupDraftStreams,
} from "./bot-message-dispatch.test-harness.js";

const question = {
  text: "Send the reviewed email?",
  channelData: { askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" } },
};

function callOrder(mock: { mock: { invocationCallOrder: number[] } }): number[] {
  return mock.mock.invocationCallOrder;
}

describeTelegramDispatch("dispatchTelegramMessage native questions", () => {
  it.each(["progress", "partial"] as const)(
    "keeps a question that finalized the %s tool-progress draft when the final answer retires it",
    async (streamMode) => {
      const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
          await dispatcherOptions.deliver(question, { kind: "tool" });
          await dispatcherOptions.deliver({ text: "No answer was received." }, { kind: "final" });
          return { queuedFinal: true };
        },
      );

      await dispatchWithContext({
        context: createContext(),
        streamMode,
        telegramCfg: { streaming: { mode: streamMode, progress: { toolProgress: true } } },
      });

      // The question finalized the draft in place, so that message is durable.
      const questionUpdate = answerDraftStream.update.mock.calls.findIndex(
        (call) => call[0] === question.text,
      );
      expect(questionUpdate).toBeGreaterThanOrEqual(0);
      const questionOrder = callOrder(answerDraftStream.update)[questionUpdate] ?? 0;
      // Retiring the draft afterwards must not delete the finalized question:
      // neither a deferred-delete reposition nor a clear may follow it.
      const deletesAfterQuestion = [
        ...callOrder(answerDraftStream.rotateToNewMessageDeferringDelete),
        ...callOrder(answerDraftStream.clear),
      ].filter((order) => order > questionOrder);
      expect(deletesAfterQuestion).toEqual([]);
      expect(
        callOrder(answerDraftStream.forceNewMessage).some((order) => order > questionOrder),
      ).toBe(true);
    },
  );
});
