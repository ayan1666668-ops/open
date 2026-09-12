import { describe, expect, it } from "vitest";
import {
  resolveRequiredCompletionDeliveryFailureTerminalResult,
  resolveRequiredCompletionTerminalResult,
} from "./task-completion-contract.js";

describe("resolveRequiredCompletionTerminalResult", () => {
  it("blocks an empty required completion", () => {
    expect(resolveRequiredCompletionTerminalResult("")).toEqual({
      terminalOutcome: "blocked",
      terminalSummary: "Required completion did not produce a final deliverable.",
    });
  });

  // Genuine narration with no deliverable must stay classified as progress-only
  // so required completions still block on it. A result marker inside a
  // conditional clause ("whether the tests passed") is a pending outcome, not a
  // delivered result.
  it.each([
    ["pure progress", "Let me run the tests"],
    ["narration that promises a later report", "I'll analyze the logs and report back"],
    ["future-tense verification", "I'm going to verify the fix"],
    ["conditional on whether tests pass", "I'll check whether the tests pass before continuing"],
    ["future-only conditional result", "I'll investigate whether the tests passed"],
    ["bare conditional result", "Investigating whether the tests passed"],
    ["bare progress verb", "Investigating the gateway logs"],
  ])("blocks %s as progress-only", (_label, text) => {
    expect(resolveRequiredCompletionTerminalResult(text)).toEqual({
      terminalOutcome: "blocked",
      terminalSummary:
        "Required completion ended with progress-only text, not a final deliverable.",
    });
  });

  // A real final summary can open with progress narration but still carry a
  // result/report/verification marker in a delivered-result sentence; those
  // must not be misclassified.
  it.each([
    [
      "single-sentence narration that lands a result",
      "Investigating the gateway logs revealed the crash and I patched the handler, tests passed",
    ],
    [
      "narration followed by a Verification marker",
      "I'll verify the fix. Verification: all 62 tests passed, 2 files changed.",
    ],
    [
      "progress-worded sentence carrying a result marker",
      "Verifying complete: all tests passed and lint passed.",
    ],
    [
      "explicit completion with section headers",
      "Done. Files changed: handler.js. Backup at /tmp. Rollback script created.",
    ],
    [
      "narration followed by a Result: header",
      "I'll start running the suite. Result: 3 files changed, all checks passed.",
    ],
    [
      "semicolon-split narration with a past-tense result sentence",
      "Investigating the flake, I patched the handler; rollback notes in the PR.",
    ],
  ])("accepts %s as a final deliverable", (_label, text) => {
    expect(resolveRequiredCompletionTerminalResult(text)).toEqual({});
  });
});

describe("task completion delivery failures", () => {
  it("keeps the bounded failure reason UTF-16 well-formed", () => {
    const result = resolveRequiredCompletionDeliveryFailureTerminalResult(
      `${"x".repeat(158)}🚀tail`,
    );

    expect(result.terminalSummary).toContain(`${"x".repeat(158)}...`);
    expect(result.terminalSummary).not.toContain("\uD83D");
  });
});
