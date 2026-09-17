// Defines task terminal outcome contracts used by completion handling.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { TaskTerminalOutcome } from "./task-registry.types.js";

/** Terminal fields required when a mandatory detached task completion is invalid. */
export type RequiredCompletionTerminalResult = {
  terminalOutcome?: Extract<TaskTerminalOutcome, "blocked">;
  terminalSummary?: string;
};

const PROGRESS_ONLY_PATTERN =
  /^(?:i(?:'|\u2019)ll|i will|i(?:'|\u2019)m|i am|i(?:'|\u2019)m going to|i am going to|let me|i need to)\s+(?:now\s+)?(?:analyz(?:e|ing)|apply|check(?:ing)?|confirm(?:ing)?|continue|debug(?:ging)?|figur(?:e|ing)\s+out|find(?:ing)?\s+out|follow(?:ing)?\s+up|get(?:ting)?|inspect(?:ing)?|investigat(?:e|ing)|look(?:ing)?(?:\s+into)?|map(?:ping)?|open(?:ing)?|read(?:ing)?|report(?:ing)?(?:\s+back)?|review(?:ing)?|run(?:ning)?|see(?:ing)?|start(?:ing)?|test(?:ing)?|trace|trac(?:e|ing)|try(?:ing)?|update|verify(?:ing)?|work(?:ing)?)/i;

const BARE_PROGRESS_ONLY_PATTERN =
  /^(?:analyz(?:e|ing)|check(?:ing)?|debug(?:ging)?|inspect(?:ing)?|investigat(?:e|ing)|look(?:ing)?\s+into|map(?:ping)?|read(?:ing)?|report(?:ing)?\s+back|review(?:ing)?|run(?:ning)?|test(?:ing)?|trac(?:e|ing)|verify(?:ing)?|work(?:ing)?\s+on)\b/i;

const FOLLOW_UP_PLANNING_PREFIX_PATTERN =
  /^(?:after(?:wards|\s+that)?|from\s+there|next|once\s+(?:done|that(?:'|\u2019)?s\s+done|that\s+is\s+done)|then)[,.\s]+/i;

const COMPLETION_RESULT_CLAUSE_PATTERN =
  /^(?:(?:i|we)(?:\s+(?:have\s+)?|(?:'|\u2019)ve\s+))?(?:done|completed|finished|fixed|patched|resolved|deployed|landed|merged|implemented|confirmed)\b|(?:^|,\s*|\band\s+)(?:(?:i|we)(?:\s+(?:have\s+)?|(?:'|\u2019)ve\s+)(?:completed|finished|fixed|patched|resolved|deployed|landed|merged|implemented|confirmed)\b|(?:all\s+)?(?:\d+\s+)?(?:tests?|build|lint|checks?|syntax)\s+(?:passed|succeeded|green)\b)/i;

const CONDITIONAL_PROGRESS_PATTERN = /\b(?:whether|if|unless|once|when)\b/i;
const FIRST_PERSON_PLAN_PATTERN =
  /^(?:(?:i|we)(?:'|\u2019)ll|(?:i|we)\s+(?:will|would|could|should|might|may|plan\s+to|hope\s+to|need\s+to))\b/i;
const COMPLETION_HEADING_PATTERN =
  /^(?:result|results|report|summary|outcome|conclusion|findings?|verification|status)\s*:\s*/i;

function normalizeCompletionText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function normalizeCompletionFailureReason(value: string | null | undefined): string {
  const normalized = normalizeCompletionText(value);
  if (!normalized) {
    return "";
  }
  return normalized.length <= 160 ? normalized : `${truncateUtf16Safe(normalized, 159)}...`;
}

function isProgressOnlyCompletionText(value: string): boolean {
  return value.split(/(?:[.!?;]|\s[-\u2013\u2014])\s+/).every((sentence) => {
    const text = sentence
      .replace(FOLLOW_UP_PLANNING_PREFIX_PATTERN, "")
      .replace(COMPLETION_HEADING_PATTERN, "")
      .trim();
    // Keep conditional premises intact instead of treating their colons as
    // independent results. Generic replies remain outside this heuristic.
    const clauses = CONDITIONAL_PROGRESS_PATTERN.test(text) ? [text] : text.split(/:\s+/);
    return clauses.every((clause) => {
      const body = clause.trim();
      const narration = body.replace(/^(?:if|unless|when|once)\b[^,]*,\s*/i, "");
      const progress =
        PROGRESS_ONLY_PATTERN.test(narration) ||
        BARE_PROGRESS_ONLY_PATTERN.test(narration) ||
        FIRST_PERSON_PLAN_PATTERN.test(narration) ||
        /^(?:(?:the\s+)?(?:tests?|checks?|build|lint|deployment|verification)\s+(?:(?:is|are|remains?)\s+)?)?(?:pending|in\s+progress|not\s+yet)[.!?]?$/i.test(
          body,
        );
      if (!progress) {
        return false;
      }
      const result = COMPLETION_RESULT_CLAUSE_PATTERN.exec(body);
      if (!result) {
        return true;
      }
      // Only an independent completed clause can rescue progress narration.
      // A result word in an object ("reviewing completed tasks") cannot do so.
      const resultClause =
        body
          .slice(result.index)
          .replace(/^(?:,|and)\s*/i, "")
          .split(/[,;]|\s+(?:and|but)\s+/i)[0] ?? "";
      return (
        CONDITIONAL_PROGRESS_PATTERN.test(resultClause) ||
        (/^and\b/i.test(result[0]) &&
          CONDITIONAL_PROGRESS_PATTERN.test(body.slice(0, result.index)))
      );
    });
  });
}

export function resolveRequiredCompletionTerminalResult(
  resultText: string | null | undefined,
): RequiredCompletionTerminalResult {
  const normalized = normalizeCompletionText(resultText);
  if (!normalized) {
    return {
      terminalOutcome: "blocked",
      terminalSummary: "Required completion did not produce a final deliverable.",
    };
  }
  if (isProgressOnlyCompletionText(normalized)) {
    return {
      terminalOutcome: "blocked",
      terminalSummary:
        "Required completion ended with progress-only text, not a final deliverable.",
    };
  }
  return {};
}

export function resolveRequiredCompletionDeliveryFailureTerminalResult(
  reason: string | null | undefined,
): RequiredCompletionTerminalResult {
  const normalizedReason = normalizeCompletionFailureReason(reason);
  return {
    terminalOutcome: "blocked",
    terminalSummary: normalizedReason
      ? `Required completion delivery failed before reaching the requester: ${normalizedReason}.`
      : "Required completion delivery failed before reaching the requester.",
  };
}
