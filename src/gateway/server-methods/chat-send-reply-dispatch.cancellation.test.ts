import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { deliverPreDispatchNotice } from "../../agents/embedded-agent-runner/run/pre-dispatch-notice.js";
import {
  loadTranscriptEventsSync,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntry } from "../session-utils.js";
import { createChatSendReplyDispatch } from "./chat-send-reply-dispatch.js";
import * as transcriptInject from "./chat-transcript-inject.js";

type Scenario = "aborted" | "replaced" | "rotated" | "lifecycle";

const SESSION_KEY = "agent:main:notice-boundary";
const INITIAL_SESSION_ID = "notice-boundary-initial";

function readAssistantTexts(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string | undefined;
}): string[] {
  return loadTranscriptEventsSync(params).flatMap((event) => {
    const message = asOptionalRecord(asOptionalRecord(event)?.message);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) {
      return [];
    }
    return message.content.flatMap((block) => {
      const record = asOptionalRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    });
  });
}

async function createFixture(scenario: Scenario) {
  const runId = `notice-boundary:${scenario}:old`;
  const currentSession = loadSessionEntry(SESSION_KEY, { agentId: "main" });
  const scope = {
    agentId: "main",
    sessionId: INITIAL_SESSION_ID,
    sessionKey: SESSION_KEY,
    storePath: currentSession.storePath,
  };
  await replaceSessionEntry(scope, {
    sessionId: INITIAL_SESSION_ID,
    lifecycleRevision: "initial",
    updatedAt: 1,
  });

  let currentRunId: string | undefined = runId;
  const abortController = new AbortController();
  const createDispatch = (clientRunId: string, signal: AbortSignal) =>
    createChatSendReplyDispatch({
      accountId: undefined,
      isAgentRunStarted: () => true,
      isRunCurrent: () => currentRunId === clientRunId,
      abortSignal: signal,
      logGateway: {
        ...createSubsystemLogger("test/chat-send-reply-dispatch-cancellation"),
        warn: vi.fn(),
      },
      session: {
        agentId: "main",
        backingSessionId: scope.sessionId,
        cfg: {},
        clientRunId,
        sessionKey: scope.sessionKey,
        sessionLoadOptions: { agentId: "main" },
      },
      userTurnRecorder: { markBlocked: vi.fn(), getAdmissionReceipt: () => undefined },
    });

  return {
    abortController,
    createDispatch,
    retire: () => {
      currentRunId = undefined;
    },
    activate: (clientRunId: string) => {
      currentRunId = clientRunId;
    },
    runId,
    scope,
  };
}

describe("pre-dispatch notice production cancellation boundary", () => {
  it.each(["aborted", "replaced", "rotated", "lifecycle"] as const)(
    "rejects a held %s run before transcript or fallback effects, then delivers its successor once",
    async (scenario) => {
      await withOpenClawTestState({ label: `webchat-notice-boundary-${scenario}` }, async () => {
        const fixture = await createFixture(scenario);
        const oldDispatch = fixture.createDispatch(fixture.runId, fixture.abortController.signal);
        const entered = createDeferred();
        const release = createDeferred();
        const callbackFinished = createDeferred();
        const attempts: Array<{ idempotencyKey?: string; ok: boolean }> = [];
        const originalAppend = transcriptInject.appendInjectedAssistantMessageToTranscript;
        const append = vi
          .spyOn(transcriptInject, "appendInjectedAssistantMessageToTranscript")
          .mockImplementation(async (params) => {
            if (params.idempotencyKey === `${fixture.runId}:pre-dispatch-notice`) {
              entered.resolve();
              await release.promise;
            }
            const result = await originalAppend(params);
            attempts.push({ idempotencyKey: params.idempotencyKey, ok: result.ok });
            return result;
          });
        const oldFallback = vi.fn(async () => {});
        const oldNotice = deliverPreDispatchNotice({
          notice: { text: "Late old-run notice" },
          runId: fixture.runId,
          signal: fixture.abortController.signal,
          onPreDispatchNotice: async (payload) => {
            try {
              return await oldDispatch.onPreDispatchNotice(payload);
            } finally {
              callbackFinished.resolve();
            }
          },
          onBlockReply: oldFallback,
        });

        try {
          await entered.promise;
          if (scenario === "aborted") {
            fixture.abortController.abort();
          } else if (scenario === "replaced") {
            fixture.retire();
          } else {
            await replaceSessionEntry(fixture.scope, {
              sessionId:
                scenario === "lifecycle" ? INITIAL_SESSION_ID : "notice-boundary-successor",
              lifecycleRevision: "rotated",
              updatedAt: 2,
            });
          }
          release.resolve();

          if (scenario === "aborted") {
            await expect(oldNotice).rejects.toMatchObject({ name: "AbortError" });
          } else {
            await expect(oldNotice).resolves.toBe("delivered");
          }
          await callbackFinished.promise;
          expect(oldFallback).not.toHaveBeenCalled();
          expect(fixture.abortController.signal.aborted).toBe(scenario === "aborted");

          const oldSessionTexts = readAssistantTexts(fixture.scope);
          expect(oldSessionTexts).not.toContain("Late old-run notice");
          expect(attempts).toEqual([
            {
              idempotencyKey: `${fixture.runId}:pre-dispatch-notice`,
              ok: false,
            },
          ]);

          const successorSessionId =
            scenario === "rotated" ? "notice-boundary-successor" : INITIAL_SESSION_ID;
          const successorRunId = `notice-boundary:${scenario}:successor`;
          fixture.activate(successorRunId);
          const successorDispatch = fixture.createDispatch(
            successorRunId,
            new AbortController().signal,
          );
          const successorFallback = vi.fn(async () => {});
          await expect(
            deliverPreDispatchNotice({
              notice: { text: "Successor notice" },
              runId: successorRunId,
              signal: new AbortController().signal,
              onPreDispatchNotice: successorDispatch.onPreDispatchNotice,
              onBlockReply: successorFallback,
            }),
          ).resolves.toBe("delivered");
          expect(successorFallback).not.toHaveBeenCalled();
          expect(attempts).toEqual([
            {
              idempotencyKey: `${fixture.runId}:pre-dispatch-notice`,
              ok: false,
            },
            {
              idempotencyKey: `${successorRunId}:pre-dispatch-notice`,
              ok: true,
            },
          ]);

          const successorScope = {
            ...fixture.scope,
            sessionId: successorSessionId,
          };
          expect(readAssistantTexts(successorScope)).toEqual(["Successor notice"]);
        } finally {
          release.resolve();
          await callbackFinished.promise.catch(() => {});
          append.mockRestore();
        }
      });
    },
  );

  it("falls back once when the current session has an ordinary durable write failure", async () => {
    await withOpenClawTestState({ label: "webchat-notice-boundary-current-failure" }, async () => {
      const fixture = await createFixture("replaced");
      const dispatch = fixture.createDispatch(fixture.runId, fixture.abortController.signal);
      const append = vi
        .spyOn(transcriptInject, "appendInjectedAssistantMessageToTranscript")
        .mockResolvedValueOnce({ ok: false, error: "synthetic writer failure" });
      const fallback = vi.fn(async () => {});

      try {
        await expect(
          deliverPreDispatchNotice({
            notice: { text: "Current notice" },
            runId: `${fixture.runId}:ordinary-failure`,
            signal: fixture.abortController.signal,
            onPreDispatchNotice: dispatch.onPreDispatchNotice,
            onBlockReply: fallback,
          }),
        ).resolves.toBe("delivered");
        expect(append).toHaveBeenCalledOnce();
        expect(fallback).toHaveBeenCalledExactlyOnceWith({
          text: "Current notice",
          isStatusNotice: true,
        });
        expect(readAssistantTexts(fixture.scope)).toEqual([]);
      } finally {
        append.mockRestore();
      }
    });
  });
});
