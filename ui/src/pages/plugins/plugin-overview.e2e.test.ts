import { afterAll, beforeAll, expect, it } from "vitest";
import type { PluginDiscoveryDetailResult } from "../../lib/plugins/index.ts";
import {
  calendarInspection,
  calendarPlugin,
  captureScreenshot,
  describeControlUiE2e,
  installMockGateway,
  inventory,
  newContext,
  pluginMethodResponses,
  pluginMethods,
  server,
  setupPluginsE2e,
  teardownPluginsE2e,
} from "./plugins.e2e.test-support.ts";

describeControlUiE2e("Plugin overview", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it("keeps catalog identity while presenting installed controls, complete content, and a contained metadata rail", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const description =
      "Search previous calendar entries. This complete description explains every supported query and return value.\n\n".repeat(
        35,
      ) + "TOOL_DESCRIPTION_TAIL";
    const catalog: PluginDiscoveryDetailResult = {
      plugin: {
        id: "ch_Y2FsZW5kYXI",
        catalog: {
          name: calendarPlugin.name,
          official: false,
          categories: ["tools"],
          downloads: 404,
        },
        local: {
          present: true,
          installed: true,
          enabled: true,
          state: "enabled",
          pluginId: calendarPlugin.id,
          action: "manage",
        },
      },
      detail: {
        origin: "clawhub",
        packageName: "@acme/calendar",
        author: { handle: "acme", displayName: "Acme", official: true },
        topics: [],
        readme: `# Calendar guide\n\n${"A complete guide to calendar search.\n\n".repeat(80)}README_TAIL`,
        repositoryUrl: "git+https://github.com/Acme/calendar.git",
        documentationUrl: "https://example.com/calendar/docs",
        configuration: [],
        mcpServers: [],
        skills: [],
        versions: [],
        security: {
          status: "clean",
          verdict: "review",
          auditUrl: "https://clawhub.ai/acme/plugins/calendar/security-audit?version=1.0",
        },
      },
    };
    await installMockGateway(page, {
      featureMethods: [...pluginMethods, "tools.catalog"],
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.list": inventory([calendarPlugin]),
        "plugins.catalog.get": catalog,
        "plugins.inspect": { ...calendarInspection, catalog },
        "tools.catalog": {
          agentId: "main",
          profiles: [],
          groups: [
            {
              id: "plugin:calendar-plus",
              label: "Calendar",
              source: "plugin",
              pluginId: calendarPlugin.id,
              tools: [
                {
                  id: "calendar_search",
                  label: "Calendar search",
                  description: "Search previous entries.",
                  fullDescription: description,
                  source: "plugin",
                  pluginId: calendarPlugin.id,
                  defaultProfiles: [],
                },
              ],
            },
          ],
        },
      },
    });
    try {
      await page.goto(`${server.baseUrl}plugins/ch_Y2FsZW5kYXI`);
      await page.getByRole("button", { name: "Reload Calendar Plus", exact: true }).waitFor();
      expect(new URL(page.url()).pathname).toBe("/plugins/ch_Y2FsZW5kYXI");
      expect(await page.locator(".plugin-catalog-detail [role=tablist]").count()).toBe(0);
      expect(
        await page.getByRole("link", { name: "@acme", exact: true }).getAttribute("href"),
      ).toBe("https://clawhub.ai/acme");
      expect(await page.locator(".plugin-catalog-detail__security .is-filled").count()).toBe(2);
      expect(await page.locator(".plugin-metadata__repository").textContent()).toContain(
        "Acme/calendar",
      );
      expect(await page.locator(".plugin-catalog-detail__readme").textContent()).toContain(
        "README_TAIL",
      );
      await page.getByRole("button", { name: /calendar_search/ }).click();
      await page.getByRole("dialog", { name: "calendar_search" }).waitFor();
      expect(await page.locator(".plugin-tool-preview p").textContent()).toBe(description);
      await captureScreenshot(page, "overview-tool.png", "viewport");
      await page.setViewportSize({ width: 393, height: 852 });
      const modalBounds = await page.locator(".plugin-tool-preview").boundingBox();
      expect(modalBounds!.height).toBeLessThanOrEqual(804);
      await page.locator(".plugin-tool-preview p").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await captureScreenshot(page, "overview-tool-mobile.png", "viewport");
      await page.getByRole("button", { name: "Close", exact: true }).click();
      for (const width of [1440, 900, 393]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
        ).toBeLessThanOrEqual(1);
        await captureScreenshot(page, `overview-${width}.png`);
      }
      await page
        .locator(".plugin-catalog-detail__actions")
        .getByRole("link", { name: "Settings", exact: true })
        .click();
      await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("settings");
      expect(new URL(page.url()).pathname).toBe("/plugins/ch_Y2FsZW5kYXI");
    } finally {
      await context.close();
    }
  });
});
