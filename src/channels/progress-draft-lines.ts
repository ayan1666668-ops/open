import { isShellToolDisplayName } from "../agents/tool-display.js";
// Small progress-draft line helpers shared by streaming renderers.
import type { ChannelProgressDraftLine } from "./streaming.js";

/** Progress draft state can mix legacy plain text lines with keyed structured lines. */
type ProgressDraftLine = string | ChannelProgressDraftLine;

/**
 * Removes a keyed structured progress line while preserving plain text draft lines.
 * Returns the original array when no line is removed so renderers can use identity as a no-op signal.
 */
export function removeChannelProgressDraftLine<TLine extends ProgressDraftLine>(
  lines: TLine[],
  id: string,
): TLine[] {
  const lineId = id.trim();
  if (!lineId) {
    return lines;
  }
  const next = lines.filter((line) => typeof line !== "object" || line.id?.trim() !== lineId);
  // Reference equality is part of the caller contract; redraw/delete work only runs after a real removal.
  return next.length === lines.length ? lines : next;
}

/** Approvals and failures that can start a draft when their rows are visible. */
export function isChannelProgressAttentionLine(line: string | ChannelProgressDraftLine): boolean {
  if (typeof line === "string") {
    return false;
  }
  const status = line.status?.toLowerCase();
  return (
    line.kind === "approval" ||
    status === "failed" ||
    status === "error" ||
    status === "blocked" ||
    (status?.startsWith("exit ") === true && status !== "exit 0")
  );
}

export function getProgressDraftLineText(line: string | ChannelProgressDraftLine): string {
  if (typeof line === "string") {
    return line;
  }
  const icon = line.icon?.trim();
  const prefix = icon ? `${icon} ` : "";
  const label = line.label.trim();
  const detail = line.detail?.trim();
  const status = line.status?.trim();
  const displayStatus = status === "completed" ? undefined : status;
  if (detail) {
    const compactCommandLine = isShellToolDisplayName(line.toolName);
    if (
      displayStatus &&
      detail !== displayStatus &&
      (line.kind === "command-output" || isChannelProgressAttentionLine(line))
    ) {
      const outputDetail = detail.startsWith(`${displayStatus};`)
        ? detail
        : `${displayStatus}; ${detail}`;
      if (compactCommandLine) {
        return `${prefix}${outputDetail}`;
      }
      return label ? `${prefix}${label}: ${outputDetail}` : `${prefix}${outputDetail}`;
    }
    if (line.kind !== "patch" && label && !compactCommandLine) {
      return `${prefix}${label}: ${detail}`;
    }
    return `${prefix}${detail}`;
  }
  if (displayStatus) {
    if (label) {
      return `${prefix}${label}: ${displayStatus}`;
    }
    return `${prefix}${displayStatus}`;
  }
  const text = line.text.trim();
  if (!icon && text && text !== label) {
    return text;
  }
  return `${prefix}${label}`.trim();
}
