/**
 * Drives the Anthropic Messages transport over real HTTP against a loopback SSE server,
 * without mocking fetch, to observe terminal tool-argument repair and rejection through
 * the actual transport client.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { configureAiTransportHost } from "../host.js";
import { streamAnthropic } from "../providers/anthropic.js";
import type { Model } from "../types.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";

type StreamFn = ReturnType<typeof createAnthropicMessagesTransportStreamFn>;
type StreamContext = Parameters<StreamFn>[1];
type StreamOptions = NonNullable<Parameters<StreamFn>[2]>;

function makeModel(baseUrl: string): Model<"anthropic-messages"> {
  return {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4_096,
  };
}

function serializeSse(events: Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function toolUseStream(toolBlocks: Array<{ id: string; name: string; partialJson: string }>) {
  const events: Record<string, unknown>[] = [
    {
      type: "message_start",
      message: {
        id: "msg_loopback",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 4, output_tokens: 0 },
      },
    },
  ];
  toolBlocks.forEach((block, index) => {
    events.push(
      {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      },
      {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: block.partialJson },
      },
      { type: "content_block_stop", index },
    );
  });
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 8 },
    },
    { type: "message_stop" },
  );
  return serializeSse(events);
}

async function startSseServer(
  body: string,
  modelId = "claude-opus-5",
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    let payload = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      payload += chunk;
    });
    request.on("end", () => {
      // Assert the request really reached us over HTTP with the tool projection attached.
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/messages");
      expect(JSON.parse(payload)).toMatchObject({ model: modelId, stream: true });
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function runTransport(baseUrl: string) {
  const streamFn = createAnthropicMessagesTransportStreamFn();
  const stream = await Promise.resolve(
    streamFn(
      makeModel(baseUrl),
      {
        messages: [{ role: "user", content: "edit the file", timestamp: 1 }],
        tools: [
          {
            name: "edit",
            description: "Edit a file",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as unknown as StreamContext,
      { apiKey: "sk-ant-api03-loopback" } as StreamOptions, // pragma: allowlist secret
    ),
  );
  return collectStream(stream);
}

async function collectStream(stream: Awaited<ReturnType<StreamFn>>) {
  const eventTypes: string[] = [];
  const toolCallEnds: Record<string, unknown>[] = [];
  for await (const event of stream) {
    eventTypes.push(event.type);
    if (event.type === "toolcall_end") {
      toolCallEnds.push(event.toolCall.arguments);
    }
  }
  const result = await stream.result();
  return { eventTypes, toolCallEnds, result };
}

describe("anthropic transport terminal tool-argument repair over loopback HTTP", () => {
  let server: Server | undefined;

  afterEach(async () => {
    configureAiTransportHost({});
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
      server = undefined;
    }
  });

  it("repairs a raw newline in one call and preserves a valid escape in its sibling", async () => {
    // Real network client: the host fetch is the platform fetch, not a stub.
    configureAiTransportHost({ buildModelFetch: () => globalThis.fetch });
    const started = await startSseServer(
      toolUseStream([
        { id: "call_read", name: "read", partialJson: '{"path":"README.md"}' },
        {
          id: "call_edit",
          name: "edit",
          // oldText carries a valid \n escape after a "C:" prefix; newText carries a raw newline.
          partialJson: '{"path":"a.py","oldText":"C:\\nnext","newText":"x = 1\ny = 2"}',
        },
      ]),
    );
    server = started.server;

    const { eventTypes, toolCallEnds, result } = await runTransport(started.baseUrl);

    expect(result.stopReason).toBe("toolUse");
    expect(result.errorMessage).toBeUndefined();
    expect(eventTypes.filter((type) => type === "toolcall_end")).toHaveLength(2);
    expect(eventTypes.at(-1)).toBe("done");
    expect(toolCallEnds).toEqual([
      { path: "README.md" },
      { path: "a.py", oldText: "C:\nnext", newText: "x = 1\ny = 2" },
    ]);
  });

  it("still fails closed on a truncated sibling and surfaces bounded diagnostics", async () => {
    configureAiTransportHost({ buildModelFetch: () => globalThis.fetch });
    const truncated = '{"path":"SECRET.md"';
    const started = await startSseServer(
      toolUseStream([
        { id: "call_read", name: "read", partialJson: '{"path":"README.md"}' },
        { id: "call_truncated", name: "read", partialJson: truncated },
      ]),
    );
    server = started.server;

    const { eventTypes, toolCallEnds, result } = await runTransport(started.baseUrl);

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Provider completed tool call with malformed JSON arguments");
    expect(result.errorCode).toBe("malformed_tool_call_arguments");
    expect(JSON.parse(result.errorBody ?? "{}")).toMatchObject({
      code: "malformed_tool_call_arguments",
      argumentChars: truncated.length,
      repairAttempted: true,
    });
    expect(`${result.errorMessage}${result.errorBody}`).not.toContain("SECRET.md");
    expect(toolCallEnds).toEqual([]);
    expect(eventTypes).not.toContain("toolcall_end");
    expect(eventTypes).not.toContain("done");
  });

  describe.each([
    { entry: "transport", streamFn: createAnthropicMessagesTransportStreamFn() },
    { entry: "provider", streamFn: streamAnthropic },
  ])("$entry compatible-provider terminal handling", ({ streamFn }) => {
    const textEvents = [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "The result is" },
      },
    ];
    const blockStop = { type: "content_block_stop", index: 0 };

    it.each([
      { scenario: "EOF after message_start", events: [], expected: "error" },
      { scenario: "EOF during text", events: textEvents, expected: "error" },
      {
        scenario: "EOF after a text block",
        events: [...textEvents, blockStop],
        expected: "error",
      },
      {
        scenario: "EOF after a complete tool block",
        events: [
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "call_edit", name: "edit", input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"path":"a.py"}' },
          },
          blockStop,
        ],
        expected: "error",
      },
      {
        scenario: "explicit end_turn without message_stop",
        events: [
          ...textEvents,
          blockStop,
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 3 },
          },
        ],
        expected: "stop",
      },
    ])("$scenario", async ({ events, expected }) => {
      configureAiTransportHost({ buildModelFetch: () => globalThis.fetch });
      const started = await startSseServer(
        serializeSse([
          {
            type: "message_start",
            message: {
              id: "msg_compatible",
              type: "message",
              role: "assistant",
              model: "kimi-for-coding",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 4, output_tokens: 0 },
            },
          },
          ...events,
        ]),
        "kimi-for-coding",
      );
      server = started.server;
      const model = {
        ...makeModel(started.baseUrl),
        provider: "kimi",
        id: "kimi-for-coding",
        name: "Kimi for Coding",
      };
      const { eventTypes, toolCallEnds, result } = await collectStream(
        await streamFn(
          model,
          { messages: [{ role: "user", content: "finish the task", timestamp: 1 }] },
          { apiKey: "local-fixture-key" },
        ),
      );

      expect(result.stopReason).toBe(expected);
      expect(toolCallEnds).toEqual([]);
      if (expected === "error") {
        expect(eventTypes.at(-1)).toBe("error");
        expect(eventTypes).not.toContain("done");
        expect(result.errorMessage).toMatch(/stream ended before/i);
        expect(result.content.some((block) => block.type === "toolCall")).toBe(false);
      } else {
        expect(eventTypes.at(-1)).toBe("done");
        expect(result.errorMessage).toBeUndefined();
        expect(result.content).toEqual([{ type: "text", text: "The result is" }]);
      }
    });
  });
});
