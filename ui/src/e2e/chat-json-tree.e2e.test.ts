import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const available = canRunPlaywrightChromium(executablePath);
const suite =
  available || process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
const source = `{
  "example": "Deployment receipt",
  "status": "ready",
  "items": [{"name": "alpha", "enabled": true}, {"name": "beta", "enabled": false}],
  "id": 9007199254740993,
  "status": "verified",
  "escaped": "\\u0061",
  "overflow": 1e400
}`;
let browser: Browser;
let server: ControlUiE2eServer;

suite("Control UI JSON tree and source views", () => {
  beforeAll(async () => {
    if (!available) {
      throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
    }
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each(["dark", "light"] as const)(
    "shares lossless JSON controls for bare messages and fences in %s mode",
    async (theme) => {
      const context = await browser.newContext({
        colorScheme: theme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 1000 },
      });
      const page = await context.newPage();
      const proofDir =
        process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
          ? createControlUiE2eArtifactDir("chat-json-tree")
          : undefined;
      const stage = process.env.OPENCLAW_CODE_FENCE_PROOF_STAGE ?? "after";
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(server.baseUrl).origin,
      });
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: "Inspect this deployment receipt in tree and raw views.",
            timestamp: 1000,
            __openclaw: { id: "json-request", seq: 1 },
          },
          {
            role: "assistant",
            content: source,
            timestamp: 2000,
            __openclaw: { id: "json-bare", seq: 2 },
          },
          {
            role: "user",
            content: "And the same JSON inside a code fence.",
            timestamp: 3000,
            __openclaw: { id: "json-fence-request", seq: 3 },
          },
          {
            role: "assistant",
            content: "```json\n" + source + "\n```",
            timestamp: 4000,
            __openclaw: { id: "json-fenced", seq: 4 },
          },
        ],
      });
      try {
        await page.goto(`${server.baseUrl}chat`);
        const bare = page.locator('[data-entry-id="json-bare"]');
        const fenced = page.locator('[data-entry-id="json-fenced"]');
        await fenced.waitFor({ state: "visible" });
        await page.evaluate((mode) => {
          const root = document.documentElement;
          root.dataset.themeMode = mode;
          root.dataset.themeResolved = mode;
          root.classList.toggle("wa-light", mode === "light");
          root.classList.toggle("wa-dark", mode === "dark");
          root.style.colorScheme = mode;
        }, theme);
        if (proofDir) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(proofDir, `${stage}-${theme}-tree.png`),
          });
        }
        for (const message of [bare, fenced]) {
          const tree = message.locator(".code-block-json-tree");
          await expect.poll(() => tree.count()).toBe(1);
          expect(await tree.isVisible()).toBe(true);
          expect(await tree.textContent()).toContain("9007199254740993");
          expect(await tree.textContent()).toContain("1e400");
          expect(await tree.locator(".code-block-json-key").allTextContents()).toContain(
            '"status"',
          );
          const nested = tree.locator("details").nth(1);
          const initial = await nested.getAttribute("open");
          await nested.locator(":scope > summary").click();
          expect(await nested.getAttribute("open")).not.toBe(initial);
          await message.getByRole("button", { name: "Raw", exact: true }).click();
          expect(await tree.isVisible()).toBe(false);
          expect(await message.locator("pre code").textContent()).toBe(
            source + (message === fenced ? "\n" : ""),
          );
          await message.getByRole("button", { name: "Copy code", exact: true }).click();
          expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
          await message.getByRole("button", { name: "Tree", exact: true }).click();
          expect(await tree.isVisible()).toBe(true);
          expect(await nested.getAttribute("open")).not.toBe(initial);
        }
        await bare.getByRole("button", { name: "Raw", exact: true }).click();
        if (proofDir) {
          await bare.scrollIntoViewIfNeeded();
          await page.screenshot({
            animations: "disabled",
            path: path.join(proofDir, `${stage}-${theme}-raw.png`),
          });
        }
        await page.setViewportSize({ width: 400, height: 900 });
        await bare.getByRole("button", { name: "Tree", exact: true }).click();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true);
        if (proofDir) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(proofDir, `${stage}-${theme}-mobile.png`),
          });
        }
      } finally {
        await context.close();
      }
    },
  );
});
