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
    [
      "deferred result heading after progress",
      "I'll inspect the failure. Result: completed when CI succeeds.",
    ],
    [
      "fronted conditional result",
      "Reviewing the rollout, if validation succeeded, we deployed the release.",
    ],
    [
      "fronted unless result",
      "Reviewing the rollout, unless validation failed, we deployed the release.",
    ],
    ["future perfect done predicate", "Reviewing the changes, we will have done the repair."],
    ["future copular done predicate", "Reviewing the changes, I am going to be done."],
    [
      "conditional coordinated result",
      "Investigating whether docs changed and we fixed the timeout.",
    ],
    ["negated contracted result", "Reviewing the handler, we've not fixed the regression."],
    ["conditional candidate result", "Reviewing the handler, we fixed it if tests pass."],
    ["conditional first-person plan", "If the service fails, we plan to use the rollback script."],
    ["conditional first-person hope", "If the service fails, we hope to use the rollback script."],
    ["conditional first-person need", "If the service fails, we need to use the rollback script."],
    ["conditional first-person modal", "If the service fails, we would use the rollback script."],
    [
      "conditional future commitment",
      "If the service fails again, we will use the rollback script.",
    ],
    ["subject-first pending status", "Status: deployment pending."],
    ["pending headed tests", "Result: tests are pending."],
    ["future plural-subject plan", "We will run the tests."],
    ["narration that promises a later report", "I'll analyze the logs and report back"],
    ["future-tense verification", "I'm going to verify the fix"],
    ["conditional on whether tests pass", "I'll check whether the tests pass before continuing"],
    ["future-only conditional result", "I'll investigate whether the tests passed"],
    ["bare conditional result", "Investigating whether the tests passed"],
    ["bare progress verb", "Investigating the gateway logs"],
    ["future conditional after a colon", "I'll check whether the result is: tests passed"],
    ["pending result heading", "Investigating results: pending"],
    ["conditional follow-up sentence", "I'll investigate. If tests passed, I'll report back."],
    ["conditional result after a colon", "Investigating whether checks succeeded: tests passed"],
    ["future completion verb", "I'll get this done"],
    [
      "completed noun in a future plan",
      "Investigating the completed tasks will show whether the fix works",
    ],
    [
      "past result inside future narration",
      "Investigating why the tests passed will help me find the missing regression",
    ],
    ["pending follow-up heading", "I'll inspect the logs. Result: pending"],
    ["adjective inside progress", "Reviewing the completed tasks for regressions."],
    ["indirect test outcome", "Investigating why the tests passed"],
    ["figuring out a conditional result", "I'm figuring out whether the tests passed"],
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
    [
      "diagnosis without a result marker",
      "I'll inspect the repo now. The crash is a missing null check in src/foo.ts.",
    ],
    [
      "diagnosis after a separator",
      "I'll inspect the repo now - the crash is a missing null check in src/foo.ts.",
    ],
    [
      "completed work followed by monitoring",
      "Gateway restarted. I'll monitor logs for the next hour.",
    ],
    [
      "diagnosis after a colon",
      "I'll inspect the repo now: the crash is a missing null check in src/foo.ts.",
    ],
    ["completed clause after narration", "Reviewing the changes, we fixed the regression."],
    ["conditional operator guidance", "Use the rollback script if necessary."],
    ["completed action using done", "Reviewing the changes, we have done the repair."],
    ["completed singular state", "Reviewing the changes, I am done."],
    ["contracted done action", "Reviewing the changes, we've done the repair."],
    ["contracted plural state", "Reviewing the changes, we're done."],
    [
      "past headed result after progress",
      "I'll inspect the failure. Result: I patched the handler when the alert fired.",
    ],
    [
      "fronted past temporal result",
      "Reviewing the logs, when the alert fired, we patched the handler.",
    ],
    [
      "past temporal result explanation",
      "Reviewing the logs, we patched the handler when the alert fired.",
    ],
    [
      "independent result after conditional narration",
      "Investigating whether checks passed, we fixed the timeout.",
    ],
    [
      "modal explanation of an actual result",
      "Reviewing the handler, we patched it so retries would no longer duplicate requests.",
    ],
    ["contracted plural completion", "Reviewing the changes, we've fixed the regression."],
    ["contracted singular completion", "Reviewing the changes, I've fixed the regression."],
    ["sentence-initial pending fact", "Pending tasks require manual approval."],
    ["contracted negative pending status", "The deployment isn't pending."],
    ["advice about a pending queue", "Use the pending queue to inspect retries."],
    ["fact about a pending queue", "The pending queue contains three jobs."],
    ["negative pending status", "No pending tasks remain."],
    ["negative headed pending status", "Status: no pending migrations."],
    ["negated pending state", "The deployment is not pending."],
    ["leading past temporal qualifier", "When the alert fired, I patched the handler."],
    [
      "noun-subject future follow-up",
      "Patched the handler and the operations team will monitor the logs.",
    ],
    ["past temporal qualifier", "Patched the handler when the alert fired."],
    ["completed limited result", "I patched the handler, not the docs."],
    ["leading conditional guidance", "If the service fails again, use the rollback script."],
    ["subject-elided follow-up", "We fixed the regression and will monitor the logs."],
    ["completed work with follow-up advice", "Patched and deployed, let me know if issues appear."],
    ["completed work with coordinated follow-up", "Patched the handler and I'll monitor the logs."],
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
