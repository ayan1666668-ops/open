#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Pins continuation-specific guards to the call sites that must consult them.
//
// WHY THIS EXISTS. Four upstream absorbs in one day each centralised a decision that
// one of our continuation guards lived inside, and the mechanically-clean resolution
// silently deleted the guard every time:
//
//   1. upstream moved assistant-text extraction to a lazy thunk; taking its
//      `sanitizeAssistantText` would have dropped continuation-signal stripping.
//   2. upstream added `params.isCurrent?.() !== false` to a cleanup retry guard while
//      our side had removed the argument that guard reads, making it vacuous.
//   3. upstream extracted prune/cancel/repair into `task-flow-maintenance-policy.ts`,
//      which has no durable-obligation concept, so a terminal flow still owing
//      `terminalNoticePending` would have been pruned and the notice lost.
//
// Every one of those compiles, and every one passes upstream's own tests, because the
// guard's coverage lives in the code being replaced. Type checking cannot see it and
// unit tests do not miss it. This script does.
//
// Each entry names a guard and the modules that MUST call it. Losing a call site is a
// hard failure with the protection spelled out, so the next absorb has to make a
// deliberate decision instead of an accidental one.
import type ts from "typescript";
import { getTypeScript, runAsScript, toLine } from "./lib/ts-guard-utils.mts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type GuardContract = {
  /** The guard function whose call sites are pinned. */
  guard: string;
  /** What is lost if a call site disappears. Printed on failure. */
  protects: string;
  /** Repo-relative modules that must each contain at least one call. */
  callers: string[];
};

const contracts: GuardContract[] = [
  {
    guard: "hasUnfulfilledDurableObligation",
    protects:
      "a terminal task-flow still holding pending-obligation state (terminalNoticePending) must never be pruned; upstream's task-flow-maintenance-policy has no durable-obligation concept, so both the action selector and the worker that deletes the row have to consult this",
    callers: [
      "src/tasks/task-flow-registry.maintenance.ts",
      "src/tasks/task-flow-maintenance.worker.ts",
    ],
  },
  {
    guard: "hasFrozenSessionIdentity",
    protects:
      "accepted-collector termination may only retry while the frozen session identity is still deletable; without it the conjunctive retry guard loses its identity arm",
    callers: ["src/agents/subagents/spawn/subagent-spawn-cleanup.ts"],
  },
  {
    guard: "sanitizeAssistantDisplayText",
    protects:
      "continuation-signal and trailing CONT directive stripping on assistant display text; upstream's sanitizeAssistantText does not strip them",
    callers: ["src/agents/embedded-agent-utils.ts"],
  },
  {
    guard: "hasLiveContinuationDelegateChildRun",
    protects:
      "post-compaction delegate delivery must not settle while a continuation delegate child run is still live",
    callers: [
      "src/auto-reply/continuation/delegate-dispatch-accepted-children.ts",
      "src/auto-reply/reply/post-compaction-delegate-delivery.ts",
    ],
  },
  {
    guard: "hasTrustedContinuationHeartbeatWake",
    protects:
      "only a trusted continuation heartbeat wake may drive the runner; an untrusted wake must not schedule continuation work",
    callers: [
      "src/infra/heartbeat-runner.ts",
      "src/infra/heartbeat-runner-scheduler.ts",
      "src/infra/heartbeat-wake.ts",
      "src/infra/session-event-wake.ts",
    ],
  },
  {
    guard: "isContinuationWrappedRunResult",
    protects:
      "fallback settlement must recognise a continuation-wrapped run result rather than settling it as a bare failure",
    callers: ["src/auto-reply/reply/agent-runner-fallback-settlement.ts"],
  },
  {
    guard: "isWakeContinuationRun",
    protects:
      "a descendant-settle wake must never fire for a run that is itself a wake continuation, or the wake recurses forever. Upstream keeps this check INSIDE its wake function (`isWakeContinuation(params.runId)` in runDescendantWake); our side renamed that function to wakeSubagentRunAfterDescendants and moved the check up to the caller's gate, so the caller is now the only place it exists",
    callers: ["src/agents/subagents/announce/subagent-announce.ts"],
  },
  {
    guard: "isSpawnSubagentAdmissionCancelledError",
    protects:
      'an admission-cancelled spawn is a cancellation, not an error. Each call site converts it differently and losing any one silently changes observable behaviour: rollback still terminates the accepted child even when taskRowOwnership is not "required"; the session patch rethrows instead of flattening to a generic error status; spawn reports "cancelled" instead of "error"; delegate dispatch counts it rejected and drops the artifact policy instead of falling through to terminal chain-state handling',
    callers: [
      "src/agents/subagents/spawn/subagent-spawn-rollback.ts",
      "src/agents/subagents/spawn/subagent-spawn-session-patch.ts",
      "src/agents/subagents/spawn/subagent-spawn.ts",
      "src/auto-reply/continuation/delegate-dispatch.ts",
    ],
  },
  {
    guard: "isContinuationHeartbeatEquivalent",
    protects:
      "only a system-injected wake (work-wake, delegate-return, subagent-return) may be forwarded as the continuation trigger of a durable generated-media handoff; any other trigger must be narrowed to undefined so a user turn is never replayed as a heartbeat-equivalent wake",
    callers: [
      "src/agents/subagents/announce/subagent-announce-delivery.ts",
      "src/gateway/server-restart-sentinel-agent-delivery.ts",
    ],
  },
  {
    guard: "sanitizeTranscriptToolCallBlock",
    protects:
      "continuation attachment snapshots are durable handoff input, not replayable transcript content. Every canonical transcript writer must apply this projection before serializing an assistant message, or a continue_delegate attachment payload is persisted into the transcript and replayed",
    callers: [
      "src/agents/embedded-agent-runner/cli-backend-dispatch-transcript.ts",
      "src/agents/session-transcript-repair.ts",
      "src/agents/transcript-redact.ts",
    ],
  },
  {
    guard: "isTranscriptToolCallBlock",
    protects:
      "the selector that reaches sanitizeTranscriptToolCallBlock in the redaction walker; losing it makes the sanitizer unreachable without removing it, so the guard-callsite pin on the sanitizer alone would still pass",
    callers: ["src/agents/transcript-redact.ts"],
  },
];

async function main() {
  const ts = getTypeScript();
  const failures: string[] = [];
  const found: string[] = [];

  for (const contract of contracts) {
    for (const caller of contract.callers) {
      const absolute = path.join(repoRoot, caller);
      let content: string;
      try {
        content = await fs.readFile(absolute, "utf8");
      } catch {
        failures.push(
          `${caller}: required caller of ${contract.guard}() is missing entirely.\n    protects: ${contract.protects}`,
        );
        continue;
      }
      const sourceFile = ts.createSourceFile(caller, content, ts.ScriptTarget.Latest, true);
      let callLine: number | undefined;
      const visit = (node: ts.Node): void => {
        if (callLine !== undefined) {
          return;
        }
        if (ts.isCallExpression(node)) {
          const target = node.expression;
          const name = ts.isIdentifier(target)
            ? target.text
            : ts.isPropertyAccessExpression(target)
              ? target.name.text
              : undefined;
          if (name === contract.guard) {
            callLine = toLine(sourceFile, node);
            return;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      if (callLine === undefined) {
        failures.push(
          `${caller}: no call to ${contract.guard}() found.\n    protects: ${contract.protects}`,
        );
      } else {
        found.push(`${contract.guard} @ ${caller}:${callLine}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error(
      `continuation guard call-site check FAILED: ${failures.length} lost protection(s).\n`,
    );
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    console.error(
      "\nA guard was removed or its caller stopped consulting it. If an upstream absorb\n" +
        "centralised the decision, thread the guard into the new path rather than dropping\n" +
        "it, and update this contract deliberately.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `continuation guard call-sites OK: ${found.length} pinned call site(s) across ${contracts.length} guard(s).`,
  );
}

runAsScript(import.meta.url, main);
