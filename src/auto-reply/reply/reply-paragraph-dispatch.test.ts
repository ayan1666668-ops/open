import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished } from "vitest";
import { EmbeddedBlockChunker } from "../../agents/embedded-agent-block-chunker.js";
import { copyReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { createAgentTurnPresentation } from "./agent-runner-presentation.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

function createParagraphDispatch(
  coalescing = false,
  { maxChars = 200, joiner = "\n\n" }: { maxChars?: number; joiner?: string } = {},
) {
  const beforeDelivery: ReplyPayload[] = [];
  const delivered: ReplyPayload[] = [];
  const sourcePayloads: ReplyPayload[] = [];
  const dispatcher = createReplyDispatcher({
    beforeDeliver: async (payload) => {
      beforeDelivery.push(payload);
      return payload;
    },
    deliver: async (payload) => {
      delivered.push(payload);
    },
  });
  const onBlockReply = async (payload: ReplyPayload) => {
    const copied = copyReplyPayloadMetadata(payload, { ...payload });
    sourcePayloads.push(copied);
    dispatcher.sendBlockReply(copied);
    await dispatcher.waitForIdle();
  };
  const pipeline = createBlockReplyPipeline({
    timeoutMs: 5000,
    ...(coalescing ? { coalescing: { minChars: 1, maxChars, idleMs: 0, joiner } } : {}),
    onBlockReply,
  });
  const turn = {
    followupRun: { run: { silentExpected: false } },
    isHeartbeat: false,
    sessionCtx: {},
    opts: { onBlockReply, reasoningPayloadsEnabled: true, commentaryPayloadsEnabled: true },
    applyReplyToMode: (payload: ReplyPayload) => payload,
    typingSignals: createTypingSignaler({
      typing: createMockTypingController(),
      mode: "never",
      isHeartbeat: false,
    }),
    blockStreamingEnabled: true,
    blockReplyPipeline: pipeline,
  } as unknown as AgentTurnParams;
  const handler = createAgentTurnPresentation({
    turn,
    replyMediaContext: { normalizePayload: async (payload) => payload },
    directlySentBlockKeys: new Set(),
    directBlockDeliveries: [],
    heartbeatState: { didLogStrip: false },
  }).blockReplyHandler;
  if (!handler) {
    throw new Error("Expected the real presentation block reply handler");
  }
  const flush = async () => {
    await pipeline.flush({ force: true });
    await dispatcher.waitForIdle();
  };
  onTestFinished(async () => {
    await flush();
    pipeline.stop();
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  });
  return { handler, dispatcher, flush, beforeDelivery, delivered, sourcePayloads };
}

describe("streamed paragraph dispatch", () => {
  it.each(["\n", "\n ", "\n\n", "\n \n"])(
    "keeps multiple %j source boundaries when one forced drain is coalesced",
    async (boundary) => {
      const first = "12345678901234567890";
      const input = `${first}${boundary}B${boundary}C`;
      const chunker = new EmbeddedBlockChunker({
        minChars: 1,
        maxChars: 20,
        breakPreference: "newline",
        flushOnParagraph: true,
      });
      const chunks: ReplyPayload[] = [];
      chunker.append(input);
      chunker.drain({
        force: true,
        emit: (text, options) => {
          chunks.push(setReplyPayloadMetadata({ text }, { blockSourceText: options?.sourceText }));
        },
      });
      expect(chunks.map((payload) => payload.text)).toEqual([
        first,
        `${boundary}B`,
        `${boundary}C`,
      ]);

      const flow = createParagraphDispatch(true, { maxChars: 20, joiner: "\n" });
      for (const payload of chunks) {
        await flow.handler(payload);
      }
      await flow.flush();
      expect(flow.delivered.map((payload) => payload.text)).toEqual([
        first,
        `${boundary}B${boundary}C`,
      ]);
      expect(flow.delivered.map((payload) => payload.text).join("")).toBe(input);
      expect(
        flow.delivered.every((payload) => payload.text?.trim() && payload.text.length <= 20),
      ).toBe(true);
    },
  );

  it.each([
    { coalescing: false, prefix: "\n" },
    { coalescing: true, prefix: "\n" },
    { coalescing: false, prefix: "\n \n" },
    { coalescing: true, prefix: "\n \n" },
  ])(
    "preserves a copied $prefix continuation through normalization and hooks (coalescing=$coalescing)",
    async ({ coalescing, prefix }) => {
      const flow = createParagraphDispatch(coalescing);
      await flow.handler({ text: "\n\nFirst" });
      await flow.flush();
      await flow.handler({ text: `${prefix}Second` });
      if (coalescing) {
        await flow.handler({ text: "Caption", mediaUrl: "https://example.invalid/image.png" });
      }
      await flow.flush();
      const expected = ["First", `${prefix}Second${coalescing ? "\n\nCaption" : ""}`];
      expect(flow.beforeDelivery.map((payload) => payload.text)).toEqual(expected);
      expect(flow.delivered.map((payload) => payload.text)).toEqual(expected);
      expect(flow.delivered.every((payload) => Boolean(payload.text?.trim()))).toBe(true);
    },
  );

  it.each([
    "isReasoning",
    "isCommentary",
    "isStatusNotice",
    "isCompactionNotice",
    "isFallbackNotice",
    "isError",
  ] as const)("does not let %s establish source continuation formatting", async (flag) => {
    const flow = createParagraphDispatch();
    await flow.handler({ text: "Notice", [flag]: true });
    await flow.handler({ text: "\n\nFirst" });
    await flow.handler({ text: "\n\nSecond" });
    await flow.flush();
    expect(flow.sourcePayloads.slice(-2).map((payload) => payload.text)).toEqual([
      "First",
      "\n\nSecond",
    ]);
    expect(flow.beforeDelivery.slice(-2).map((payload) => payload.text)).toEqual([
      "First",
      "\n\nSecond",
    ]);
  });

  it("keeps default, error, silent and internal-context sanitization active", async () => {
    const flow = createParagraphDispatch();
    await flow.handler({ text: "First" });
    await flow.handler({ text: "\n\nSecond" });
    await flow.flush();
    const continuation = expectDefined(flow.sourcePayloads[1], "source continuation block");
    const unmarked = { text: "\n\nUnmarked", streamedSourceBoundary: true };
    flow.dispatcher.sendBlockReply(unmarked);
    flow.dispatcher.sendBlockReply(
      copyReplyPayloadMetadata(continuation, { text: "\n\nVisible error", isError: true }),
    );
    expect(
      flow.dispatcher.sendBlockReply(
        copyReplyPayloadMetadata(continuation, { text: "\n\nNO_REPLY" }),
      ),
    ).toBe(false);
    flow.dispatcher.sendBlockReply(
      copyReplyPayloadMetadata(continuation, {
        text: "\n\nVisible\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nprivate\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      }),
    );
    await flow.dispatcher.waitForIdle();
    expect(flow.beforeDelivery.slice(-3).map((payload) => payload.text)).toEqual([
      "Unmarked",
      "Visible error",
      "\n\nVisible",
    ]);
  });

  it.each(["final", "tool"] as const)(
    "renormalizes a prepared continuation reused as a %s reply",
    async (kind) => {
      const flow = createParagraphDispatch();
      await flow.handler({ text: "First" });
      await flow.handler({ text: "\n\nSecond" });
      await flow.flush();
      const continuation = expectDefined(flow.sourcePayloads[1], "source continuation block");
      const payload = copyReplyPayloadMetadata(continuation, {
        text: "\n\nCompleted answer",
      });
      const prepared = flow.dispatcher.prepareReplyPayload?.("block", payload);
      expect(prepared?.kind).toBe("deliver");
      if (prepared?.kind !== "deliver") {
        throw new Error("Expected a prepared block reply");
      }
      expect(prepared.payload.text).toBe("\n\nCompleted answer");
      if (kind === "final") {
        flow.dispatcher.sendFinalReply(prepared.payload);
      } else {
        flow.dispatcher.sendToolResult(prepared.payload);
      }
      await flow.dispatcher.waitForIdle();
      expect(flow.beforeDelivery.at(-1)?.text).toBe("Completed answer");
    },
  );
});
