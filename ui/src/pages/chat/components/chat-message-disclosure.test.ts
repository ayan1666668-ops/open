import { describe, expect, it } from "vitest";
import { findMessageDisclosureLine, type MessageTextRect } from "./chat-message-disclosure.ts";

function textRect(top: number, height = 18, lineHeight = 21): MessageTextRect {
  return { top, bottom: top + height, width: 80, lineHeight };
}

describe("findMessageDisclosureLine", () => {
  it.each([
    { name: "continuous text", tops: [1, 22, 43, 64, 85, 106], expected: 85 },
    { name: "paragraph gap", tops: [1, 22, 57, 78, 99, 120], expected: 99 },
  ])("keeps the actual fifth line position for $name", ({ tops, expected }) => {
    expect(
      findMessageDisclosureLine(
        tops.map((top) => textRect(top)),
        5,
      )?.top,
    ).toBe(expected);
  });

  it("combines inline fragments with different font metrics regardless of their DOM order", () => {
    const rects = [textRect(1), textRect(24, 14), textRect(43), textRect(22), textRect(45, 14)];
    expect(findMessageDisclosureLine(rects, 3)).toMatchObject({
      top: 43,
      bottom: 61,
      lineHeight: 21,
    });
  });

  it("ignores empty layout boxes and leaves missing lines unmeasured", () => {
    const rects = [textRect(1), { ...textRect(22), width: 0 }, textRect(43, 0)];
    expect(findMessageDisclosureLine(rects, 2)).toBeUndefined();
    expect(findMessageDisclosureLine([], 5)).toBeUndefined();
  });

  it("keeps tightly spaced block-art rows separate despite overlapping glyph boxes", () => {
    const rects = Array.from({ length: 8 }, (_, index) => textRect(index * 10.3125, 14, 10.32));
    expect(findMessageDisclosureLine(rects, 5)?.top).toBe(41.25);
  });

  it("keeps the tallest line height when a line has mixed font sizes", () => {
    expect(findMessageDisclosureLine([textRect(1, 18, 21), textRect(3, 12, 24)], 1)).toMatchObject({
      top: 1,
      bottom: 19,
      lineHeight: 24,
    });
  });
});
