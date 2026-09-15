import { html, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import "../test-helpers/load-styles.ts";
import { renderSessionLeadingState } from "./session-leading-indicator.ts";
import "./session-owner-chip.ts";

function renderedLuminance(...backgrounds: string[]): number {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  for (const color of backgrounds) {
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
  }
  const channels = context.getImageData(0, 0, 1, 1).data;
  expect(channels[3]).toBe(255);
  return [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
    const value = channels[index]! / 255;
    const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return sum + linear * weight;
  }, 0);
}

function contrastRatio(first: number, second: number): number {
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

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
  it.each(
    ["light", "dark"].flatMap((theme) =>
      [2, 3, 5, 12, 13].flatMap((ownerCount) =>
        ["present", "running", "away", "unread"].map((presence) => ({
          theme,
          ownerCount,
          presence,
        })),
      ),
    ),
  )(
    "keeps $ownerCount owners in an equal pair in $theme while $presence",
    async ({ theme, ownerCount, presence }) => {
      document.documentElement.setAttribute("data-theme-mode", theme);
      const sidebar = document.createElement("aside");
      sidebar.className = "sidebar sidebar-recent-sessions";
      document.body.append(sidebar);
      render(
        html`<div class="sidebar-recent-session">
          <a class="sidebar-recent-session__link">
            <span class="sidebar-session-indicator"
              >${
                renderSessionLeadingState(
                  {
                    key: "agent:main:shared",
                    label: "Shared session",
                    renameValue: "Shared session",
                    active: false,
                    visuallyActive: false,
                    hasActiveRun: presence === "running",
                    modelSelectionLocked: false,
                    pinned: false,
                    pinnable: true,
                    cloudWorkerStopAction: null,
                    hasAutomation: false,
                    unread: presence === "unread",
                    attention: { kind: "none" },
                    childSessionKeys: [],
                    children: [],
                    isChild: false,
                    loadingChildren: false,
                    containsActiveDescendant: false,
                    runningChildCount: 0,
                    failedChildCount: 0,
                    participants: [
                      { identity: { type: "profile", id: "profile-bob" }, label: "Bob" },
                    ],
                    participantCount: ownerCount - 1,
                  },
                  {
                    type: "human",
                    id: "profile-ada",
                    identity: { type: "profile", id: "profile-ada" },
                    label: "Ada",
                  },
                  "owned",
                  presence === "away" ? false : undefined,
                ).leadingIndicator
              }</span
            >
            <span class="sidebar-recent-session__title">Shared session</span>
          </a>
        </div>`,
        sidebar,
      );
      const row = sidebar.querySelector<HTMLElement>(".sidebar-recent-session")!;
      // Contrast is measured at each interaction endpoint, outside its transition.
      row.style.transition = "none";
      const chip = sidebar.querySelector("openclaw-session-owner-chip")!;
      await chip.updateComplete;
      await Promise.all(
        [...chip.querySelectorAll("openclaw-viewer-avatar")].map((avatar) => avatar.updateComplete),
      );
      const stack = chip.querySelector<HTMLElement>(".session-owner-stack")!;
      const primary = chip.querySelector<HTMLElement>(".session-owner-stack__front")!;
      const peer = chip.querySelector<HTMLElement>(
        ownerCount === 2
          ? ".session-owner-stack__back .viewer-avatar"
          : ".session-owner-stack__overflow",
      )!;
      expect(primary.getAttribute("aria-label")).toBe("Owned by Ada");
      expect(primary.textContent?.trim()).toBe("A");
      expect(stack.getAttribute("aria-label")).toBe(
        ownerCount === 2 ? "Owned by Ada · with Bob" : `Owned by Ada · +${ownerCount - 1} more`,
      );
      for (const state of ["idle", "hover", "active", "selected"]) {
        await userEvent.unhover(row);
        if (state === "hover") {
          await userEvent.hover(row);
        }
        row.classList.toggle("sidebar-recent-session--active", state === "active");
        row.classList.toggle("sidebar-recent-session--selected", state === "selected");
        expect(row.matches(":hover")).toBe(state === "hover");
        const primaryBounds = primary.getBoundingClientRect();
        const peerBounds = peer.getBoundingClientRect();
        const stackBounds = stack.getBoundingClientRect();
        expect([stackBounds.width, stackBounds.height]).toEqual([28, 20]);
        for (const bounds of [primaryBounds, peerBounds]) {
          expect([bounds.width, bounds.height]).toEqual([18, 18]);
          expect(bounds.top).toBe(stackBounds.top + 1);
          expect(bounds.left).toBeGreaterThanOrEqual(stackBounds.left);
          expect(bounds.right).toBeLessThanOrEqual(stackBounds.right);
        }
        expect(Math.abs(primaryBounds.left - peerBounds.left)).toBe(10);
        expect(
          Math.min(primaryBounds.right, peerBounds.right) -
            Math.max(primaryBounds.left, peerBounds.left),
        ).toBe(8);
        expect(getComputedStyle(primary).fontSize).toBe(getComputedStyle(peer).fontSize);
        const primaryFace = primary.querySelector<HTMLElement>(".viewer-avatar > span")!;
        const paintedPrimary = primaryFace.getBoundingClientRect();
        expect([paintedPrimary.width, paintedPrimary.height]).toEqual([16, 16]);
        expect(getComputedStyle(primary).opacity).toBe(presence === "away" ? "0.45" : "1");
        expect(getComputedStyle(peer).opacity).toBe("1");
        if (presence === "running") {
          const traceBounds = row.querySelector(".session-glyph__trace")!.getBoundingClientRect();
          expect(traceBounds.left).toBe(stackBounds.left - 2);
          expect(traceBounds.right).toBe(stackBounds.right + 2);
        }
        if (presence === "unread") {
          const badge = row.querySelector(".session-glyph__badge--unread")!;
          const badgeBounds = badge.getBoundingClientRect();
          for (const fraction of [0.5, 0.75]) {
            expect(
              document.elementFromPoint(
                badgeBounds.left + badgeBounds.width / 2,
                badgeBounds.top + badgeBounds.height * fraction,
              ),
            ).toBe(badge);
          }
        }
        if (ownerCount === 2) {
          expect(peerBounds.left).toBe(stackBounds.left);
          const paintedPeer = peer.querySelector("span")!.getBoundingClientRect();
          expect([paintedPeer.width, paintedPeer.height]).toEqual([
            paintedPrimary.width,
            paintedPrimary.height,
          ]);
          continue;
        }
        expect(primaryBounds.left).toBe(stackBounds.left);
        expect(peerBounds.right).toBe(stackBounds.right);
        expect(peer.textContent).toBe(`+${ownerCount - 1}`);
        const textRange = document.createRange();
        textRange.selectNodeContents(peer);
        const textBounds = textRange.getBoundingClientRect();
        expect(textBounds.left).toBeGreaterThanOrEqual(peerBounds.left + 1);
        expect(textBounds.right).toBeLessThanOrEqual(peerBounds.right - 1);
        for (const x of [textBounds.left + 0.5, textBounds.right - 0.5]) {
          expect(
            peer.contains(document.elementFromPoint(x, textBounds.top + textBounds.height / 2)),
          ).toBe(true);
        }
        const style = getComputedStyle(peer);
        expect(style.borderTopWidth).toBe("1px");
        const rowBackground = [
          getComputedStyle(sidebar).backgroundColor,
          getComputedStyle(row).backgroundColor,
        ];
        const rowLuminance = renderedLuminance(...rowBackground);
        const counterLuminance = renderedLuminance(...rowBackground, style.backgroundColor);
        const textLuminance = renderedLuminance(
          ...rowBackground,
          style.backgroundColor,
          style.color,
        );
        expect(
          contrastRatio(counterLuminance, rowLuminance),
          `${theme} ${state} surface`,
        ).toBeGreaterThanOrEqual(1.3);
        expect(
          contrastRatio(textLuminance, counterLuminance),
          `${theme} ${state} text`,
        ).toBeGreaterThanOrEqual(4.5);
      }
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
