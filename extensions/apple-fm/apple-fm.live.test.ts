import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolCall } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createAppleFmNative } from "./native.js";

const live =
  process.env.OPENCLAW_LIVE_TEST === "1" &&
  process.platform === "darwin" &&
  process.arch === "arm64";

it.runIf(live)(
  "generates literal tool arguments natively and resumes the exact tool result",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "apple-fm-live-"));
    const native = createAppleFmNative(fileURLToPath(new URL(".", import.meta.url)));
    const options = { env: { ...process.env, OPENCLAW_STATE_DIR: directory } };
    const tool = {
      name: "setup",
      description: "Open the requested channel setup form.",
      parameters: Type.Object({
        action: Type.Literal("connect_channel"),
        channel: Type.Literal("telegram"),
        sha256: Type.Optional(Type.String({ pattern: "^[a-fA-F0-9]{64}$" })),
      }),
    };
    const user = { role: "user", content: "Use the setup tool to connect Telegram." };
    try {
      const detected = await native.probe(options);
      expect(detected?.available).toBe(true);
      expect(detected?.contextWindow).toBeGreaterThanOrEqual(8192);
      expect(await fs.readdir(directory)).toEqual([]);
      await expect(native.run({ messages: [user] }, options)).rejects.toThrow("setup again");
      const facts = await native.prepare(options);
      expect(facts.available).toBe(true);
      expect(facts.contextWindow).toBeGreaterThanOrEqual(8192);
      const request = {
        systemPrompt:
          "Call setup to connect a channel. Only report a completed setup when the tool result confirms it.",
        messages: [user],
        tools: [tool],
        maxTokens: 256,
        temperature: 0,
      };
      const first = await native.run(request, options);
      expect(first.toolCalls).toHaveLength(1);
      const call = first.toolCalls[0];
      if (!call) {
        throw new Error("Native model did not call the setup tool");
      }
      expect(call).toMatchObject({
        name: "setup",
        arguments: { action: "connect_channel", channel: "telegram" },
      });
      expect(validateToolCall([tool], { type: "toolCall", ...call })).toEqual(call.arguments);
      expect(() =>
        validateToolCall([tool], {
          type: "toolCall",
          ...call,
          arguments: { ...call.arguments, sha256: "invalid" },
        }),
      ).toThrow();
      const second = await native.run(
        {
          ...request,
          messages: [
            user,
            { role: "assistant", content: [{ type: "toolCall", ...call }] },
            {
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              isError: false,
              content: [
                {
                  type: "text",
                  text: "The Telegram setup form is ready. Ask the user to continue in that form. No configuration has been changed.",
                },
              ],
            },
          ],
        },
        options,
      );
      expect(second.toolCalls).toEqual([]);
      expect(second.text.toLowerCase()).toContain("form");
      expect(second.inputTokens).toBeGreaterThan(first.inputTokens);
      const structured = await native.run(
        {
          messages: [{ role: "user", content: "Report the status ready." }],
          maxTokens: 64,
          responseFormat: Type.Object({ status: Type.Literal("ready") }),
        },
        options,
      );
      expect(JSON.parse(structured.text)).toEqual({ status: "ready" });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
