import { html, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import "../test-helpers/load-styles.ts";
import { renderSessionGlyph } from "./session-glyph.ts";
import "./session-owner-chip.ts";

const originalTheme = document.documentElement.getAttribute("data-theme-mode");
const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

afterEach(() => {
  document.body.replaceChildren();
  if (originalTheme === null) {
    document.documentElement.removeAttribute("data-theme-mode");
  } else {
    document.documentElement.setAttribute("data-theme-mode", originalTheme);
  }
});

async function mountOwnerChip(params: {
  participants?: readonly SessionParticipant[];
  participantCount?: number;
}) {
  const chip = document.createElement("openclaw-session-owner-chip");
  chip.owner = { type: "human", id: "profile-ada", label: "Ada" };
  chip.size = "row";
  chip.participants = params.participants ?? [];
  chip.participantCount = params.participantCount ?? chip.participants.length;
  document.body.append(chip);
  await chip.updateComplete;
  return chip;
}

describe.skipIf(!hasBrowserLayout)("session owner stack layout", () => {
  it.each([
    {
      backSelector: ".session-owner-stack__back .viewer-avatar",
      name: "one participant avatar",
      participantCount: 1,
      participants: [{ identity: { type: "profile" as const, id: "profile-bob" }, label: "Bob" }],
    },
  ])("keeps $name legible as an equal peer behind the owner", async (fixture) => {
    const chip = await mountOwnerChip(fixture);
    const stack = chip.querySelector<HTMLElement>(".session-owner-stack");
    const back = chip.querySelector<HTMLElement>(fixture.backSelector);
    const front = chip.querySelector<HTMLElement>(".session-owner-stack__front");
    if (!stack || !back || !front) {
      throw new Error("expected complete session owner stack");
    }

    const stackBounds = stack.getBoundingClientRect();
    const backBounds = back.getBoundingClientRect();
    const frontBounds = front.getBoundingClientRect();
    expect({
      backSize: [backBounds.width, backBounds.height],
      frontSize: [frontBounds.width, frontBounds.height],
      stackSize: [stackBounds.width, stackBounds.height],
    }).toEqual({
      backSize: [18, 18],
      frontSize: [18, 18],
      stackSize: [28, 20],
    });
    expect(backBounds.right - frontBounds.left).toBe(8);
    expect(frontBounds.left - backBounds.left).toBe(10);
  });

  it.each(
    ["light", "dark"].flatMap((theme) =>
      [2, 4, 12].map((participantCount) => ({ theme, participantCount })),
    ),
  )(
    "shows the primary owner beside all $participantCount others in $theme",
    async ({ theme, participantCount }) => {
      document.documentElement.setAttribute("data-theme-mode", theme);
      const sidebar = document.createElement("aside");
      sidebar.className = "sidebar sidebar-recent-sessions";
      document.body.append(sidebar);
      render(
        html`<div class="sidebar-recent-session">
          <a class="sidebar-recent-session__link">
            <span class="sidebar-session-indicator"
              >${renderSessionGlyph({
                content: html`<openclaw-session-owner-chip></openclaw-session-owner-chip>`,
                running: true,
                circular: true,
                ring: "pair",
              })}</span
            >
            <span class="sidebar-recent-session__title">Shared session</span>
          </a>
        </div>`,
        sidebar,
      );
      const row = sidebar.querySelector<HTMLElement>(".sidebar-recent-session")!;
      const chip = sidebar.querySelector("openclaw-session-owner-chip")!;
      chip.owner = { type: "human", id: "profile-ada", label: "Ada" };
      chip.attribution = "owned";
      chip.participants = [{ identity: { type: "profile", id: "profile-bob" }, label: "Bob" }];
      chip.participantCount = participantCount;
      chip.viewingNow = false;
      await chip.updateComplete;
      const front = chip.querySelector<HTMLElement>(".session-owner-stack__front")!;
      const counter = chip.querySelector<HTMLElement>(".session-owner-stack__overflow")!;
      expect(front.getAttribute("aria-label")).toBe("Owned by Ada");
      expect(front.textContent?.trim()).toBe("A");
      expect(chip.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe(
        `Owned by Ada · +${participantCount} more`,
      );
      expect(counter.textContent).toBe(`+${participantCount}`);
      const frontBounds = front.getBoundingClientRect();
      const counterBounds = counter.getBoundingClientRect();
      const traceBounds = row.querySelector(".session-glyph__trace")!.getBoundingClientRect();
      expect(frontBounds.left).toBe(
        row.querySelector(".sidebar-session-indicator")!.getBoundingClientRect().left,
      );
      expect(counterBounds.left).toBeGreaterThanOrEqual(frontBounds.right);
      expect(counterBounds.left).toBeGreaterThan(traceBounds.right + 0.75);
      expect(counterBounds.right).toBeLessThanOrEqual(
        row.querySelector(".sidebar-recent-session__title")!.getBoundingClientRect().left,
      );
      const textRange = document.createRange();
      textRange.selectNodeContents(counter);
      const textBounds = textRange.getBoundingClientRect();
      expect(textBounds.left).toBeGreaterThanOrEqual(counterBounds.left);
      expect(textBounds.right).toBeLessThanOrEqual(counterBounds.right);
      expect(Number.parseFloat(getComputedStyle(counter).fontSize)).toBeGreaterThanOrEqual(10);
      expect(getComputedStyle(front).opacity).toBe("0.45");
      expect(getComputedStyle(counter).opacity).toBe("1");
      for (const state of ["idle", "hover", "active", "selected"]) {
        await userEvent.unhover(row);
        if (state === "hover") {
          await userEvent.hover(row);
        }
        row.classList.toggle("sidebar-recent-session--active", state === "active");
        row.classList.toggle("sidebar-recent-session--selected", state === "selected");
        expect(row.matches(":hover")).toBe(state === "hover");
        const style = getComputedStyle(counter);
        const luminances = [style.color, style.backgroundColor].map((color) => {
          const channels = color.match(/^rgb\((\d+), (\d+), (\d+)\)$/u);
          if (!channels) {
            throw new Error(`Expected opaque sRGB color, got ${color}`);
          }
          return channels.slice(1).reduce((sum, channel, index) => {
            const value = Number(channel) / 255;
            const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
          }, 0);
        });
        expect(
          (Math.max(...luminances) + 0.05) / (Math.min(...luminances) + 0.05),
        ).toBeGreaterThanOrEqual(4.5);
      }
      chip.participantCount = 0;
      await chip.updateComplete;
      expect(chip.querySelector(".session-owner-chip")!.getBoundingClientRect().left).toBe(
        frontBounds.left,
      );
    },
  );

  it("keeps the single-owner row avatar at its established size", async () => {
    const chip = await mountOwnerChip({});
    const owner = chip.querySelector<HTMLElement>(".session-owner-chip--row");
    if (!owner) {
      throw new Error("expected single owner row avatar");
    }
    const bounds = owner.getBoundingClientRect();
    expect([bounds.width, bounds.height]).toEqual([20, 20]);
    expect(chip.querySelector(".session-owner-stack")).toBeNull();
  });

  it.each(
    ["light", "dark"].flatMap((theme) =>
      [0, 1, 2].map((participantCount) => ({ theme, participantCount })),
    ),
  )(
    "uses a thin cutout only for stacked owners in $theme with $participantCount participants",
    async ({ theme, participantCount }) => {
      document.documentElement.setAttribute("data-theme-mode", theme);
      const sidebar = document.createElement("aside");
      sidebar.className = "sidebar";
      document.body.append(sidebar);
      const chip = await mountOwnerChip({
        participantCount,
        participants: [{ identity: { type: "profile", id: "profile-bob" }, label: "Bob" }],
      });
      const row = document.createElement("div");
      row.className = "sidebar-recent-session";
      row.style.transition = "none";
      sidebar.append(row);
      row.append(chip);
      const front = chip.querySelector<HTMLElement>(".session-owner-chip")!;
      if (participantCount === 0) {
        expect(getComputedStyle(front).borderTopWidth).toBe("0px");
        expect(getComputedStyle(front).boxShadow).toBe("none");
        return;
      }
      const stack = chip.querySelector<HTMLElement>(".session-owner-stack")!;
      for (const selected of [false, true]) {
        row.classList.toggle("sidebar-recent-session--selected", selected);
        await expect
          .poll(() =>
            [getComputedStyle(stack, "::before"), getComputedStyle(stack, "::after")].map(
              (cutout) => ({
                width: cutout.borderTopWidth,
                matchesRow: cutout.borderTopColor === getComputedStyle(row).backgroundColor,
              }),
            ),
          )
          .toEqual([
            { width: "1px", matchesRow: true },
            { width: "1px", matchesRow: true },
          ]);
      }
    },
  );
});
