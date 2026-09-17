export type MessageTextRect = {
  top: number;
  bottom: number;
  width: number;
  lineHeight: number;
};

const LINE_POSITION_TOLERANCE = 0.5;

export function findMessageDisclosureLine(
  rects: readonly MessageTextRect[],
  lineNumber: number,
): MessageTextRect | undefined {
  const ordered = rects
    .filter((rect) => rect.width > 0 && rect.bottom > rect.top)
    .toSorted((a, b) => a.top - b.top);
  let line: MessageTextRect | undefined;
  let count = 0;
  for (const rect of ordered) {
    // Tight line heights can make glyph boxes overlap consecutive text rows.
    if (
      !line ||
      rect.top >= Math.min(line.bottom, line.top + line.lineHeight) - LINE_POSITION_TOLERANCE
    ) {
      if (count === lineNumber) {
        return line;
      }
      line = { ...rect };
      count += 1;
    } else {
      line.bottom = Math.max(line.bottom, rect.bottom);
      line.lineHeight = Math.max(line.lineHeight, rect.lineHeight);
    }
  }
  return count === lineNumber ? line : undefined;
}
