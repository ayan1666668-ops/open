import type { AgentMessage } from "../runtime/index.js";
import { nestRequiredSummaryHeadings } from "./compaction-safeguard-quality.js";

const SPLIT_TURN_SECTION_HEADING = "**Turn Context (split turn):**";
const PREVIOUS_SUMMARY_REDISTILL_PREFIX =
  "Previous compaction summary to re-distill with the current conversation. " +
  "Prune stale, duplicate, or superseded details instead of preserving it verbatim.";

export function prependPreviousSummaryForRedistill(params: {
  messages: AgentMessage[];
  previousSummary?: string;
}): AgentMessage[] {
  const previousSummary = params.previousSummary?.trim();
  if (!previousSummary) {
    return params.messages;
  }
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `<previous-compaction-summary>\n${PREVIOUS_SUMMARY_REDISTILL_PREFIX}\n\n${previousSummary}\n</previous-compaction-summary>`,
        },
      ],
      timestamp: 0,
    } as AgentMessage,
    ...params.messages,
  ];
}

export function nestMarkdownHeadings(text: string): string {
  return text.replace(/^##(?=[ \t]+\S)/gmu, "###");
}

export function normalizeLegacySplitTurnSummary(summary: string | undefined): string | undefined {
  const splitTurnStart = summary?.indexOf(SPLIT_TURN_SECTION_HEADING) ?? -1;
  if (!summary || splitTurnStart < 0) {
    return summary;
  }
  const splitTurnContentStart = splitTurnStart + SPLIT_TURN_SECTION_HEADING.length;
  // Shipped safeguard summaries nested a second complete summary after this owned boundary.
  // Demote its headings only in the next model input; the persisted old boundary stays untouched.
  return `${summary.slice(0, splitTurnContentStart)}${nestRequiredSummaryHeadings(summary.slice(splitTurnContentStart))}`;
}
