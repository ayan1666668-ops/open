import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppleFmNative } from "./native.js";
import { createAppleFmStream } from "./stream.js";

const native = { run: vi.fn<AppleFmNative["run"]>() };
const model: Model<"openai-completions"> = {
  id: "system",
  name: "AFM 3 Core Advanced",
  provider: "apple-fm",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1",
  contextWindow: 8192,
  maxTokens: 1024,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context: Context = {
  systemPrompt: "Only propose actions through the supplied tool.",
  messages: [{ role: "user", content: "Connect Telegram.", timestamp: 0 }],
  tools: [
    {
      name: "openclaw",
      description: "Set up OpenClaw",
      parameters: Type.Object({
        action: Type.Literal("connect_channel"),
        channel: Type.String(),
        sha256: Type.Optional(Type.String({ pattern: "^[a-fA-F0-9]{64}$" })),
      }),
    },
  ],
};
const call = {
  id: "call-1",
  name: "openclaw",
  arguments: { action: "connect_channel", channel: "telegram" },
};

beforeEach(() => vi.clearAllMocks());

describe("Apple Foundation Models native transport", () => {
  it("returns a typed tool call with measured usage and preserves host validation schemas", async () => {
    native.run.mockResolvedValue({
      text: "",
      toolCalls: [call],
      inputTokens: 3995,
      outputTokens: 18,
    });
    const stream = await createAppleFmStream(native)(model, context, { maxTokens: 128 });
    const events = [];
    for await (const event of stream) {
      events.push(event.type);
    }
    const result = await stream.result();
    expect(result).toMatchObject({
      stopReason: "toolUse",
      content: [{ type: "toolCall", ...call }],
      usage: { input: 3995, output: 18, totalTokens: 4013 },
    });
    expect(events).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
    expect(native.run).toHaveBeenCalledWith(
      expect.objectContaining({ ...context, maxTokens: 128 }),
      expect.anything(),
    );
    expect(context.tools?.[0]?.parameters).toMatchObject({
      properties: { sha256: { pattern: "^[a-fA-F0-9]{64}$" } },
    });
  });

  it("replays the exact tool call identity and tool result for continuation", async () => {
    const continued: Context = {
      ...context,
      messages: [
        ...context.messages,
        {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: 1,
          content: [{ type: "toolCall", ...call }],
          stopReason: "toolUse",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
        {
          role: "toolResult",
          toolName: call.name,
          toolCallId: call.id,
          content: [{ type: "text", text: "The protected setup form is ready." }],
          isError: false,
          timestamp: 2,
        },
      ],
    };
    native.run.mockResolvedValue({
      text: "Continue in the setup form.",
      toolCalls: [],
      inputTokens: 4064,
      outputTokens: 8,
    });
    const stream = await createAppleFmStream(native)(model, continued, {
      responseFormat: { type: "object" },
    });
    expect(await stream.result()).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "Continue in the setup form." }],
    });
    expect(native.run).toHaveBeenCalledWith(
      expect.objectContaining({ messages: continued.messages, responseFormat: { type: "object" } }),
      expect.anything(),
    );
  });

  it("does not publish a tool call after cancellation during native inference", async () => {
    const abort = new AbortController();
    native.run.mockImplementation(async () => {
      abort.abort();
      return { text: "", toolCalls: [call], inputTokens: 10, outputTokens: 10 };
    });
    const stream = await createAppleFmStream(native)(model, context, { signal: abort.signal });
    expect(await stream.result()).toMatchObject({ stopReason: "aborted", content: [] });
  });

  it("reports native failures through the stream without falling through to HTTP", async () => {
    native.run.mockRejectedValue(new Error("Apple Intelligence is disabled."));
    const stream = await createAppleFmStream(native)(model, context);
    expect(await stream.result()).toMatchObject({
      stopReason: "error",
      content: [],
      errorMessage: expect.stringContaining("Apple Intelligence is disabled"),
    });
  });
});
