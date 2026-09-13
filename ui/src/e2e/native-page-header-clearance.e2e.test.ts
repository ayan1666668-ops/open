// Native macOS hosts put the traffic lights and hosted titlebar buttons over
// the top-left of the content column once the sidebar collapses. Page headers
// there work like a native toolbar: actions ride in the titlebar row, the
// title sits below it aligned with the page content.
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI native page header clearance E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const proofDirParent = process.env.OPENCLAW_UI_RAIL_PROOF_DIR?.trim();
let proofDir: string | undefined;
let context: BrowserContext | undefined;
beforeEach(() => {
  proofDir = proofDirParent
    ? createControlUiE2eArtifactDir("native-page-header-clearance", proofDirParent)
    : undefined;
});

suite.define(() => {
  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  async function openAgentsPage(install: (page: Page) => Promise<void>): Promise<Page> {
    context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await install(page);
    await installMockGateway(page);
    await page.goto(`${suite.server.baseUrl}agents`);
    await page.locator(".content .content-header .page-title").waitFor({ state: "visible" });
    return page;
  }

  async function expectCollapsed(page: Page): Promise<void> {
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--nav-collapsed");
  }

  it("moves the title below the web titlebar and lifts actions into it", async () => {
    const page = await openAgentsPage(installNativeWebChrome);
    const toolbar = page.locator(".macos-titlebar-controls");
    await toolbar.getByRole("button", { name: "Collapse sidebar" }).click();
    await expectCollapsed(page);
    const header = page.locator(".content .content-header").first();
    if (proofDir) {
      await page.screenshot({
        animations: "disabled",
        path: path.join(proofDir, "native-web-collapsed-page-header.png"),
      });
    }
    const toolbarBox = await toolbar.boundingBox();
    expect(toolbarBox).not.toBeNull();
    expect(toolbarBox!.y + toolbarBox!.height).toBe(52);
    await expect
      .poll(async () => (await header.locator(".page-title").boundingBox())?.y ?? -1)
      .toBeGreaterThanOrEqual(52);
    // The header padding transitions after the collapse, so poll the geometry.
    const toolbarCenter = toolbarBox!.y + toolbarBox!.height / 2;
    await expect
      .poll(() =>
        header.locator(".page-header-actions .btn").evaluateAll((buttons, center) => {
          if (buttons.length === 0) {
            return Number.POSITIVE_INFINITY;
          }
          return Math.max(
            ...buttons.map((button) => {
              const box = button.getBoundingClientRect();
              return box.top < 0
                ? Number.POSITIVE_INFINITY
                : Math.abs(box.top + box.height / 2 - center);
            }),
          );
        }, toolbarCenter),
      )
      .toBeLessThanOrEqual(0.5);
  });

  it("keeps the title below the legacy Mac app's lowered web controls", async () => {
    // Older apps stamp only openclaw-native-macos and keep the in-page
    // cluster, which drops below the drag region instead of into a titlebar.
    const page = await openAgentsPage((target) =>
      target.addInitScript(() => {
        const stamp = () => document.documentElement.classList.add("openclaw-native-macos");
        if (document.documentElement) {
          stamp();
        } else {
          document.addEventListener("DOMContentLoaded", stamp);
        }
      }),
    );
    await page.locator(".sidebar-brand__collapse").click();
    await expectCollapsed(page);
    const controlsBottom = await page
      .locator(".shell-chrome-controls")
      .evaluate((element) => element.getBoundingClientRect().bottom);
    expect(controlsBottom).toBeGreaterThan(52);
    await expect
      .poll(
        async () =>
          (await page.locator(".content .content-header .page-title").boundingBox())?.y ?? -1,
      )
      .toBeGreaterThanOrEqual(controlsBottom);
  });
});
