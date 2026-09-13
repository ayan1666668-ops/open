import type { Range } from "@tanstack/virtual-core";
import { describe, expect, it } from "vitest";
import { extractTranscriptRange, transcriptRowIndexes } from "./chat-transcript-range.ts";

const range: Range = { startIndex: 40, endIndex: 44, overscan: 2, count: 100 };
const rowIndexesByKey = new Map([
  ["row:10", 10],
  ["row:42", 42],
]);

describe("transcriptRowIndexes", () => {
  it("windows around the viewport with overscan by default", () => {
    expect(transcriptRowIndexes(range, true)).toEqual([38, 39, 40, 41, 42, 43, 44, 45, 46]);
  });

  it("keeps every row connected when windowing is off", () => {
    const indexes = transcriptRowIndexes(range, false);
    expect(indexes).toHaveLength(100);
    expect(indexes[0]).toBe(0);
    expect(indexes.at(-1)).toBe(99);
  });
});

describe("extractTranscriptRange", () => {
  it("adds a focused row outside the window", () => {
    expect(extractTranscriptRange(range, rowIndexesByKey, "row:10", true)).toEqual([
      10, 38, 39, 40, 41, 42, 43, 44, 45, 46,
    ]);
  });

  it("does not duplicate a focused row already inside the window", () => {
    expect(extractTranscriptRange(range, rowIndexesByKey, "row:42", true)).toEqual([
      38, 39, 40, 41, 42, 43, 44, 45, 46,
    ]);
  });

  it("returns the full transcript unchanged when windowing is off", () => {
    const indexes = extractTranscriptRange(range, rowIndexesByKey, "row:10", false);
    expect(indexes).toHaveLength(100);
    expect(new Set(indexes).size).toBe(100);
  });
});
