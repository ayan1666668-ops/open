import { expect, it } from "vitest";
import {
  installMockGateway,
  startControlUiE2eServer,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Settings community links",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it.each([true, false])(
    "respects the serving Gateway community flag (%s)",
    async (communityInvite) => {
      await suite.withPage({ viewport: { width: 1280, height: 640 } }, async ({ page }) => {
        await installMockGateway(page, { communityInvite, communityInviteDismissed: true });
        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        await waitForControlUiRoute(page, {
          pathname: "/settings/appearance",
          routeId: "appearance",
        });
        const nav = page.locator(".settings-sidebar__nav");
        const about = nav.getByRole("link", { name: "About", exact: true });
        await about.waitFor();
        const links = nav.locator('a[target="_blank"]');
        await expect.poll(() => links.count()).toBe(communityInvite ? 3 : 0);
        if (!communityInvite) {
          expect(await nav.getByText("Community", { exact: true }).count()).toBe(0);
          return;
        }
        expect(await nav.getByText("Community", { exact: true }).count()).toBe(1);
        await about.focus();
        const destinations = [
          ["X", "https://x.com/openclaw"],
          ["Discord", "https://discord.com/invite/clawd"],
          ["Reddit", "https://www.reddit.com/r/openclaw/"],
        ];
        for (const [name, href] of destinations) {
          const link = nav.getByRole("link", { name, exact: true });
          expect(await link.getAttribute("href")).toBe(href);
          expect(await link.getAttribute("aria-label")).toBe(name);
          expect((await link.getAttribute("rel"))?.split(/\s+/)).toContain("noopener");
          expect(await link.locator("svg").count()).toBe(1);
          await page.keyboard.press("Tab");
          expect(await link.evaluate((element) => element === document.activeElement)).toBe(true);
        }
        expect(await nav.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        const bounds = await nav.boundingBox();
        const last = await links.last().boundingBox();
        // Native scrolling rounds the fractional end position to a CSS pixel.
        expect(Math.round(last!.y + last!.height)).toBeLessThanOrEqual(
          Math.round(bounds!.y + bounds!.height),
        );
        await page.keyboard.press("Shift+Tab");
        expect(
          await nav
            .getByRole("link", { name: "Discord", exact: true })
            .evaluate((element) => element === document.activeElement),
        ).toBe(true);
      });
    },
  );
});
