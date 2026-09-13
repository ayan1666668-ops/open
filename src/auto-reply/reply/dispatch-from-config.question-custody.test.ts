import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionWaitAnswerResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import {
  callGatewayTool,
  withQuestionGateway,
} from "../../agents/harness/gateway-question.test-support.js";
import {
  createAgentQuestionAnswerAuthority,
  withAgentQuestionAnswerAuthority,
} from "../../agents/harness/host-private-capabilities.js";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import { runReplyQuestionInput } from "./agent-runner-question-input.js";
import {
  createDispatcher,
  diagnosticMocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticDirectReplyConfig,
  createReplyOperation,
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  replyRunRegistry,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { admitFollowupRunLifecycle, completeFollowupRunLifecycle } from "./queue/types.js";
import {
  REPLY_ADMISSION_TICKET,
  type ReplyOptionsWithAdmissionTicket,
} from "./reply-admission-ticket.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
});
afterEach(() => {
  replyRunTesting.resetReplyRunRegistry();
  resetInboundDedupe();
  clearAgentHarnesses();
});

function createQuestionDispatch(name: string) {
  const key = `agent:main:discord:direct:question-${name}`;
  const sessionId = `question-${name}`;
  sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
  const operation = createReplyOperation({ sessionKey: key, sessionId, resetTriggered: false });
  const cancel = vi.fn();
  operation.attachBackend({ kind: "cli", runId: "independent-question-run", cancel });
  operation.setPhase("running");
  return {
    operation,
    cancel,
    ctx: buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      From: "user:question-fixture",
      To: "channel:question-fixture",
      SessionKey: key,
      MessageSid: `question-answer-${name}`,
      BodyForAgent: "answer",
    }),
  };
}

describe("dispatch input custody after a question response", () => {
  it("releases plugin admission at core adoption so a waiting dispatch can receive its answer", async () => {
    await withQuestionGateway(async (gateway) => {
      const key = "agent:main:plugin:direct:adoption-lane";
      const sessionId = "plugin-adoption-lane";
      const questionId = "ask_plugin_adoption_lane";
      const sessionEntry = { sessionId, updatedAt: Date.now() };
      sessionStoreMocks.currentEntry = sessionEntry;
      const questionStarted = createDeferred();
      const creatorAuthority = createAgentQuestionAnswerAuthority({
        sessionKey: key,
        fingerprint: "plugin-user",
        project: (caller) =>
          caller.senderIsOwner && caller.messageProvider === "plugin" ? "plugin-user" : undefined,
        assertActive: () => {},
      });
      let question: ReturnType<typeof registerPendingAgentQuestion> | undefined;
      let admissionTail: Promise<void> = Promise.resolve();
      let agentTurns = 0;

      const receive = (
        text: string,
        messageId: string,
        resolver: NonNullable<Parameters<typeof dispatchReplyFromConfig>[0]["replyResolver"]>,
      ): Promise<Awaited<ReturnType<typeof dispatchReplyFromConfig>>> => {
        let finish!: (result: Awaited<ReturnType<typeof dispatchReplyFromConfig>>) => void;
        let fail!: (error: unknown) => void;
        const completion = new Promise<Awaited<ReturnType<typeof dispatchReplyFromConfig>>>(
          (resolve, reject) => {
            finish = resolve;
            fail = reject;
          },
        );
        const admit = async () => {
          let released = false;
          let release!: () => void;
          const adopted = new Promise<void>((resolve) => {
            release = () => {
              if (released) {
                return;
              }
              released = true;
              resolve();
            };
          });
          const dispatch = dispatchReplyFromConfig({
            ctx: buildTestCtx({
              Provider: "plugin",
              Surface: "plugin",
              ChatType: "direct",
              From: "user:plugin-fixture",
              To: "channel:plugin-fixture",
              SessionKey: key,
              MessageSid: messageId,
              Body: text,
              RawBody: text,
              CommandBody: text,
              BodyForAgent: text,
            }),
            cfg: automaticDirectReplyConfig,
            dispatcher: createDispatcher(),
            replyOptions: {
              turnAdoptionLifecycle: {
                admission: "exclusive",
                onAdopted: release,
                onDeferred: release,
                onAbandoned: release,
              },
            },
            replyResolver: resolver,
          });
          void dispatch.then(finish, fail).finally(release);
          await adopted;
        };
        const admitted = admissionTail.then(admit, admit);
        admissionTail = admitted.then(
          () => undefined,
          () => undefined,
        );
        return completion;
      };

      const first = receive("start question", "question-start", async (_ctx, opts) => {
        agentTurns += 1;
        // This test resolver begins at the same boundary where runReplyAgent
        // publishes adoption before an ask_user call can wait.
        const ticket = (opts as (GetReplyOptions & ReplyOptionsWithAdmissionTicket) | undefined)?.[
          REPLY_ADMISSION_TICKET
        ];
        ticket?.release();
        await opts?.turnAdoptionLifecycle?.onAdopted();
        const questions = [
          {
            id: "answer",
            header: "Answer",
            question: "Continue?",
            isOther: true,
            options: [],
          },
        ];
        question = withAgentQuestionAnswerAuthority(creatorAuthority, () =>
          registerPendingAgentQuestion({ sessionKey: key, questionId, questions }),
        );
        const registration = callGatewayTool(
          "question.request",
          {},
          {
            id: questionId,
            sessionKey: key,
            timeoutMs: 60_000,
            questions: questions.map((entry) => ({
              questionId: entry.id,
              header: entry.header,
              question: entry.question,
              isOther: entry.isOther,
              options: entry.options,
            })),
          },
        );
        question.attachRegistration(registration);
        await registration;
        const answer = callGatewayTool(
          "question.waitAnswer",
          { timeoutMs: 70_000 },
          { id: questionId, timeoutMs: 60_000, includeResolutionId: true },
        ) as Promise<QuestionWaitAnswerResult>;
        question.setAnswer(answer);
        questionStarted.resolve();
        await expect(answer).resolves.toMatchObject({ status: "answered" });
        return undefined;
      });

      try {
        await questionStarted.promise;
        await gateway.waitStarted;
        const answer = receive("没事", "question-answer", async (ctx, opts) => {
          const followupRun = createQueueTestRun({
            prompt: "没事",
            messageId: "question-answer",
            originatingChannel: "plugin",
            originatingTo: "channel:plugin-fixture",
          });
          followupRun.run.agentId = "main";
          followupRun.run.sessionKey = key;
          followupRun.run.senderIsOwner = true;
          followupRun.run.messageProvider = "plugin";
          followupRun.turnAdoptionLifecycle = opts?.turnAdoptionLifecycle;
          const claimed = await runReplyQuestionInput({
            commandBody: "没事",
            followupRun,
            sessionKey: key,
            sessionCtx: ctx,
            sessionEntry,
            opts,
          });
          if (!claimed.handled) {
            agentTurns += 1;
            return { text: "unexpected second agent turn" };
          }
          return claimed.payload;
        });

        await expect(answer).resolves.toMatchObject({ queuedFinal: false });
        await expect(first).resolves.toMatchObject({ queuedFinal: true });
        await expect(gateway.manager.waitAnswer(questionId)).resolves.toMatchObject({
          status: "answered",
          answers: { answers: { answer: ["没事"] } },
        });
        expect(agentTurns).toBe(1);
        expect(question?.isResolving()).toBe(true);
      } finally {
        question?.dispose();
      }
    });
  });

  // Real question/receipt classification is covered by the wire regression. Here
  // the real dispatch owner must preserve that recorded fact through source faults.
  it.each(
    ["confirmed", "indeterminate"].flatMap((outcome) =>
      ["settlement-error", "source-abort"].map((failure) => ({ outcome, failure })),
    ),
  )("does not replay $outcome input after $failure", async ({ outcome, failure }) => {
    const fixture = createQuestionDispatch(`${outcome}-${failure}`);
    const abort = new AbortController();
    const cleanupError = new Error("source settlement failed");
    const onAdopted = vi.fn(async () => {
      throw new Error("source adoption closed");
    });
    const onSettled = vi.fn(() => {
      if (failure === "source-abort") {
        abort.abort();
      } else {
        throw cleanupError;
      }
    });
    const resolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const state = resolveReplyOperationRunState(opts);
      if (!state) {
        throw new Error("missing dispatch run state");
      }
      state.admission =
        outcome === "confirmed"
          ? { status: "accepted", mode: "steer" }
          : { status: "skipped", reason: "question-response-indeterminate" };
      const input = { turnAdoptionLifecycle: opts?.turnAdoptionLifecycle };
      await admitFollowupRunLifecycle(input).catch(() => {});
      completeFollowupRunLifecycle(input, "consumed");
      return undefined;
    });
    try {
      const first = dispatchReplyFromConfig({
        ctx: fixture.ctx,
        cfg: automaticDirectReplyConfig,
        dispatcher: createDispatcher(),
        replyOptions: {
          abortSignal: abort.signal,
          turnAdoptionLifecycle: { onAdopted, onSettled },
        },
        replyResolver: resolver,
      });
      if (failure === "settlement-error") {
        await expect(first).rejects.toBe(cleanupError);
      } else {
        await expect(first).resolves.toMatchObject({ queuedFinal: false });
      }
      const replay = vi.fn(async () => ({ text: "must not replay" }));
      await dispatchReplyFromConfig({
        ctx: fixture.ctx,
        cfg: automaticDirectReplyConfig,
        dispatcher: createDispatcher(),
        replyOptions: { turnAdoptionLifecycle: { onAdopted: async () => {} } },
        replyResolver: replay,
      });
      expect(replay).not.toHaveBeenCalled();
      expect(onAdopted).toHaveBeenCalledOnce();
      expect(onSettled).toHaveBeenCalledOnce();
      expect(fixture.cancel).not.toHaveBeenCalled();
      expect(fixture.operation.result).toBeNull();
      expect(replyRunRegistry.get(fixture.operation.key)).toBe(fixture.operation);
    } finally {
      fixture.operation.complete();
    }
  });

  it.each(["question-response-indeterminate", "question-response-refused"] as const)(
    "delivers %s and records an error instead of a successful agent turn",
    async (reason) => {
      const fixture = createQuestionDispatch(reason);
      const dispatcher = createDispatcher();
      const notice =
        reason === "question-response-indeterminate"
          ? "The question answer could not be confirmed; check before retrying."
          : "The question answer was refused; check your permissions before retrying.";
      try {
        await dispatchReplyFromConfig({
          ctx: fixture.ctx,
          cfg: { ...automaticDirectReplyConfig, diagnostics: { enabled: true } },
          dispatcher,
          replyOptions: { turnAdoptionLifecycle: { onAdopted: async () => {} } },
          replyResolver: async (_ctx, opts) => {
            const state = resolveReplyOperationRunState(opts);
            if (!state) {
              throw new Error("missing dispatch run state");
            }
            state.admission = { status: "skipped", reason };
            return { text: notice, isError: true };
          },
        });
        expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: notice, isError: true });
        expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "error", reason }),
        );
        expect(fixture.cancel).not.toHaveBeenCalled();
        expect(fixture.operation.result).toBeNull();
      } finally {
        fixture.operation.complete();
      }
    },
  );

  it("delivers a host question refusal when the agent owns normal replies", async () => {
    const fixture = createQuestionDispatch("host-refusal");
    const dispatcher = createDispatcher();
    const question = registerPendingAgentQuestion({
      sessionKey: fixture.operation.key,
      questionId: "ask_unbound_source",
      questions: [{ id: "answer", header: "Answer", question: "Continue?" }],
      answer: Promise.resolve({ status: "pending" }),
    });
    question.attachRegistration(Promise.resolve());
    try {
      await dispatchReplyFromConfig({
        ctx: fixture.ctx,
        cfg: automaticDirectReplyConfig,
        dispatcher,
        replyOptions: {
          sourceReplyDeliveryMode: "message_tool_only",
          turnAdoptionLifecycle: { onAdopted: async () => {} },
        },
        replyResolver: async (ctx, opts) => {
          const result = await runReplyQuestionInput({
            commandBody: "answer",
            followupRun: createQueueTestRun({ prompt: "answer" }),
            sessionKey: fixture.operation.key,
            sessionCtx: ctx,
            opts,
          });
          expect(result.handled).toBe(true);
          return result.handled ? result.payload : undefined;
        },
      });
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("The answer was not sent"),
          isError: true,
        }),
      );
      expect(fixture.cancel).not.toHaveBeenCalled();
    } finally {
      question.dispose();
      fixture.operation.complete();
    }
  });

  it("still permits retry when the source failed before any input custody transfer", async () => {
    const fixture = createQuestionDispatch("before-custody");
    const error = new Error("failure before input dispatch");
    try {
      await expect(
        dispatchReplyFromConfig({
          ctx: fixture.ctx,
          cfg: automaticDirectReplyConfig,
          dispatcher: createDispatcher(),
          replyOptions: { turnAdoptionLifecycle: { onAdopted: async () => {} } },
          replyResolver: async () => {
            throw error;
          },
        }),
      ).rejects.toBe(error);
      const retry = vi.fn(async () => ({ text: "retry is safe" }));
      await dispatchReplyFromConfig({
        ctx: fixture.ctx,
        cfg: automaticDirectReplyConfig,
        dispatcher: createDispatcher(),
        replyOptions: { turnAdoptionLifecycle: { onAdopted: async () => {} } },
        replyResolver: retry,
      });
      expect(retry).toHaveBeenCalledOnce();
      expect(fixture.cancel).not.toHaveBeenCalled();
    } finally {
      fixture.operation.complete();
    }
  });
});
