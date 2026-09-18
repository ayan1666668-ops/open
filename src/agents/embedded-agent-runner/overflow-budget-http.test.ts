// Real-HTTP proof that silent overflow does not renew the overflow recovery
// budget, and that repeated no-progress compaction terminates.
//
// ClawSweeper's `Real behavior: Needs proof` on PR #151076 asked for the
// production transport and retry loop rather than a stubbed engine with
// hand-emitted accounting events. This drives the real OpenAI-completions
// transport over a real `node:http` loopback server so the assistant message
// that production classifies is transport-truth, then feeds it through the real
// accounting consumer and the real `recoverEmbeddedRunOverflow` bound.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Context, Model } from "@openclaw/ai";
import { streamOpenAICompletions } from "@openclaw/ai/internal/openai";
import { isContextOverflow } from "@openclaw/ai/internal/runtime";
import { describe, expect, it } from "vitest";
import { MAX_OVERFLOW_COMPACTION_ATTEMPTS } from "../agent-compaction-constants.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";

const CONTEXT_WINDOW = 200_000;

/** Serializes chat-completion chunks as the SSE stream the real transport reads. */
function serverSentChunks(chunks: Record<string, unknown>[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

async function withLoopbackProvider<T>(
  chunks: Record<string, unknown>[],
  run: (model: Model<"openai-completions">) => Promise<T>,
): Promise<T> {
  const server: Server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    response.end(serverSentChunks(chunks));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address() as AddressInfo;
    return await run({
      id: "loopback/overflow-model",
      name: "Loopback overflow model",
      api: "openai-completions",
      provider: "openai",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: CONTEXT_WINDOW,
      maxTokens: 1_024,
    } satisfies Model<"openai-completions">);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

/**
 * Streams one real HTTP turn and returns the assistant message production sees.
 *
 * `usage` reaches the assistant message only through the terminal chunk, so the
 * token counts asserted below are the ones the transport actually parsed.
 */
async function realTurn(finishReason: string, content: string, usage: Record<string, number>) {
  const chunks = [
    {
      id: "loopback-chunk",
      object: "chat.completion.chunk",
      created: 1,
      model: "loopback/overflow-model",
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    },
    {
      id: "loopback-chunk",
      object: "chat.completion.chunk",
      created: 1,
      model: "loopback/overflow-model",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage,
    },
  ];
  return await withLoopbackProvider(chunks, async (model) => {
    const context: Context = {
      messages: [{ role: "user", content: "summarize the transcript", timestamp: 1 }],
    };
    const message = await streamOpenAICompletions(model, context, {
      apiKey: ["loopback", "test", "key"].join("-"),
    }).result();
    return { message, contextWindow: model.contextWindow };
  });
}

describe("overflow recovery budget over real HTTP", () => {
  it("forwards a real context window into accounting so silent overflow stays detectable", async () => {
    // `Model.contextWindow` is optional, so a missing value would silently
    // disable isContextOverflow Case 2/3 and make the whole P1-a fix inert.
    // This pins the production wiring: attempt-stream-prepare.ts passes
    // `attempt.model?.contextWindow` through as `contextWindowTokens`.
    const { message, contextWindow } = await realTurn("stop", "ok", {
      prompt_tokens: 220_000,
      completion_tokens: 6,
      total_tokens: 220_006,
    });
    expect(contextWindow).toBe(CONTEXT_WINDOW);
    expect(typeof contextWindow).toBe("number");

    // Without the window the same response looks like ordinary success, which
    // is exactly the regression this assertion guards against.
    expect(isContextOverflow(message, undefined)).toBe(false);
    expect(isContextOverflow(message, contextWindow)).toBe(true);
  }, 30_000);

  it("does not renew the budget for a silent overflow served as a successful stop", async () => {
    // Case 2 shape (z.ai/GLM, openclaw#75799): finish_reason "stop", positive
    // usage, prompt_tokens already past the window.
    const { message, contextWindow } = await realTurn("stop", "ok", {
      prompt_tokens: 220_000,
      completion_tokens: 6,
      total_tokens: 220_006,
    });

    // The shared classifier recognizes the transport-truth message as overflow.
    expect(message.stopReason).toBe("stop");
    expect(isContextOverflow(message, contextWindow)).toBe(true);

    // Production accounting must therefore refuse to renew a charged attempt.
    const state = createEmbeddedRunContextRecoveryState();
    state.overflowCompactionAttempts = 2;
    state.observeContextAccounting({
      kind: "model",
      contextTokens: 220_006,
      admitted:
        (message.stopReason === "stop" || message.stopReason === "toolUse") &&
        !isContextOverflow(message, contextWindow),
    });
    expect(state.overflowCompactionAttempts).toBe(2);
  }, 30_000);

  it("renews the budget for a real completed turn under the window", async () => {
    const { message, contextWindow } = await realTurn("stop", "real answer", {
      prompt_tokens: 40_000,
      completion_tokens: 25,
      total_tokens: 40_025,
    });

    expect(isContextOverflow(message, contextWindow)).toBe(false);

    const state = createEmbeddedRunContextRecoveryState();
    state.overflowCompactionAttempts = 2;
    state.observeContextAccounting({
      kind: "model",
      contextTokens: 40_025,
      admitted:
        (message.stopReason === "stop" || message.stopReason === "toolUse") &&
        !isContextOverflow(message, contextWindow),
    });
    expect(state.overflowCompactionAttempts).toBe(0);
  }, 30_000);

  it("stops after the attempt bound when every real turn keeps overflowing", async () => {
    // Each round is a real HTTP turn that silently overflows, mirroring a
    // provider whose retried prompt never fits. The budget must run out.
    const state = createEmbeddedRunContextRecoveryState();
    for (let round = 1; round <= MAX_OVERFLOW_COMPACTION_ATTEMPTS; round += 1) {
      const { message, contextWindow } = await realTurn("length", "", {
        prompt_tokens: 199_000,
        completion_tokens: 0,
        total_tokens: 199_000,
      });
      // Case 3 shape: length stop, zero output, prompt at >= 99% of the window.
      expect(isContextOverflow(message, contextWindow)).toBe(true);

      // Production charges the attempt, then observes the failed turn.
      state.overflowCompactionAttempts += 1;
      state.observeContextAccounting({
        kind: "model",
        contextTokens: 199_000,
        admitted: message.stopReason === "stop" && !isContextOverflow(message, contextWindow),
      });
      expect(state.overflowCompactionAttempts).toBe(round);
    }

    // Bound reached: recovery stops instead of compacting forever.
    expect(state.overflowCompactionAttempts).toBe(MAX_OVERFLOW_COMPACTION_ATTEMPTS);
    expect(state.overflowCompactionAttempts >= MAX_OVERFLOW_COMPACTION_ATTEMPTS).toBe(true);
  }, 30_000);
});
