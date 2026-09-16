// Feishu plugin module owns how a table mode routes a reply through cards and posts.
import type { MarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { hasCardMarkdownTable, hasUndrawableCardTable } from "./presentation-card.js";

/**
 * One owner for every question the configured table mode answers: which representation the
 * text takes, which shapes a card cannot draw, and how far a conversion may grow before the
 * message it settles into has to carry it instead.
 */
export function createFeishuTableRouting(params: {
  convertMarkdownTables: (text: string, mode: MarkdownTableMode) => string;
  tableMode: MarkdownTableMode;
  textChunkLimit: number;
}) {
  // answer previews stream raw text, so the preview dedupe compares payload text, while
  // streamed content enters the ownership state (closing record, settlement, delivered
  // finals) and every comparison against a final in this one rendered form. The closing
  // record and the settlement lookup take the answer rather than the reasoning preview.
  // An unmatched off close is the exception, since it posts reasoning and answer
  // combined and records that combined body as a delivered final. Off conversion returns
  // its input, so that key holds the value it held before this change.
  const nativeTables = params.tableMode === "block";
  const postTableMode = nativeTables ? "code" : params.tableMode;
  const renderTables = (value: string): string =>
    nativeTables ? value : params.convertMarkdownTables(value, params.tableMode);
  // off has no card representation, since a card renderer parses the pipes, so text
  // that still carries a table takes the post path. The card renderer's own parser
  // answers what counts as a table, so pipe-less GFM counts and a fenced sample that
  // only looks like one does not.
  const tableNeedsPostPath = (value: string): boolean =>
    params.tableMode === "off" && hasCardMarkdownTable(value);
  // A card draws a native table, but reasoning is blockquoted before it reaches one and a
  // card does not draw a quoted table, so those rows vanish from the preview. A quoted
  // bullet list is not a table at all, so nothing about it is undrawable and the rows
  // survive. The close path takes the same fallback for the same reason.
  const previewReasoningText = (value: string): string => {
    const converted =
      nativeTables && hasCardMarkdownTable(value)
        ? params.convertMarkdownTables(value, "bullets")
        : renderTables(value);
    // The answer preview answers to this limit and the reasoning shares the card, so a
    // conversion that outgrows it gives way to the text as authored rather than making a
    // card carry more than the message it settles into.
    return converted !== value && converted.length > params.textChunkLimit ? value : converted;
  };
  // block keeps its tables raw for a card to draw, so answer text carrying a shape
  // the card renderer is not expected to draw takes the post path instead. A card
  // that cannot draw a table drops those rows from the message rather than
  // degrading them. This asks about the answer alone: reasoning is wrapped in a
  // blockquote before it reaches the card, which is a separate limitation that
  // predates this change.
  const answerTableNeedsPostPath = (value: string): boolean =>
    nativeTables && hasUndrawableCardTable(value);

  return {
    nativeTables,
    postTableMode,
    renderTables,
    previewReasoningText,
    tableNeedsPostPath,
    answerTableNeedsPostPath,
  };
}
