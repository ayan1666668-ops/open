// Transport-specific completion-allowance boundaries for single-pass planning.
//
// Split out of compaction-planning-single-pass.test-support.ts to keep that file
// under its counted-line cap. Imported by
// compaction.identifier-preservation.test.ts, which owns this test root.
import { describe, expect, it } from "vitest";
import {
  MANAGED_ANTHROPIC_TRANSPORT_API,
  resolveSummarizationCompletionAllowance,
} from "../../packages/agent-core/src/harness/compaction/summarization-budget.js";

describe("sub-minimum thinking budget follows the executing transport", () => {
  // Below Anthropic's 1024-token thinking minimum every transport disables
  // thinking, but they disagree on the surviving output cap: Anthropic-direct
  // restores the visible-output cap, while the managed alias and Bedrock keep
  // the thinking-inflated `adjusted.maxTokens`. Budgeting the direct contract
  // everywhere understates what those two actually send, letting a request pass
  // the fit check without the output headroom the provider really uses.
  const reserveTokens = 1_000;
  const modelMaxTokens = 1_536;
  const maxTokens = Math.floor(0.8 * reserveTokens);

  function modelWith(overrides: Record<string, unknown>) {
    return {
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      api: "anthropic-messages",
      provider: "anthropic",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: modelMaxTokens,
      ...overrides,
    } as Parameters<typeof resolveSummarizationCompletionAllowance>[0]["model"];
  }

  it("keeps the direct visible-output cap for Anthropic-direct", () => {
    expect(
      resolveSummarizationCompletionAllowance({
        model: modelWith({}),
        maxTokens,
        thinkingLevel: "low",
      }),
    ).toBe(maxTokens);
  });

  it("matches the inflated cap the managed alias transport actually sends", () => {
    expect(
      resolveSummarizationCompletionAllowance({
        model: modelWith({ api: MANAGED_ANTHROPIC_TRANSPORT_API }),
        maxTokens,
        thinkingLevel: "low",
      }),
    ).toBe(modelMaxTokens);
  });

  it("matches the inflated cap Bedrock actually sends", () => {
    expect(
      resolveSummarizationCompletionAllowance({
        model: modelWith({
          id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
          // Bedrock's api discriminator is the converse-stream transport;
          // "amazon-bedrock" is the provider, which isClaudeBedrockModel
          // deliberately does not key on.
          api: "bedrock-converse-stream",
          provider: "amazon-bedrock",
        }),
        maxTokens,
        thinkingLevel: "low",
      }),
    ).toBe(modelMaxTokens);
  });
});
