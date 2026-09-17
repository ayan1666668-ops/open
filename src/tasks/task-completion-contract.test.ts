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
    ["clock adjunct comma plan", "I'll inspect the repo: Before 5:00, I will patch the handler."],
    ["clock adjunct colon plan", "I'll inspect the repo: Before 5:00: I will patch the handler."],
    ["present run prerequisite", "Reviewing the changes, I patched it when the tests run."],
    ["noun-object attempt", "Reviewing the failure, I attempted the repair."],
    ["noun-object try", "Reviewing the failure, I tried the repair."],
    [
      "coordinated scan future-only follow-up",
      "Reviewing the handler, I started patching it and will finish the repair.",
    ],
    [
      "coordinated scan conditional finish",
      "Reviewing the handler, I started patching it and finished the repair if tests pass.",
    ],
    ["unfinished attempt started", "Reviewing the failure, I started to patch the handler."],
    ["unfinished attempt attempted", "Reviewing the failure, I attempted to patch the handler."],
    ["unfinished attempt began", "Reviewing the failure, I began patching the handler."],
    ["unfinished attempt continued", "Reviewing the failure, I continued patching the handler."],
    [
      "unfinished attempt with adverb",
      "Reviewing the failure, I successfully started to patch the handler.",
    ],
    [
      "fronted before future plan",
      "I'll inspect the failure: Before proceeding, I will patch the handler.",
    ],
    [
      "fronted before colon future plan",
      "I'll inspect the failure: Before proceeding: I will patch the handler.",
    ],
    ["colon conditional pending", "I'll inspect the repo: If tests pass: Result: pending."],
    ["colon conditional result", "I'll inspect the repo: If tests pass: deployed."],
    ["colon unless result", "I'll inspect the repo: Unless tests fail: deployed."],
    ["colon when pending", "I'll inspect the repo: When tests pass: Result: pending."],
    ["colon after prerequisite", "I'll inspect the repo: After the tests pass: deployed."],
    ["compact nested pending heading", "I'll inspect the repo: Result:pending."],
    [
      "conditional premise after an independent colon",
      "I'll inspect the repo: I'll check whether the result is: tests passed.",
    ],
    ["nested result heading remains pending", "I'll inspect the repo: Result: pending."],
    [
      "colon result with future prerequisite",
      "I'll inspect the repo now: I patched the handler after the tests pass.",
    ],
    ["compound tomorrow adjunct", "Tomorrow morning, we're going to deploy the fix."],
    ["compound weekday adjunct", "On Friday morning, we're going to deploy the fix."],
    ["moment future adjunct", "I'll inspect the failure. In a moment, I will patch the handler."],
    ["noon future adjunct", "I'll inspect the failure. At noon, we are going to deploy."],
    ["did-plan intention", "Reviewing the changes, we did plan to deploy the fix."],
    ["negated did result", "Reviewing the changes, we did not repair the handler."],
    ["contracted plural going-to plan", "We're going to verify the fix."],
    ["expanded plural going-to plan", "We are going to deploy the fix."],
    ["singular going-to plan", "I'm going to deploy the fix."],
    [
      "tomorrow-prefixed future follow-up",
      "I'll inspect the failure. Tomorrow, I will patch the handler.",
    ],
    [
      "next-week future follow-up",
      "I'll inspect the failure. Next week, the migration will be completed.",
    ],
    [
      "weekday-prefixed future follow-up",
      "I'll inspect the failure. On Friday, I will patch the handler.",
    ],
    [
      "future-only follow-up sentence",
      "I'll inspect the failure. The migration will be completed tomorrow.",
    ],
    [
      "going-to follow-up sentence",
      "I'll inspect the failure. The migration is going to finish tomorrow.",
    ],
    ["arbitrary headed pending subject", "Status: database migration is still pending."],
    ["release-task pending heading", "Result: release task remains pending."],
    [
      "pending follow-up without heading",
      "I'll inspect the failure. Database migration is still pending.",
    ],
    ["unfulfilled past intention", "Reviewing the rollout, we planned to deploy the release."],
    [
      "past obligation without a result",
      "Reviewing the rollout, we were supposed to deploy the release.",
    ],
    ["headed still-pending status", "Status: still pending."],
    ["subject still-pending status", "Status: the deployment is still pending."],
    ["future noun-subject completion", "Reviewing the changes, the migration will be completed."],
    [
      "adverbial past adjective in prerequisite",
      "Reviewing the rollout, we deployed it when the newly failed tests pass.",
    ],
    [
      "comma-delimited after prerequisite",
      "Reviewing the rollout, we deployed it, after the tests pass.",
    ],
    ["after prerequisite", "Reviewing the rollout, we deployed it after the tests pass."],
    ["as-soon-as prerequisite", "Reviewing the rollout, we deployed it as soon as the tests pass."],
    ["qualified indirect test result", "Investigating why the unit tests have passed."],
    ["qualified future test result", "Reviewing the changes, the unit tests will have passed."],
    [
      "past adjective in future prerequisite",
      "Reviewing the rollout, we deployed the release when the failed tests pass.",
    ],
    [
      "completed adjective in future prerequisite",
      "Reviewing the rollout, we deployed it once the completed job is verified.",
    ],
    [
      "future auxiliary in temporal prerequisite",
      "Reviewing the changes, we fixed it when the tests will have passed.",
    ],
    [
      "subordinate past event in future prerequisite",
      "Reviewing the changes, we fixed it when the tests pass after the build finished.",
    ],
    ["conditional present-perfect result", "Reviewing whether all tests have passed."],
    [
      "conditional object after heading",
      "I'll inspect the failure. Result: completed the repair when CI succeeds.",
    ],
    [
      "once condition after object",
      "Reviewing the handler, we completed the repair once CI succeeds.",
    ],
    ["future temporal state", "Reviewing the rollout, the deployment is done when checks pass."],
    [
      "future perfect temporal condition",
      "Reviewing the handler, we fixed it when tests have passed.",
    ],
    ["future completed state", "Reviewing the rollout, the deployment will be done."],
    ["state inside an indirect question", "Reviewing whether the deployment is done."],
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
    ["perfect irregular written", "Reviewing the changes, I have written the migration."],
    ["perfect irregular contracted rewrite", "Reviewing the changes, I've rewritten the handler."],
    ["perfect irregular run", "Reviewing the changes, I have run the migration."],
    [
      "coordinated scan completed elided subject",
      "Reviewing the handler, I started patching it and finished the repair.",
    ],
    [
      "coordinated scan later explicit subject",
      "Reviewing the database, I attempted the repair and I rebuilt the index.",
    ],
    [
      "coordinated scan later irregular action",
      "Reviewing the handler, I attempted the repair and rewrote the handler.",
    ],
    ["completed adverb result", "Reviewing the changes, I successfully patched the handler."],
    [
      "completed adverb after auxiliary",
      "Reviewing the changes, I have successfully patched the handler.",
    ],
    ["completed start action", "Reviewing the deployment, I started the server."],
    ["prefixed irregular rebuilt", "Reviewing the database, I rebuilt the corrupted index."],
    ["prefixed irregular overwrote", "Reviewing the settings, I overwrote the stale config."],
    ["prefixed irregular rewrote", "Reviewing the changes, I rewrote the broken handler."],
    [
      "colon past event result",
      "I'll inspect the repo: After the alert fired: I patched the handler.",
    ],
    [
      "colon result with past temporal adjunct",
      "I'll inspect the repo now: I patched the handler after the alert fired.",
    ],
    [
      "nested headed colon result",
      "I'll inspect the repo now: Verification: all unit tests have passed after the patch landed.",
    ],
    ["completed did action", "Reviewing the changes, we did the repair."],
    [
      "dated completed report with follow-up",
      "Today I patched the handler, I'll monitor it tomorrow.",
    ],
    ["compound dated completed report", "On Friday morning, I patched the handler."],
    ["dated completed report", "On Friday, I patched the handler."],
    [
      "diagnosis before a future follow-up",
      "I'll inspect the failure. The crash is a missing null check, I will patch the handler.",
    ],
    ["temporal clock noun phrase", "Reviewing the rollout, we deployed after 5 p.m."],
    ["temporal deployment noun", "Reviewing the rollout, we deployed after deployment."],
    ["temporal midnight noun", "Reviewing the rollout, we deployed after midnight."],
    [
      "temporal qualified test noun",
      "Reviewing the rollout, we deployed after the integration tests.",
    ],
    [
      "noun-subject completed result",
      "Reviewing the changes, the migration completed successfully.",
    ],
    ["qualified test suite result", "Reviewing the changes, the full test suite has passed."],
    [
      "irregular fell temporal result",
      "Reviewing the rollout, we deployed it when the old worker fell over.",
    ],
    [
      "irregular saw temporal result",
      "Reviewing the rollout, we deployed it when we saw the green checks.",
    ],
    [
      "irregular lost temporal result",
      "Reviewing the rollout, we deployed it when the old worker lost connectivity.",
    ],
    [
      "irregular began temporal result",
      "Reviewing the rollout, we deployed it when the maintenance window began.",
    ],
    [
      "past event with an adjectival subject",
      "Reviewing the rollout, we deployed it when the newly failed tests passed.",
    ],
    [
      "irregular past temporal predicate",
      "Reviewing the rollout, we deployed it when the old worker went down.",
    ],
    [
      "past predicate with an adverb",
      "Reviewing the rollout, we deployed it when the tests finally passed.",
    ],
    [
      "ordinary past temporal predicate",
      "Reviewing the rollout, we deployed it when the maintenance window opened.",
    ],
    ["past temporal crash", "Reviewing the handler, we fixed it after the worker crashed."],
    ["qualified present-perfect test result", "Reviewing the changes, the unit tests have passed."],
    ["qualified counted results", "Reviewing the changes, all 12 integration tests have passed."],
    ["present-perfect test result", "Reviewing the changes, all tests have passed."],
    ["present-perfect build result", "Reviewing the changes, the build has succeeded."],
    ["past temporal action", "Reviewing the rollout, we deployed it when we finished the checks."],
    ["past temporal auxiliary", "Reviewing the rollout, we deployed it when the tests had passed."],
    ["completed deployment state", "Reviewing the changes, the deployment is done."],
    ["completed repair state", "Reviewing the rollout, the repair is complete."],
    ["completed plural state", "Reviewing the changes, all migrations are complete."],
    ["completed noun phrase", "Reviewing the changes, the cache migration has been completed."],
    ["past temporal tests", "Reviewing the handler, we fixed it when the tests failed."],
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
