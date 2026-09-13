import { defaultRangeExtractor, type Range, Virtualizer } from "@tanstack/virtual-core";
import { isWebKitEngine } from "../../../lib/webkit-engine.ts";

// WebKit has no CSS scroll anchoring to fall back on, and virtual rows that
// mount, unmount, and re-measure while a reply streams make its trackpad
// momentum stutter and fight the reader. Keep every row connected there so
// the transcript scrolls like a static page; Blink and Gecko stay windowed.
const WINDOW_TRANSCRIPT_ROWS = !isWebKitEngine();

export function transcriptRowIndexes(range: Range, windowed = WINDOW_TRANSCRIPT_ROWS): number[] {
  return windowed
    ? defaultRangeExtractor(range)
    : Array.from({ length: range.count }, (_, index) => index);
}

export function extractTranscriptRange(
  range: Range,
  rowIndexesByKey: ReadonlyMap<string, number>,
  focusedRowKey: string | null,
  windowed = WINDOW_TRANSCRIPT_ROWS,
): number[] {
  const indexes = transcriptRowIndexes(range, windowed);
  const focused = focusedRowKey === null ? undefined : rowIndexesByKey.get(focusedRowKey);
  if (focused === undefined || focused < 0 || focused >= range.count || indexes.includes(focused)) {
    return indexes;
  }
  return [...indexes, focused].toSorted((left, right) => left - right);
}

export function previewTranscriptRowKeys(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  nextKeys: readonly string[],
  focusedRowKey: string | null,
): Set<string> {
  const nextIndexes = new Map(nextKeys.map((key, index) => [key, index]));
  const preview = new Virtualizer<HTMLDivElement, HTMLElement>({
    ...virtualizer.options,
    initialMeasurementsCache: virtualizer.takeSnapshot(),
    initialOffset: virtualizer.scrollOffset ?? virtualizer.options.initialOffset,
    initialRect: virtualizer.scrollRect ?? virtualizer.options.initialRect,
    onChange: () => undefined,
    rangeExtractor: (range) => extractTranscriptRange(range, nextIndexes, focusedRowKey),
  });
  preview.scrollElement = virtualizer.scrollElement;
  // Isolate the fork's key-anchor transition so teardown selection cannot
  // advance the model owned by connected DOM.
  preview.setOptions({
    ...preview.options,
    count: nextKeys.length,
    getItemKey: (index) => nextKeys[index] ?? `missing:${index}`,
  });
  return new Set(preview.getVirtualIndexes().flatMap((index) => nextKeys[index] ?? []));
}

export function focusedTranscriptRowKey(
  scrollElement: HTMLElement | null,
  target: EventTarget | null,
): string | null {
  if (!(target instanceof Element) || !scrollElement?.contains(target)) {
    return null;
  }
  const row = target.closest<HTMLElement>(".chat-virtual-row[data-virtual-row-key]");
  return row && scrollElement.contains(row) ? row.dataset.virtualRowKey || null : null;
}
