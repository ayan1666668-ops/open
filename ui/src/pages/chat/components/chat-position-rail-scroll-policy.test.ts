/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { renderChatPositionRail } from "./chat-position-rail.ts";
import { publishTranscriptScroll } from "./chat-transcript-scroll-events.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./chat-transcript.test-support.ts";

describe("conversation position rail scroll policy", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  const railUpdateScenarios = [
    "boot",
    "boot-resize",
    "resize",
    "resize-jump",
    "end",
    "focus",
    "focus-resize",
    "pointer",
    "reader",
    "reader-tabstop",
  ] as const;

  it.each(railUpdateScenarios)(
    "keeps the reader's rail position through %s updates",
    async (scenario) => {
      let publishVisibility: (element: Element) => void = () => {};
      vi.stubGlobal(
        "IntersectionObserver",
        class implements IntersectionObserver {
          readonly root = null;
          readonly rootMargin = "0px";
          readonly scrollMargin = "0px";
          readonly thresholds = [0];
          constructor(callback: IntersectionObserverCallback) {
            publishVisibility = (element) => {
              const rect = element.getBoundingClientRect();
              callback(
                [
                  {
                    target: element,
                    boundingClientRect: rect,
                    intersectionRect: rect,
                    rootBounds: rect,
                    intersectionRatio: 1,
                    isIntersecting: true,
                    time: 0,
                  },
                ],
                this,
              );
            };
          }
          takeRecords = () => [];
          observe = vi.fn();
          unobserve = vi.fn();
          disconnect = vi.fn();
        },
      );
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      const settlesAtEnd = scenario === "end";
      const count = settlesAtEnd ? 5 : 80;
      const startsAtTop = settlesAtEnd || scenario === "resize-jump";
      const activeMessage = vi.fn((): string =>
        scenario === "resize-jump" ? "message-0" : settlesAtEnd ? "message-2" : "message-79",
      );
      const positions = {
        markers: Array.from({ length: count }, (_, index) => ({
          id: `message-${index}`,
          anchorId: `message-${index}`,
          role: "user" as const,
          message: {
            role: "user",
            content: `Checkpoint ${index}`,
            timestamp: (index + 1) * 1_000,
            __openclaw: { id: `message-${index}`, seq: index + 1 },
          },
        })),
        markerIdsByMessageId: new Map(
          Array.from({ length: count }, (_, index) => [`message-${index}`, `message-${index}`]),
        ),
      };
      render(
        transcript.renderSession(
          "rail-scroll-policy",
          "agent:main:rail-scroll-policy",
          (session) => {
            vi.spyOn(session, "activeMessageId").mockImplementation(activeMessage);
            return html`<div class="chat-thread">
              <div class="chat-bubble" data-entry-id="message-79">Latest message</div>
              ${renderChatPositionRail({ positions, transcript: session, requestUpdate: () => {} })}
            </div>`;
          },
        ),
        container,
      );
      const root = container.querySelector<HTMLElement>(".chat-thread")!;
      const marks = container.querySelector<HTMLElement>(".chat-position-rail__marks")!;
      const marker = (index: number) =>
        marks.querySelector<HTMLButtonElement>(`[data-position-marker-id="message-${index}"]`)!;
      let height = settlesAtEnd ? 668 : 597;
      let scrollHeight = settlesAtEnd ? 700 : 8912;
      let marksHeight = settlesAtEnd ? 60 : 283;
      let railOffset = 0;
      Object.defineProperties(root, {
        clientHeight: { configurable: true, get: () => height },
        scrollHeight: { configurable: true, get: () => scrollHeight },
      });
      Object.defineProperties(marks, {
        clientHeight: { configurable: true, get: () => marksHeight },
        scrollTop: {
          configurable: true,
          get: () => railOffset,
          set: (value: number) => {
            railOffset = Math.max(0, Math.min(value, count * 12 - marksHeight));
          },
        },
      });
      root.scrollTop = startsAtTop ? 0 : 8315;
      const flush = async () => {
        marks.dispatchEvent(new Event("scroll"));
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
      };
      try {
        await flush();
        expect(marks.scrollTop).toBe(startsAtTop ? 0 : 677);
        expect(marks.querySelectorAll(".chat-position-rail__marker").length).toBeLessThan(50);
        if (scenario === "boot" || scenario === "boot-resize") {
          height = 554;
          marksHeight = 240;
          await flush();
          // The initial observer result can arrive after the composer claims its space.
          publishVisibility(root.querySelector(".chat-bubble")!);
          if (scenario === "boot-resize") {
            height = 543;
            marksHeight = 229;
          }
          await flush();
          expect(marker(79).hasAttribute("data-visible")).toBe(true);
          const initialOffset = scenario === "boot-resize" ? 731 : 720;
          expect(marks.scrollTop).toBe(initialOffset);
          height = 512;
          marksHeight = 198;
          await flush();
          expect(marks.scrollTop).toBe(initialOffset);
        } else if (scenario === "end") {
          // Initial row measurements settle at the end before later composer growth.
          height = 552;
          scrollHeight = 552;
          activeMessage.mockReturnValue("message-4");
          await flush();
          expect(marks.scrollTop).toBe(0);
          height = 452;
          scrollHeight = 486;
          root.scrollTop = 34;
          marksHeight = 47;
          await flush();
          expect(marker(4).getAttribute("aria-current")).toBe("true");
          expect(marks.scrollTop).toBe(0);
        } else if (scenario === "resize-jump") {
          // Initial end navigation can share the frame that reveals the composer.
          height = 554;
          marksHeight = 240;
          root.scrollTop = 8358;
          activeMessage.mockReturnValue("message-79");
          await flush();
          expect(marker(79).getAttribute("aria-current")).toBe("true");
          expect(Number.parseFloat(marker(79).style.top)).toBeGreaterThanOrEqual(marks.scrollTop);
          expect(Number.parseFloat(marker(79).style.top) + 12).toBeLessThanOrEqual(
            marks.scrollTop + marks.clientHeight,
          );
        } else if (scenario === "resize") {
          height = 554;
          marksHeight = 240;
          activeMessage.mockReturnValue("message-76");
          await flush();
          expect(marks.scrollTop).toBe(677);
          root.scrollTop = 8319;
          await flush();
          expect(marks.scrollTop).toBe(677);
          // A second resize retargets the same smooth compensation, including its last 6px.
          height = 512;
          marksHeight = 198;
          await flush();
          for (const offset of [8323, 8394, 8400]) {
            root.scrollTop = offset;
            await flush();
            expect(marks.scrollTop).toBe(677);
          }
          publishTranscriptScroll(root, {
            type: "input",
            event: new WheelEvent("wheel", { deltaY: -200 }),
            touching: false,
          });
          root.scrollTop = 8000;
          activeMessage.mockReturnValue("message-40");
          await flush();
          expect(marks.scrollTop).toBeLessThan(677);
        } else if (scenario === "reader-tabstop") {
          activeMessage.mockReturnValue("message-77");
          publishVisibility(root.querySelector(".chat-bubble")!);
          // Tab can arrive before the scheduled layout frame after visibility changes.
          expect(marker(77).getAttribute("aria-current")).toBe("true");
          expect(marker(77).tabIndex).toBe(0);
          expect(marker(79).tabIndex).toBe(-1);
        } else if (scenario === "focus") {
          marks.scrollTop = 40 * 12 - 100;
          await flush();
          document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
          marker(40).focus();
          expect(marker(40).matches(":focus-visible")).toBe(true);
          await flush();
          expect(Number.parseFloat(marker(40).style.top)).toBeGreaterThanOrEqual(marks.scrollTop);
          expect(Number.parseFloat(marker(40).style.top) + 12).toBeLessThanOrEqual(
            marks.scrollTop + marks.clientHeight,
          );
          const focusedOffset = marks.scrollTop;
          activeMessage.mockReturnValue("message-77");
          await flush();
          expect(document.activeElement).toBe(marker(40));
          expect(marks.scrollTop).toBe(focusedOffset);
          marker(40).blur();
          activeMessage.mockReturnValue("message-79");
          await flush();
          expect(marks.scrollTop).toBe(677);
        } else if (scenario === "focus-resize") {
          document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
          marker(79).focus();
          expect(marker(79).matches(":focus-visible")).toBe(true);
          height = 554;
          marksHeight = 240;
          await flush();
          expect(document.activeElement).toBe(marker(79));
          expect(marks.scrollTop).toBe(720);
        } else if (scenario === "pointer") {
          marker(60).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          marker(60).focus();
          expect(marker(60).matches(":focus-visible")).toBe(false);
          expect(marks.scrollTop).toBe(677);
          activeMessage.mockReturnValue("message-0");
          await flush();
          expect(document.activeElement).toBe(marker(60));
          expect(marks.scrollTop).toBe(0);
        } else {
          height = 554;
          marksHeight = 240;
          await flush();
          expect(marks.scrollTop).toBe(677);
          publishTranscriptScroll(root, {
            type: "input",
            event: new WheelEvent("wheel", { deltaY: 120 }),
            touching: false,
          });
          root.scrollTop = 8319;
          await flush();
          expect(marker(79).getAttribute("aria-current")).toBe("true");
          expect(marks.scrollTop).toBe(720);
        }
      } finally {
        render(nothing, container);
        transcript.hostDisconnected();
      }
    },
  );
});
