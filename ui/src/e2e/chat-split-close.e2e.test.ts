import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Closing distinct split conversations" });
const survivorKey = "agent:main:session-a";
const closedKey = "agent:main:session-b";

suite.define(() => {
  it.each([1440, 390])(
    "keeps the survivor without loading the closed conversation at %dpx",
    async (width) => {
      await suite.withPage(
        { viewport: { width: 1440, height: 900 }, locale: "en-US", serviceWorkers: "block" },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            sessionKey: survivorKey,
            sessions: [survivorKey, closedKey].map((key, index) => ({
              key,
              kind: "direct",
              label: `Conversation ${index === 0 ? "A" : "B"}`,
              updatedAt: 2 - index,
            })),
            historyMessages: [{ role: "assistant", content: "Split conversation continuity." }],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, survivorKey));
          const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
          await composer.fill("Keep this unfinished message.");
          const original = await page.locator("openclaw-chat-pane").elementHandle();
          expect(original).not.toBeNull();
          await page.getByRole("button", { name: "Open split view", exact: true }).click();
          await expect.poll(() => page.locator(".chat-split-view__cell").count()).toBe(2);
          await page
            .locator(
              `.sidebar-recent-session[data-session-key="${closedKey}"] a.sidebar-recent-session__link`,
            )
            .click();
          const active = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
          await expect
            .poll(() =>
              active.evaluate((pane: HTMLElement & { sessionKey?: string }) => pane.sessionKey),
            )
            .toBe(closedKey);
          await gateway.waitForRequest("sessions.messages.subscribe", {
            match: { key: closedKey },
          });
          const startups = await gateway.getRequests("chat.startup", { sessionKey: closedKey });
          const subscriptions = await gateway.getRequests("sessions.messages.subscribe", {
            key: closedKey,
          });
          await page.setViewportSize({ width, height: 900 });
          await active.getByRole("button", { name: "Close pane", exact: true }).click();
          await expect
            .poll(() =>
              active.evaluate((pane: HTMLElement & { sessionKey?: string }) => pane.sessionKey),
            )
            .toBe(survivorKey);
          // A briefly admitted closed session remains in retention even after the route settles.
          expect(await page.locator("openclaw-chat-pane").count()).toBe(1);
          expect(await active.evaluate((pane, previous) => pane === previous, original)).toBe(true);
          expect(
            await active.getByRole("textbox", { name: "Chat composer", exact: true }).inputValue(),
          ).toBe("Keep this unfinished message.");
          expect(await gateway.getRequests("chat.startup", { sessionKey: closedKey })).toHaveLength(
            startups.length,
          );
          expect(
            await gateway.getRequests("sessions.messages.subscribe", { key: closedKey }),
          ).toHaveLength(subscriptions.length);
          await original?.dispose();
        },
      );
    },
  );
});
