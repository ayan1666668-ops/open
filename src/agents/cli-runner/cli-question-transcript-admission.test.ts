import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { withSessionTranscriptQuestionAnswers } from "../../config/sessions/session-transcript-read-fence.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  createTestUserTurnTranscriptTarget,
  readTranscriptMessages,
} from "../../sessions/user-turn-transcript.test-support.js";
import {
  claimPendingAgentQuestionAnswer,
  runAgentHarnessGatewayQuestion,
} from "../harness/gateway-question.js";
import { withQuestionGateway } from "../harness/gateway-question.test-support.js";
import { withAgentQuestionAnswerAuthority } from "../harness/host-private-capabilities.js";
import { SessionManager } from "../sessions/session-manager.js";
import { createCliQuestionAnswerAuthority } from "./cli-question-answer-authority.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const questions = [
  { id: "destination", header: "Destination", question: "Where?", isOther: true, options: [] },
  { id: "budget", header: "Budget", question: "Budget?", isOther: true, options: [] },
];

it("CLI question custody admits a channel answer so the waiting tool-result append continues", async () => {
  await withQuestionGateway(async (gateway) => {
    const dir = tempDirs.make("cli-question-transcript-append-");
    const storePath = path.join(dir, "sessions.sqlite");
    const target = {
      ...createTestUserTurnTranscriptTarget({
        sessionId: "cli-question-transcript",
        sessionKey: "agent:main:cli-question-transcript",
        cwd: dir,
      }),
      storePath,
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const original = createUserTurnTranscriptRecorder({
      target,
      input: { text: "Plan a trip", idempotencyKey: "original:user" },
    });
    const persisted = await original.persistApproved();
    if (!persisted) {
      throw new Error("original input did not persist");
    }
    const controller = new AbortController();
    const writer = SessionManager.open(target, dir);
    const releaseAppend = createDeferred();
    const providerResumed = vi.fn();

    // Mirror CLI ask_user: bind under custody so channel claim closes over that scope.
    const run = withSessionTranscriptQuestionAnswers(
      original,
      () => {
        controller.signal.throwIfAborted();
      },
      async () => {
        const authority = createCliQuestionAnswerAuthority({
          sessionKey: target.sessionKey,
          fingerprint: "cli-question-fingerprint",
          project: () => "cli-question-fingerprint",
          assertActive: () => {
            controller.signal.throwIfAborted();
          },
        });
        expect(authority.admitTranscriptAnswer).toEqual(expect.any(Function));

        return await withAgentQuestionAnswerAuthority(authority, async () => {
          const answer = await runAgentHarnessGatewayQuestion({
            questions,
            sessionKey: target.sessionKey,
            runId: "cli-question-run",
            agentId: target.agentId,
            timeoutMs: 60_000,
            signal: controller.signal,
            delivery: { onBlockReply: async () => {} },
          });
          await releaseAppend.promise;
          const entryId = writer.appendMessage({
            role: "toolResult",
            toolCallId: "trip-question",
            toolName: "ask_user",
            content: [{ type: "text", text: JSON.stringify(answer) }],
            isError: answer.status !== "answered",
            timestamp: 4,
          });
          providerResumed(answer);
          return entryId;
        });
      },
    );
    const outcome = run.then(
      (entryId) => ({ entryId, error: undefined as undefined }),
      (error: unknown) => ({ entryId: undefined, error }),
    );

    try {
      await gateway.waitStarted;
      const source = createUserTurnTranscriptRecorder({
        target,
        input: { text: "1: Lisbon\n2: 2000", idempotencyKey: "complete:user" },
      });
      await source.stageApproved?.({ runId: "complete", assertCurrent: () => {} });
      await expect(
        claimPendingAgentQuestionAnswer({
          sessionKey: target.sessionKey,
          text: "1: Lisbon\n2: 2000",
          sourceRecorder: source,
          authority: { kind: "run", assertCurrent: () => controller.signal.throwIfAborted() },
        }),
      ).resolves.toBe(true);
      releaseAppend.resolve();
      const result = await outcome;
      expect(result.error).toBeUndefined();
      expect(result.entryId).toEqual(expect.any(String));
      expect(providerResumed).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          status: "answered",
          answers: { answers: { destination: ["Lisbon"], budget: ["2000"] } },
        }),
      );
      const messages = await readTranscriptMessages({
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        storePath,
      });
      expect(messages.some((message) => message.role === "toolResult")).toBe(true);
    } finally {
      controller.abort();
      releaseAppend.resolve();
      await outcome;
    }
  });
});
