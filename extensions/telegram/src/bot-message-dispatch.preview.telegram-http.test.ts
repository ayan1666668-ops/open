import fs from "node:fs/promises";
import path from "node:path";
import { runAgentLoop } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistant,
  createAssistantOutput,
  createSubscribedSessionHarness,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { collectReplyMediaEntries } from "openclaw/plugin-sdk/channel-outbound";
import type { PluginHookReplyPayloadSendingEvent } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { AssistantMessageEventStream, type Message, type Model } from "openclaw/plugin-sdk/llm";
import {
  addTestHook,
  createEmptyPluginRegistry,
  initializeGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { consumeGoogleGenerateContentStream } from "openclaw/plugin-sdk/provider-transport-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  buildReplyPayloads,
  createBlockReplyDeliveryHandler,
  createReplyToModeFilterForChannel,
  createTypingController,
  createTypingSignaler,
  setReplyPayloadMetadata,
} from "openclaw/plugin-sdk/reply-payload-testing";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import { createTelegramDispatchHttpFixture } from "./bot-message-dispatch.telegram-http.test-support.js";
import { resolveTelegramTestUpload } from "./send.telegram-http.test-support.js";

const model: Model<"google-generative-ai"> = {
  id: "gemini-2.5-flash",
  name: "Gemini 2.5 Flash",
  api: "google-generative-ai",
  provider: "google",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

const recoveryPrefix = "The complete answer preserves this sufficiently long opening paragraph";
const recoveredAnswer =
  recoveryPrefix + " and continues with all the source-backed details required for this answer.";

describe("Telegram preview and presentation delivery through HTTP", () => {
  const http = createTelegramDispatchHttpFixture();
  const {
    calls,
    visibleMessages,
    visibleMarkup,
    acceptedCalls,
    emitToolStart,
    dispatchProgressTurn,
    waitForBotApiCall,
  } = http;

  async function transcriptCase(sessionId: string) {
    const context = http.createContext();
    const scope = {
      agentId: context.route.agentId,
      sessionId,
      sessionKey: context.route.sessionKey,
      storePath: http.state.path("sessions.json"),
    };
    const workspace = http.state.workspaceDir;
    const entry = { sessionId, updatedAt: Date.now() };
    await patchSessionEntry({ ...scope, fallbackEntry: entry, update: () => entry });
    const manager = SessionManager.open(scope, workspace);
    manager.appendMessage({
      role: "user",
      content: "Answer with the requested files.",
      timestamp: Date.now(),
    });
    const cfg = {
      agents: {
        defaults: { sandbox: { mode: "off" as const } },
        entries: { default: { workspace } },
      },
    };
    return { context, scope, workspace, manager, cfg };
  }
  it.each([
    { hook: "reply_payload_sending", mode: "partial" },
    { hook: "message_sending", mode: "progress" },
    { hook: "message_sending", mode: "off" },
    { hook: "none", mode: "partial" },
    { hook: "message_sent", mode: "partial" },
    { hook: "message_sent", mode: "off" },
  ] as const)("gates real preview writes with $hook in $mode mode", async ({ hook, mode }) => {
    const registry = createEmptyPluginRegistry();
    const modifierEntered = createDeferred<void>();
    const releaseModifier = createDeferred<void>();
    if (hook === "reply_payload_sending") {
      addTestHook({
        registry,
        pluginId: "http-preview-policy",
        hookName: hook,
        handler: async (event: PluginHookReplyPayloadSendingEvent) => {
          modifierEntered.resolve();
          await releaseModifier.promise;
          return { payload: { ...event.payload, text: "Allowed final" } };
        },
      });
    } else if (hook === "message_sending") {
      addTestHook({
        registry,
        pluginId: "http-preview-policy",
        hookName: hook,
        handler: async () => {
          modifierEntered.resolve();
          await releaseModifier.promise;
          return { content: "Allowed final" };
        },
      });
    } else if (hook === "message_sent") {
      addTestHook({
        registry,
        pluginId: "http-observer",
        hookName: hook,
        handler: () => undefined,
      });
    }
    initializeGlobalHookRunner(registry);
    const modifying = hook === "reply_payload_sending" || hook === "message_sending";
    const dispatched = dispatchProgressTurn(
      async (options) => {
        await options?.onPartialReply?.({
          text: "Pre-hook answer containing fixture-secret-answer",
        });
        if (!modifying && mode === "partial") {
          await waitForBotApiCall((call) =>
            String(call.fields.text).includes("fixture-secret-answer"),
          );
        }
        await emitToolStart(options, {
          name: "exec",
          phase: "start",
          toolCallId: "private-tool",
          args: { command: "echo fixture-secret-command" },
        });
        await options?.onReasoningStream?.({
          text: "<think>Independent reasoning containing fixture-secret-reasoning</think>",
        });
        if (!modifying) {
          await waitForBotApiCall((call) =>
            String(call.fields.text).includes("fixture-secret-reasoning"),
          );
        }
      },
      {
        mode,
        toolProgress: true,
        cfg: { agents: { defaults: { reasoningDefault: "stream" } } },
        finalReply: { text: "Pre-hook final containing fixture-secret-final" },
      },
    );
    if (modifying) {
      try {
        await Promise.race([
          modifierEntered.promise,
          dispatched.then(() => {
            throw new Error("dispatch completed without entering the modifying hook");
          }),
        ]);
        expect(calls.filter((call) => call.method !== "sendChatAction")).toEqual([]);
      } finally {
        releaseModifier.resolve();
        await dispatched;
      }
    } else {
      await dispatched;
    }
    const writes = JSON.stringify(calls);
    if (modifying) {
      expect(writes).not.toContain("fixture-secret");
      expect([...visibleMessages.values()]).toEqual(["Allowed final"]);
    } else {
      expect(writes).toContain("fixture-secret-reasoning");
      expect([...visibleMessages.values()]).toContain(
        "Pre-hook final containing fixture-secret-final",
      );
    }
  });

  it.each(["partial", "block"] as const)(
    "paginates actual %s finals without losing text or replacing the accepted preview",
    async (mode) => {
      const finalText =
        mode === "block"
          ? "A".repeat(600) + "B".repeat(600) + "C".repeat(600)
          : "A".repeat(4096) + "B".repeat(500);
      let preview: Array<[number, string]> = [];
      await dispatchProgressTurn(
        async (options) => {
          await options?.onPartialReply?.({ text: finalText });
          await waitForBotApiCall((call) => call.method === "sendMessage");
          preview = [...visibleMessages];
        },
        {
          mode,
          toolProgress: false,
          cfg: { agents: { defaults: { blockStreamingDefault: "on" } } },
          telegramCfg: {
            streaming: {
              mode,
              preview: { toolProgress: false, chunk: { minChars: 100, maxChars: 600 } },
            },
          },
          finalReply: { text: finalText },
        },
      );
      const pages = [...visibleMessages];
      expect(preview).toHaveLength(1);
      expect(pages[0]?.[0]).toBe(preview[0]?.[0]);
      expect(pages.map(([, text]) => text).join("")).toBe(finalText);
      for (const [, text] of pages) {
        expect(text.length).toBeLessThanOrEqual(mode === "block" ? 600 : 4096);
      }
      if (mode === "block") {
        expect(pages.map(([, text]) => text)).toEqual([
          "A".repeat(600),
          "B".repeat(600),
          "C".repeat(600),
        ]);
      }
    },
  );

  it("keeps sending typing before Telegram expiry beyond the default pipeline cutoff", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const acceptedTypingAt: number[] = [];
    http.respondToCall = (call) => {
      if (call.method === "sendChatAction" && call.fields.action === "typing") {
        acceptedTypingAt.push(Date.now());
      }
      return undefined;
    };
    await dispatchProgressTurn(
      async () => {
        await waitForBotApiCall((call) => call.method === "sendChatAction");
        await http.waitForTypingSend();
        await vi.advanceTimersByTimeAsync(0);
        for (let interval = 0; interval < 17; interval += 1) {
          const previousCount = acceptedTypingAt.length;
          await vi.advanceTimersByTimeAsync(4_000);
          await expect.poll(() => acceptedTypingAt.length).toBeGreaterThan(previousCount);
          await http.waitForTypingSend();
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(acceptedTypingAt.at(-1)! - acceptedTypingAt[0]!).toBeGreaterThan(60_000);
        for (let index = 1; index < acceptedTypingAt.length; index += 1) {
          expect(acceptedTypingAt[index]! - acceptedTypingAt[index - 1]!).toBeLessThan(5_000);
        }
        // SQLite workers use wall time, not this test's simulated typing clock.
        vi.setSystemTime(vi.getRealSystemTime());
      },
      { mode: "off", toolProgress: false, finalReply: { text: "Long-running work complete." } },
    );
    const settledTypingCount = acceptedTypingAt.length;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(acceptedTypingAt).toHaveLength(settledTypingCount);
  });

  it.each(["control-only", "immediate", "buffered"] as const)(
    "delivers presentation controls through the %s crossing",
    async (branch) => {
      const controls: ReplyPayload = {
        presentation: {
          blocks: [
            ...(branch === "control-only"
              ? []
              : [
                  {
                    type: "chart" as const,
                    chartType: "pie" as const,
                    title: "Revenue mix",
                    segments: [
                      { label: "Product", value: 60 },
                      { label: "Services", value: 40 },
                    ],
                  },
                  {
                    type: "table" as const,
                    caption: "Pipeline",
                    headers: ["Account", "Stage"],
                    rows: [["Acme", "Won"]],
                  },
                ]),
            {
              type: "buttons",
              buttons: [
                { label: "Retry", value: "retry" },
                { label: "Launch", action: { type: "web-app", url: "https://example.com/app" } },
                { label: "Copy manually", value: "x".repeat(65) },
              ],
            },
          ],
        },
      };
      if (branch === "buffered") {
        http.respondToCall = (call) =>
          String(call.fields.text).includes("first reasoning attempt")
            ? { error_code: 400, description: "Bad Request: reasoning rejected" }
            : undefined;
      }
      await dispatchProgressTurn(
        async (options) => {
          if (branch === "immediate") {
            await options?.onPartialReply?.({
              text: "The presentation is ready for review and interactive selection.",
            });
            await waitForBotApiCall((call) => call.method === "sendMessage");
            await options?.onBlockReply?.(controls);
            await waitForBotApiCall(
              (call) => call.method === "editMessageText" && call.fields.reply_markup !== undefined,
            );
            expect(visibleMarkup.get(1)).toMatchObject({
              inline_keyboard: expect.arrayContaining([
                expect.arrayContaining([{ text: "Retry", callback_data: "retry" }]),
              ]),
            });
          } else if (branch === "buffered") {
            await options?.onBlockReply?.({
              text: "<think>first reasoning attempt</think>",
              isReasoning: true,
            });
            await waitForBotApiCall((call) =>
              String(call.fields.text).includes("first reasoning attempt"),
            );
          }
        },
        {
          mode: branch === "control-only" ? "off" : "partial",
          toolProgress: false,
          cfg: {
            agents: { defaults: { reasoningDefault: branch === "buffered" ? "stream" : "off" } },
          },
          finalReply:
            branch === "buffered"
              ? [
                  controls,
                  { text: "<think>accepted second reasoning attempt</think>", isReasoning: true },
                ]
              : controls,
          allowErrors: branch === "buffered",
        },
      );
      const answer = [...visibleMessages].find(([id]) => visibleMarkup.has(id));
      expect(answer).toBeDefined();
      expect(answer?.[1]).toContain("Copy manually");
      expect(JSON.stringify(visibleMarkup.get(answer![0]))).toContain('"callback_data":"retry"');
      expect(JSON.stringify(visibleMarkup.get(answer![0]))).toContain(
        '"web_app":{"url":"https://example.com/app"}',
      );
      expect(JSON.stringify(visibleMarkup.get(answer![0]))).not.toContain("x".repeat(65));
      if (branch !== "control-only") {
        expect(answer?.[1]).toContain("Revenue mix");
        expect(answer?.[1]).toContain("Product");
        expect(answer?.[1]).toContain("Acme");
        expect(answer?.[1]).toContain("Won");
      }
      if (branch === "buffered") {
        const sends = acceptedCalls.filter((call) => call.method === "sendMessage");
        expect(String(sends[0]?.fields.text)).toContain("accepted second reasoning attempt");
        expect(String(sends.at(-1)?.fields.text)).toContain("Revenue mix");
      } else if (branch === "immediate") {
        expect([...visibleMessages.keys()]).toEqual([1]);
      }
    },
  );

  it("retires unaccepted pre-tool text across a tool-only assistant message", async () => {
    const preamble = "I will inspect the files before answering.";
    const finalText = "The requested result.";
    await dispatchProgressTurn(
      async (options) => {
        await options?.onPartialReply?.({ text: preamble, delta: preamble });
        await waitForBotApiCall(
          (call) => call.method === "sendMessage" && call.fields.text === preamble,
        );
        await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "first" });
        await waitForBotApiCall(
          (call) => call.method === "sendMessage" && String(call.fields.text).includes("🛠️ Exec"),
        );
        // An unphased provider can continue with a tool-only assistant message.
        // Its start clears progress suppression without replacing the old preview.
        await options?.onAssistantMessageStart?.();
        await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "second" });
        await options?.onAssistantMessageStart?.();
      },
      { mode: "partial", toolProgress: true, finalReply: { text: finalText } },
    );

    // Retired previews keep their existing four-second minimum display time.
    await expect.poll(() => [...visibleMessages.values()], { timeout: 5_000 }).toEqual([finalText]);
  });

  it.each([false, true])(
    "does not prefix a terminal error with pre-tool text (tool progress: %s)",
    async (toolProgress) => {
      const preamble = "I will inspect the files before answering.";
      const finalText = "The provider failed. Please try again.";
      await dispatchProgressTurn(
        async (options) => {
          await options?.onPartialReply?.({ text: preamble, delta: preamble });
          await waitForBotApiCall(
            (call) => call.method === "sendMessage" && call.fields.text === preamble,
          );
          await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "first" });
        },
        { mode: "partial", toolProgress, finalReply: { text: finalText, isError: true } },
      );

      await expect
        .poll(() => [...visibleMessages.values()], { timeout: 5_000 })
        .toEqual([finalText]);
    },
  );

  it("retires a lazy partial queued immediately before a quiet tool start", async () => {
    const preamble = "I will inspect the files before answering.";
    const finalText = "The provider failed. Please try again.";
    await dispatchProgressTurn(
      async (options) => {
        // Core preserves callback start order, not completion order. The partial
        // is still queued when the tool callback starts and must retire first.
        const partial = options?.onPartialReply?.({ text: preamble, delta: preamble });
        const tool = emitToolStart(options, { name: "exec", phase: "start", toolCallId: "first" });
        await Promise.all([partial, tool]);
      },
      { mode: "partial", toolProgress: false, finalReply: { text: finalText, isError: true } },
    );
    await expect.poll(() => [...visibleMessages.values()], { timeout: 5_000 }).toEqual([finalText]);
  });

  it("preserves an interrupted answer when an existing tool only updates", async () => {
    const answer = "The first result is ready, and the remaining work is still running.";
    const failure = "The provider failed. Please try again.";
    await dispatchProgressTurn(
      async (options) => {
        await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "first" });
        await options?.onAssistantMessageStart?.();
        await options?.onPartialReply?.({ text: answer, delta: answer });
        await waitForBotApiCall(
          (call) => call.method === "sendMessage" && call.fields.text === answer,
        );
        await emitToolStart(options, { name: "exec", phase: "update", toolCallId: "first" });
      },
      { mode: "partial", toolProgress: false, finalReply: { text: failure, isError: true } },
    );
    expect([...visibleMessages.values()]).toEqual([`${answer}\n\n${failure}`]);
  });
  it.each(["partial", "progress"] as const)(
    "keeps an accepted answer when another final follows in %s mode",
    async (mode) => {
      const answer = "A complete answer that is long enough to preview.";
      let previewId: number | undefined;
      await dispatchProgressTurn(
        async (options) => {
          await options?.onPartialReply?.({ text: answer });
          if (mode === "partial") {
            await waitForBotApiCall(
              (call) => call.method === "sendMessage" && call.fields.text === answer,
            );
            previewId = [...visibleMessages.keys()][0];
          }
        },
        {
          mode,
          toolProgress: false,
          finalReply: [{ text: answer }, { text: "A separate final status." }],
        },
      );
      expect([...visibleMessages.values()]).toEqual([answer, "A separate final status."]);
      if (mode === "partial") {
        expect([...visibleMessages.keys()][0]).toBe(previewId);
      }
    },
  );

  it.each(["partial", "progress"] as const)(
    "materializes a block-only terminal answer in %s mode",
    async (mode) => {
      await dispatchProgressTurn(
        async (options) => {
          await options?.onBlockReply?.({ text: "Block-only terminal answer." });
        },
        { mode, toolProgress: false, finalReply: [] },
      );
      expect([...visibleMessages.values()]).toEqual(["Block-only terminal answer."]);
    },
  );

  it.each([false, true])(
    "settles one terminal error after a model failure (accepted preview: %s)",
    async (accepted) => {
      const partial = accepted ? "An accepted partial answer before the model failed." : "partial";
      let reachedModel = false;
      await dispatchProgressTurn(
        async (options) => {
          reachedModel = true;
          await options?.onPartialReply?.({ text: partial });
          if (accepted) {
            await waitForBotApiCall(
              (call) => call.method === "sendMessage" && call.fields.text === partial,
            );
          }
          options?.onAgentRunTerminalOutcome?.("failed");
          throw new Error("private-provider-failure");
        },
        { mode: "partial", toolProgress: false, allowErrors: true },
      );
      expect(reachedModel).toBe(true);
      const visible = [...visibleMessages.values()];
      expect(visible).toHaveLength(1);
      expect(visible[0]).toContain("Please try again");
      if (accepted) {
        expect(visible[0]).toContain(partial);
      } else {
        expect(visible[0]).not.toContain(partial);
      }
      expect(JSON.stringify(calls)).not.toContain("private-provider-failure");
    },
  );

  it.each([
    { mode: "first", directive: "[[reply_to:42]]", targets: [42, null, null] },
    { mode: "all", directive: "[[reply_to_current]]", targets: ["current", "current", "current"] },
    { mode: "batched", directive: "", targets: [null, null, null] },
  ] as const)(
    "consumes cumulative provider reply intent in $mode mode",
    async ({ mode, directive, targets }) => {
      const paragraphs = [
        "First paragraph provides enough content to emit separately.",
        "Second paragraph continues without another authored reply directive.",
        "Third paragraph finishes the answer without a reply directive.",
      ];
      const context = http.createContext();
      await dispatchProgressTurn(
        async (options) => {
          const typing = createTypingController({});
          const handler = createBlockReplyDeliveryHandler({
            onBlockReply: (payload) => options?.onBlockReply?.(payload),
            currentMessageId: String(context.msg.message_id),
            replyThreading: { implicitCurrentMessage: "deny" },
            normalizeStreamingText: (payload) => ({
              text: payload.text,
              skip: !payload.text?.trim(),
            }),
            applyReplyToMode: createReplyToModeFilterForChannel(mode, "telegram"),
            typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
            blockStreamingEnabled: true,
            blockReplyPipeline: null,
            directBlockDeliveries: [],
          });
          const { emit, subscription } = createSubscribedSessionHarness({
            runId: "cumulative-http-reply",
            onBlockReply: handler,
            blockReplyBreak: "text_end",
            blockReplyChunking: { minChars: 1, maxChars: 150, breakPreference: "paragraph" },
          });
          const response = new AssistantMessageEventStream();
          async function* chunks() {
            for (const [index, text] of paragraphs.entries()) {
              yield {
                candidates: [
                  { content: { parts: [{ text: `${index === 0 ? directive : ""}${text}\n\n` }] } },
                ],
              };
            }
            yield { candidates: [{ finishReason: "STOP" }] };
          }
          const producing = consumeGoogleGenerateContentStream({
            chunks: chunks(),
            model,
            output: createAssistantOutput(model),
            stream: response,
            profile: "managed",
            nextToolCallId: () => "unused",
          });
          try {
            await runAgentLoop(
              [{ role: "user", content: "Return three paragraphs.", timestamp: 1 }],
              { systemPrompt: "", messages: [] },
              {
                model,
                convertToLlm: (messages) =>
                  messages.filter(
                    (message): message is Message =>
                      message.role === "user" ||
                      message.role === "assistant" ||
                      message.role === "toolResult",
                  ),
              },
              async (event) => {
                emit(event);
                await subscription.waitForPendingEvents();
              },
              undefined,
              () => response,
            );
            await producing;
          } finally {
            await producing;
            await subscription.waitForPendingEvents();
            subscription.unsubscribe();
            typing.markRunComplete();
          }
        },
        { context, mode: "off", toolProgress: false, replyToMode: mode, finalReply: [] },
      );
      const sends = acceptedCalls.filter((call) => call.method === "sendMessage");
      expect(sends.map((call) => call.fields.text)).toEqual(paragraphs);
      expect(
        sends.map(
          (call) =>
            (call.fields.reply_parameters as { message_id?: number } | undefined)?.message_id ??
            call.fields.reply_to_message_id ??
            null,
        ),
      ).toEqual(targets.map((target) => (target === "current" ? context.msg.message_id : target)));
    },
  );

  it.each(["first", "all"] as const)(
    "recovers the latest scoped answer without reopening an accepted %s target",
    async (replyToMode) => {
      const { context, manager } = await transcriptCase("latest-queued-answer");
      const first = "The first queued answer remains visible in the conversation.";
      const { replyPayloads } = await buildReplyPayloads({
        payloads: [
          { text: "[[reply_to_current]]" + first },
          { text: "[[reply_to_current]]" + recoveredAnswer },
        ],
        isHeartbeat: false,
        didLogHeartbeatStrip: false,
        blockStreamingEnabled: false,
        blockReplyPipeline: null,
        applyReplyToMode: createReplyToModeFilterForChannel(replyToMode, "telegram"),
        replyToMode,
        replyToChannel: "telegram",
        currentMessageId: String(context.msg.message_id),
      });
      const registry = createEmptyPluginRegistry();
      addTestHook({
        registry,
        pluginId: "shorten-latest-answer",
        hookName: "reply_payload_sending",
        handler: (event: PluginHookReplyPayloadSendingEvent) =>
          event.kind === "final" && event.payload.text === recoveredAnswer
            ? { payload: { ...event.payload, text: recoveryPrefix + "..." } }
            : undefined,
      });
      initializeGlobalHookRunner(registry);
      await dispatchProgressTurn(
        async () => {
          manager.appendMessage(
            createAssistant(model, [{ type: "text", text: "[[reply_to_current]]" + first }]),
          );
          manager.appendMessage({
            role: "user",
            content: "Now answer the queued follow-up.",
            timestamp: Date.now(),
          });
          manager.appendMessage(
            createAssistant(model, [
              { type: "text", text: "[[reply_to_current]]" + recoveredAnswer },
            ]),
          );
          manager.flushPendingPersistence();
        },
        {
          context,
          mode: "off",
          toolProgress: false,
          replyToMode,
          finalReply: replyPayloads,
        },
      );
      const sends = acceptedCalls.filter((call) => call.method === "sendMessage");
      expect(sends.map((call) => call.fields.text)).toEqual([first, recoveredAnswer]);
      expect(
        sends.map(
          (call) =>
            (call.fields.reply_parameters as { message_id?: number } | undefined)?.message_id ??
            call.fields.reply_to_message_id ??
            null,
        ),
      ).toEqual(
        replyToMode === "all"
          ? [context.msg.message_id, context.msg.message_id]
          : [context.msg.message_id, null],
      );
      expect(calls.filter((call) => call.method === "deleteMessage")).toEqual([]);
    },
  );

  it("rejects stale, other-session, and preceding-input transcript recovery", async () => {
    const { context, manager, scope, workspace } = await transcriptCase("stale-answer");
    manager.appendMessage({
      ...createAssistant(model, [{ type: "text", text: recoveredAnswer + "\n[[reply_to:42]]" }]),
      timestamp: Date.now() - 60_000,
    });
    manager.flushPendingPersistence();
    await dispatchProgressTurn(
      async () => {
        const otherScope = {
          ...scope,
          sessionId: "unrelated-answer",
          sessionKey: scope.sessionKey + ":other",
        };
        const entry = { sessionId: otherScope.sessionId, updatedAt: Date.now() };
        await patchSessionEntry({ ...otherScope, fallbackEntry: entry, update: () => entry });
        const other = SessionManager.open(otherScope, workspace);
        other.appendMessage({
          role: "user",
          content: "Different conversation.",
          timestamp: Date.now(),
        });
        other.appendMessage(
          createAssistant(model, [{ type: "text", text: recoveredAnswer + "\n[[reply_to:99]]" }]),
        );
        other.flushPendingPersistence();
      },
      { context, mode: "off", toolProgress: false, finalReply: { text: recoveryPrefix + "..." } },
    );
    const sends = acceptedCalls.filter((call) => call.method === "sendMessage");
    expect(sends.map((call) => call.fields.text)).toEqual([recoveryPrefix + "..."]);
    expect(sends[0]?.fields.reply_parameters).toBeUndefined();
    expect(sends[0]?.fields.reply_to_message_id).toBeUndefined();
    await dispatchProgressTurn(
      async () => {
        const current = SessionManager.open(scope, workspace);
        current.appendMessage(
          createAssistant(model, [{ type: "text", text: recoveredAnswer + "\n[[reply_to:42]]" }]),
        );
        current.flushPendingPersistence();
      },
      {
        mode: "off",
        toolProgress: false,
        finalReply: setReplyPayloadMetadata(
          { text: recoveryPrefix + "..." },
          { precedingInputAnswer: true },
        ),
      },
    );
    expect(
      acceptedCalls.filter((call) => call.method === "sendMessage").map((call) => call.fields.text),
    ).toEqual([recoveryPrefix + "...", recoveryPrefix + "..."]);
  });

  it.each(["accepted", "partial", "substitute"] as const)(
    "deduplicates only accepted source aliases after a %s block and recovered final",
    async (selection) => {
      const { context, workspace, manager, cfg } = await transcriptCase("accepted-media-aliases");
      const sources = ["A", "B", "C", "D"].map((name) => path.join(workspace, `${name}.txt`));
      await Promise.all(
        sources.map((source, index) =>
          fs.writeFile(source, `Document ${["A", "B", "C", "D"][index]}\n`),
        ),
      );
      const authored = sources.slice(0, selection === "accepted" ? 1 : 3);
      const registry = createEmptyPluginRegistry();
      addTestHook({
        registry,
        pluginId: "select-block-and-shorten-final",
        hookName: "reply_payload_sending",
        handler: (event: PluginHookReplyPayloadSendingEvent) => {
          if (event.kind === "block") {
            if (event.payload.text === recoveredAnswer) {
              return { cancel: true };
            }
            const media = collectReplyMediaEntries(event.payload);
            const selected =
              selection === "partial"
                ? [media[1]!, media[0]!]
                : selection === "accepted"
                  ? media
                  : [{ url: sources[3]!, attachment: { name: "D.txt" } }];
            return {
              payload: {
                ...event.payload,
                mediaUrl: undefined,
                mediaUrls: selected.map(({ url }) => url),
                attachments: selected.map(({ attachment }) => attachment ?? {}),
              },
            };
          }
          return {
            payload: {
              ...event.payload,
              text: recoveryPrefix + "...",
              replyToId: undefined,
              replyToCurrent: undefined,
              replyToTag: undefined,
            },
          };
        },
      });
      initializeGlobalHookRunner(registry);
      let documents = 0;
      http.respondToCall = (call) =>
        call.method === "sendDocument" && ++documents === 2 && selection === "partial"
          ? { error_code: 400, description: "Bad Request: DOCUMENT_INVALID" }
          : undefined;
      await dispatchProgressTurn(
        async (options) => {
          await options?.onBlockReply?.({ text: "Initial documents.", mediaUrls: authored });
          await waitForBotApiCall((call) => call.method === "sendDocument");
          await options?.onBlockReply?.({ text: recoveredAnswer, mediaUrls: authored });
          manager.appendMessage(
            createAssistant(model, [
              {
                type: "text",
                text:
                  recoveredAnswer +
                  authored.map((source) => "\nMEDIA:" + source).join("") +
                  "\n[[reply_to_current]]",
              },
            ]),
          );
          manager.flushPendingPersistence();
        },
        {
          context,
          cfg,
          mode: "off",
          toolProgress: false,
          allowErrors: selection === "partial",
          finalReply: {
            text: recoveredAnswer,
            mediaUrls: authored.slice(0, 2),
            mediaUrl: authored[2],
          },
        },
      );
      const uploads = acceptedCalls
        .filter((call) => call.method === "sendDocument")
        .map((call) => resolveTelegramTestUpload(call.fields, "document"));
      expect(await Promise.all(uploads.map((file) => file.text()))).toEqual(
        selection === "accepted"
          ? ["Document A\n"]
          : selection === "partial"
            ? ["Document B\n", "Document A\n", "Document C\n"]
            : ["Document D\n", "Document A\n", "Document B\n", "Document C\n"],
      );
      expect(uploads.map((file) => file.name)).toEqual(
        selection === "accepted"
          ? ["A.txt"]
          : selection === "partial"
            ? ["B.txt", "A.txt", "C.txt"]
            : ["D.txt", "A.txt", "B.txt", "C.txt"],
      );
      const final = acceptedCalls.filter(
        (call) => (call.fields.caption ?? call.fields.text) === recoveredAnswer,
      );
      expect(final).toHaveLength(1);
      expect(
        Number(
          (final[0]?.fields.reply_parameters as { message_id?: number } | undefined)?.message_id ??
            final[0]?.fields.reply_to_message_id,
        ),
      ).toBe(context.msg.message_id);
      expect([...visibleMessages.values()].filter(Boolean)).toEqual([
        "Initial documents.",
        recoveredAnswer,
      ]);
    },
  );

  it.each([
    { selection: "remove", expected: [] },
    { selection: "reorder", expected: ["Document C\n", "Document A\n"] },
    { selection: "replace-later", expected: ["Document D\n"] },
  ] as const)(
    "keeps $selection hook media selection when recovering transcript text",
    async ({ selection, expected }) => {
      const { context, workspace, manager, cfg } = await transcriptCase("selected-media-recovery");
      const sources = ["A", "B", "C", "D"].map((name) => path.join(workspace, `${name}.txt`));
      await Promise.all(
        sources.map((source, index) =>
          fs.writeFile(source, `Document ${["A", "B", "C", "D"][index]}\n`),
        ),
      );
      const registry = createEmptyPluginRegistry();
      addTestHook({
        registry,
        pluginId: "select-final-media",
        hookName: "reply_payload_sending",
        priority: 10,
        handler: (event: PluginHookReplyPayloadSendingEvent) => {
          const media = collectReplyMediaEntries(event.payload);
          const selected = selection === "remove" ? [] : [media[2]!, media[0]!];
          return {
            payload: {
              ...event.payload,
              text: recoveryPrefix + "...",
              mediaUrl: undefined,
              mediaUrls: selected.map(({ url }) => url),
              attachments: selected.map(({ attachment }) => attachment ?? {}),
            },
          };
        },
      });
      addTestHook({
        registry,
        pluginId: "replace-final-media",
        hookName: "reply_payload_sending",
        handler: (event: PluginHookReplyPayloadSendingEvent) =>
          selection === "replace-later"
            ? {
                payload: {
                  ...event.payload,
                  mediaUrl: undefined,
                  mediaUrls: [sources[3]!],
                  attachments: [{ name: "D.txt" }],
                },
              }
            : undefined,
      });
      initializeGlobalHookRunner(registry);
      await dispatchProgressTurn(
        async () => {
          manager.appendMessage(
            createAssistant(model, [
              {
                type: "text",
                text:
                  recoveredAnswer +
                  sources
                    .slice(0, 3)
                    .map((source) => "\nMEDIA:" + source)
                    .join("") +
                  "\n[[reply_to_current]]",
              },
            ]),
          );
          manager.flushPendingPersistence();
        },
        {
          context,
          cfg,
          mode: "off",
          toolProgress: false,
          finalReply: { text: recoveredAnswer, mediaUrls: sources.slice(0, 3) },
        },
      );
      const uploads = acceptedCalls.filter((call) => call.method === "sendDocument");
      expect(
        await Promise.all(
          uploads.map((call) => resolveTelegramTestUpload(call.fields, "document").text()),
        ),
      ).toEqual(expected);
      const messages = acceptedCalls.filter(
        (call) =>
          (call.method === "sendMessage" || call.method === "sendDocument") &&
          (call.fields.text || call.fields.caption),
      );
      expect(messages.map((call) => call.fields.text ?? call.fields.caption)).toEqual([
        recoveredAnswer,
      ]);
      expect(
        Number(
          (messages[0]?.fields.reply_parameters as { message_id?: number } | undefined)
            ?.message_id ?? messages[0]?.fields.reply_to_message_id,
        ),
      ).toBe(context.msg.message_id);
    },
  );

  it.each([false, true])(
    "keeps replay failure custody with a terminal provider failure=%s",
    async (terminalFailure) => {
      const context = http.createContext();
      const chat = { id: -1001234, type: "supergroup" as const, title: "Replay room" };
      context.chatId = chat.id;
      context.isGroup = true;
      context.msg.chat = chat;
      context.primaryCtx.message.chat = chat;
      context.route.sessionKey = "agent:default:telegram:group:-1001234";
      Object.assign(context.ctxPayload, {
        ChatType: "group",
        From: "telegram:group:-1001234",
        To: "telegram:-1001234",
        SessionKey: context.route.sessionKey,
        WasMentioned: true,
      });
      await dispatchProgressTurn(
        async (options) => {
          if (terminalFailure) {
            options?.onAgentRunTerminalOutcome?.("failed");
          }
          throw new Error("private-provider-http-500");
        },
        {
          context,
          mode: "off",
          toolProgress: false,
          cfg: { messages: { groupChat: { visibleReplies: "message_tool" } } },
          telegramCfg: { silentErrorReplies: true },
          suppressFailureFallback: true,
          allowErrors: true,
          outcome: terminalFailure ? "completed" : "failed-retryable",
        },
      );
      const replies = acceptedCalls.filter((call) => call.method === "sendMessage");
      expect(replies).toHaveLength(terminalFailure ? 1 : 0);
      if (terminalFailure) {
        expect(replies[0]?.fields.text).toContain("Please try again.");
        expect(replies[0]?.fields.disable_notification).toBe(true);
      }
      expect(JSON.stringify(calls)).not.toContain("private-provider-http-500");
    },
  );
});
