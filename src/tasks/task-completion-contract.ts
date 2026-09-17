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

const PLANNING_TIME_PREFIX_PATTERN =
  /^(?:(?:today|tomorrow|tonight|later|soon|eventually)(?:\s+(?:morning|afternoon|evening|night))?|(?:next|this)\s+(?:week|month|year|morning|afternoon|evening|weekend)|(?:in|within)\s+(?:a|an|\d+)\s+(?:moments?|minutes?|hours?|days?|weeks?)|at\s+(?:noon|midnight|\d{1,2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?)|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening|night))?)(?:,\s+|\s+(?=(?:i|we)\b))/i;

const CONTEXT_PREPOSITION = String.raw`(?:in|on|at|by|during|within|following|upon|for)`;
const CONTEXT_START_PATTERN = new RegExp(String.raw`^${CONTEXT_PREPOSITION}\b`, "i");
const LEADING_CONTEXT_PATTERN = new RegExp(
  String.raw`^(?:${CONTEXT_PREPOSITION}\b.*?(?:,\s*|:\s+|\s+(?=(?:i|we)\b)))+`,
  "i",
);

const COMPLETION_RESULT_CLAUSE_PATTERN =
  /^(?:(?:(?:i|we)(?:\s+(?:have\s+)?|(?:'|\u2019)ve\s+)|(?:i(?:\s+am|(?:'|\u2019)m)|we(?:\s+are|(?:'|\u2019)re))\s+))?(?:done|completed|finished|fixed|patched|resolved|deployed|landed|merged|implemented|confirmed)\b|(?:^|,\s*|\band\s+)(?:(?:(?:i|we)(?:\s+(?:have\s+)?|(?:'|\u2019)ve\s+)|(?:i(?:\s+am|(?:'|\u2019)m)|we(?:\s+are|(?:'|\u2019)re))\s+)(?:done|completed|finished|fixed|patched|resolved|deployed|landed|merged|implemented|confirmed)\b|(?:(?:all|the)\s+)?(?:\d+\s+)?(?:(?!(?:why|whether|if|unless|when|once|after|will|would|could|should|might|may)\b)[\w-]+\s+){0,3}(?:tests?|build|lint|checks?|syntax)\s+(?:(?:have|has)\s+)?(?:passed|succeeded|green)\b)/gi;

const CONDITIONAL_PROGRESS_PATTERN = /\b(?:whether|if|unless|once|when|after|as\s+soon\s+as)\b/i;
const CONDITION_CLAUSE_PREFIX = String.raw`(?:^|[,;:]\s*|\b(?:and|but|or|so|then)\s+)(?:(?:and|but|or|so|then)\s+)*`;
const FRONTED_CONDITIONAL_PATTERN = new RegExp(
  String.raw`${CONDITION_CLAUSE_PREFIX}(?:if|unless)\b`,
  "i",
);
const FRONTED_TEMPORAL_PATTERN = new RegExp(
  String.raw`${CONDITION_CLAUSE_PREFIX}(when|once|after|as\s+soon\s+as)\b([^,]*)`,
  "gi",
);
const FIRST_PERSON_PLAN_PATTERN =
  /^(?:(?:i|we)(?:'|\u2019)ll|(?:i(?:\s+am|(?:'|\u2019)m)|we(?:\s+are|(?:'|\u2019)re))\s+going\s+to|(?:i|we)\s+(?:will|would|could|should|might|may|plan\s+to|hope\s+to|need\s+to))\b/i;
const COMPLETION_HEADING_PATTERN =
  /^(?:(?:result|results|report|summary|outcome|conclusion|findings?|verification|status)\s*:\s*)+/i;

// Shared subject/predicate grammar stays inside progress-result classification.
// In particular, a subject cannot absorb a modal, negation, or new condition.
const RESULT_SUBJECT_WORD = String.raw`(?!(?:if|unless|when|once|whether|before|after|while|and|or|that|which|will|would|could|should|might|may|can|must|have|has|had|did|is|are|was|were|not|never|to)\b|\w+(?:'|\u2019)(?:t|ll)\b)[\w'-]+`;
const RESULT_SUBJECT = String.raw`(?:${RESULT_SUBJECT_WORD}\s+){0,6}(?!(?:the|a|an|all|both|our|already|just)\b|[\w'-]+ly\b)${RESULT_SUBJECT_WORD}`;
const IRREGULAR_PAST_VERB =
  "arose|awoke|bore|beat|became|began|bent|bet|bit|bled|blew|broke|brought|built|burnt|burst|bought|caught|chose|came|cost|crept|cut|dealt|dug|did|drew|drank|drove|ate|fell|fed|felt|fought|found|fled|flew|forbade|forgot|forgave|froze|got|gave|went|grew|hung|heard|hid|hit|held|hurt|kept|knew|laid|led|leant|leapt|learnt|left|lent|let|lay|lit|lost|made|meant|met|paid|put|quit|read|rode|rang|rose|ran|said|saw|sought|sold|sent|set|shook|shone|shot|showed|shrank|shut|sang|sank|sat|slept|slid|smelt|spoke|spelt|spent|spilt|spun|split|spread|sprang|stood|stole|stuck|stung|stank|struck|swore|swept|swam|swung|took|taught|tore|told|thought|threw|understood|upset|woke|wore|wept|won|wound|wrote";
const PAST_RESULT_VERB = String.raw`(?:(?:(?:re|un|over|under|mis|out|fore|with)-?)?(?:${IRREGULAR_PAST_VERB})|(?!(?:need|feed|bleed|breed|heed|seed|weed|speed|succeed|exceed|proceed)\b)[a-z]+ed)`;
// Perfect-tense forms are separate: a present "tests run" is not a past
// temporal event merely because "have run" can report a completed action.
const PERFECT_RESULT_VERB = String.raw`(?:(?:re|un|over|under|mis|out|fore|with)-?)?(?:arisen|awoken|borne|beaten|become|begun|bitten|blown|broken|chosen|drunk|driven|eaten|fallen|flown|forbidden|forgotten|forgiven|frozen|gotten|given|gone|grown|hidden|known|lain|ridden|rung|risen|run|seen|shaken|shown|shrunk|sung|sunk|spoken|sprung|stolen|stunk|stricken|sworn|swum|taken|torn|thrown|woken|worn|written)`;
const RESULT_ADVERBS = String.raw`(?:(?:[a-z]+ly|already|just)\s+){0,3}`;
const COMPLETION_STATE_CLAUSE_PATTERN = new RegExp(
  String.raw`(?:^|,\s*|\band\s+)${RESULT_SUBJECT}\s+${RESULT_ADVERBS}(?:(?:(?:has|have)\s+)?${RESULT_ADVERBS}(?:${PAST_RESULT_VERB}|done)|(?:is|are|was|were|has\s+been|have\s+been)\s+${RESULT_ADVERBS}(?:done|complete|completed|finished|fixed|resolved))\b`,
  "gi",
);
const PERFECT_RESULT_CLAUSE_PATTERN = new RegExp(
  String.raw`(?:^|,\s*|\band\s+)(?:${RESULT_SUBJECT}\s+${RESULT_ADVERBS}(?:has|have)|(?:i|we)(?:'|\u2019)ve)\s+${RESULT_ADVERBS}(?:${PAST_RESULT_VERB}|${PERFECT_RESULT_VERB}|done)\b`,
  "gi",
);
const COORDINATED_RESULT_CLAUSE_PATTERN = new RegExp(
  String.raw`(?:,\s*|\band\s+)${RESULT_ADVERBS}(?:${PAST_RESULT_VERB}|done|complete)\b`,
  "gi",
);
const UNFINISHED_RESULT_PATTERN = new RegExp(
  String.raw`^(?:${RESULT_SUBJECT}\s+)?${RESULT_ADVERBS}(?:did\s+(?:not|never)\b|(?:(?:had|has|have|was|were|did)\s+)?${RESULT_ADVERBS}(?:(?:attempt(?:ed)?|try|tried)\b|(?:plan(?:ned)?|hope(?:d)?|intend(?:ed)?|expect(?:ed)?|want(?:ed)?|need(?:ed)?|aim(?:ed)?|supposed)\s+to\b|(?:start(?:ed)?|begin|began|begun|continu(?:e|ed)|proceed(?:ed)?)\s+(?:to\b|[a-z]+ing\b)))`,
  "i",
);
const PAST_TEMPORAL_EVENT_PATTERN = new RegExp(
  String.raw`^${RESULT_SUBJECT}\s+(?:(?:just|already|recently|finally)\s+)?(?:was|were|had|did|${PAST_RESULT_VERB})\b`,
  "i",
);

const PRESENT_TEMPORAL_EVENT_PATTERN = new RegExp(
  String.raw`^${RESULT_SUBJECT}\s+(?:(?:will|would|could|should|might|may|can|must|is|are|has|have|do|does)\b|(?:pass|succeed|fail|finish|complete|open|close|start|stop|end|arrive|recover|resolve|deploy|land|merge|return|restart|reboot|fire|crash|begin|break|go|come|respond|become|reach|settle|receive|expire|resume|appear|disappear|connect|disconnect|stabilize|install|publish|approve|accept|reject|clear|turn)(?:s|es)?\b)`,
  "i",
);
const FUTURE_COMPLETION_PATTERN = new RegExp(
  String.raw`^${RESULT_SUBJECT}\s+(?:(?:will|would|could|should|might|may|can|must)\b|(?:is|are)\s+going\s+to\b)`,
  "i",
);
const PENDING_COMPLETION_PATTERN = new RegExp(
  String.raw`^(?:${RESULT_SUBJECT}\s+(?:(?:is|are|remains?)\s+)?)?(?:still\s+)?(?:pending|in\s+progress|not\s+yet)[.!?]?$`,
  "i",
);

function hasDeferredTemporalResult(prefix: string, resultClause: string): boolean {
  const temporalClauses = [
    ...prefix.matchAll(FRONTED_TEMPORAL_PATTERN),
    ...resultClause.matchAll(/\b(when|once|after|as\s+soon\s+as)\b([^,]*)/gi),
  ];
  // Check the temporal clause's subject/predicate, not past-looking modifiers
  // such as "the failed tests pass". This exception is only for known result
  // narration; generic replies are not subject to temporal parsing.
  return temporalClauses.some(([, marker = "", event = ""]) => {
    const temporal = event.trim();
    // "After" also introduces a noun phrase, e.g. "after midnight". Only an
    // identifiable event predicate makes that preposition a prerequisite.
    return (
      !PAST_TEMPORAL_EVENT_PATTERN.test(temporal) &&
      (marker.toLowerCase() !== "after" || PRESENT_TEMPORAL_EVENT_PATTERN.test(temporal))
    );
  });
}

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
  let progressSeen = false;
  return value.split(/(?:[.!?;]|\s[-\u2013\u2014])\s+/).every((sentence) => {
    const text = sentence
      .replace(PLANNING_TIME_PREFIX_PATTERN, "")
      .replace(FOLLOW_UP_PLANNING_PREFIX_PATTERN, "")
      .replace(COMPLETION_HEADING_PATTERN, "")
      .trim();
    const parts = text.split(/:\s+/);
    const clauses: string[] = [];
    for (const part of parts) {
      const body = part.trim();
      if (
        !body ||
        (parts.length > 1 && `${body}:`.replace(COMPLETION_HEADING_PATTERN, "") === "")
      ) {
        continue;
      }
      const previous = clauses.at(-1);
      // Only a premise before this colon binds its suffix. A temporal word in
      // a later completed result must not hide an earlier clause boundary.
      if (
        previous &&
        (CONDITIONAL_PROGRESS_PATTERN.test(previous) ||
          /^before\b/i.test(previous) ||
          CONTEXT_START_PATTERN.test(previous))
      ) {
        clauses[clauses.length - 1] = `${previous}: ${body}`;
      } else {
        clauses.push(body);
      }
    }
    return clauses.every((clause) => {
      const body = clause.replace(COMPLETION_HEADING_PATTERN, "").trim();
      const narration = body
        .replace(/^(?:if|unless|when|once|after|before|as\s+soon\s+as)\b.*?(?:,\s*|:\s+)/i, "")
        .replace(LEADING_CONTEXT_PATTERN, "")
        .replace(PLANNING_TIME_PREFIX_PATTERN, "");
      const narrativeProgress =
        PROGRESS_ONLY_PATTERN.test(narration) ||
        BARE_PROGRESS_ONLY_PATTERN.test(narration) ||
        FIRST_PERSON_PLAN_PATTERN.test(narration);
      // A progress prefix must reach a clause boundary before a result can be
      // independent; qualified test subjects must not absorb that prefix.
      const resultOffset = narrativeProgress ? body.search(/,|\band\s+/i) : 0;
      const resultText = resultOffset < 0 ? "" : body.slice(resultOffset);
      const results = [
        COMPLETION_RESULT_CLAUSE_PATTERN,
        COMPLETION_STATE_CLAUSE_PATTERN,
        PERFECT_RESULT_CLAUSE_PATTERN,
        COORDINATED_RESULT_CLAUSE_PATTERN,
      ].flatMap((pattern) =>
        [...resultText.matchAll(pattern)].map((result) => ({
          result,
          elidedSubject: pattern === COORDINATED_RESULT_CLAUSE_PATTERN,
        })),
      );
      const completedResult = results.some(({ result, elidedSubject }) => {
        const resultIndex = resultOffset + result.index;
        const prefix = body.slice(0, resultIndex);
        const remainder = body.slice(resultIndex).replace(/^(?:,|and)\s*/i, "");
        const resultClause =
          remainder.split(
            /,(?!\s*(?:if|unless|whether|once|when|after|as\s+soon\s+as)\b)|\s+(?:and|but|so|because|to)\s+/i,
          )[0] ?? "";
        // An elided subject inherits its plan: "I'll run and read" is not
        // past tense. A new explicit subject can introduce an actual result.
        const subjectClause = prefix
          .split(/(?:,|\b(?:and|but|so)\b)\s*(?=(?:i|we)\b)/i)
          .at(-1)
          ?.trim()
          .replace(LEADING_CONTEXT_PATTERN, "");
        // Reject each deferred candidate, not a later independent completed
        // action merely because the first clause only described an attempt.
        return !(
          (elidedSubject && FIRST_PERSON_PLAN_PATTERN.test(subjectClause ?? "")) ||
          UNFINISHED_RESULT_PATTERN.test(remainder) ||
          /\b(?:whether|if|unless)\b/i.test(resultClause) ||
          FRONTED_CONDITIONAL_PATTERN.test(prefix) ||
          (/^and\b/i.test(result[0]) &&
            !/,\s*$/.test(prefix) &&
            CONDITIONAL_PROGRESS_PATTERN.test(prefix)) ||
          hasDeferredTemporalResult(prefix, resultClause)
        );
      });
      const conditionalResult = results.length > 0 && !completedResult;
      const progress =
        narrativeProgress ||
        PENDING_COMPLETION_PATTERN.test(body) ||
        (progressSeen && FUTURE_COMPLETION_PATTERN.test(narration)) ||
        // A premise cannot become a deliverable just because no result matched.
        (progressSeen &&
          (/^(?:if|unless|whether)\b/i.test(body) || hasDeferredTemporalResult(body, ""))) ||
        (progressSeen && conditionalResult);
      progressSeen ||= progress;
      // Generic replies retain their existing behavior; only a known narrative
      // needs an actual result, not an adjective or deferred completion status.
      return progress && !completedResult;
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
