import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { pluginResponses } from "./plugins-settings-admin.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Plugin settings keyboard dismissal" });

suite.define(() => {
  it.each(["trigger", "item"])(
    "dismisses the settings menu from its %s before leaving the detail",
    async (focus) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.read", "operator.admin"],
          methodResponses: pluginResponses(),
        });
        const settingsUrl = `${suite.server.baseUrl}settings/plugins/workboard?view=settings`;
        await page.goto(settingsUrl);
        const heading = page.getByRole("heading", { name: "Workboard settings", exact: true });
        await heading.waitFor();
        const trigger = page.getByRole("button", { name: "Actions for Workspace label" });
        await trigger.click();
        const item = page.getByRole("menuitem", { name: "Reset value", exact: true });
        await item.waitFor();
        if (focus === "trigger") {
          await trigger.focus();
        } else {
          await item.focus();
        }
        await page.keyboard.press("Escape");
        if (process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, `escape-${focus}.png`),
            animations: "disabled",
            caret: "hide",
          });
        }
        expect(page.url()).toBe(settingsUrl);
        await expect.poll(() => item.isVisible()).toBe(false);
        await expect
          .poll(() => trigger.evaluate((element) => element === document.activeElement))
          .toBe(true);
        expect(await gateway.getRequests("config.set")).toHaveLength(0);

        // Once the menu closes, Escape still belongs to the page and returns
        // to the installed list rather than exiting the entire Settings workspace.
        await page.keyboard.press("Escape");
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/plugins");
        await page.getByRole("heading", { name: "Plugins", exact: true }).waitFor();
      });
    },
  );
});
