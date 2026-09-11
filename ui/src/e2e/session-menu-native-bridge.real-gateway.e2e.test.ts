import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { appendTranscriptMessage } from "../../../src/config/sessions/session-accessor.js";
import { createOpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { openSessionMenuSubmenu } from "./session-management.test-support.ts";

type NativeLinkPost = { type: string; url: string; target: string };

declare global {
  interface Window {
    nativeLinkProof?: {
      posts: NativeLinkPost[];
      windowOpenCalls: string[];
    };
  }
}

const gatewayToken = "session-menu-native-bridge-proof";

const suite = createControlUiE2eSuite({
  name: "Control UI session menu native link bridge with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

suite.define(() => {
  it(
    "hands session New window and New tab to the native link bridge instead of a popup",
    { timeout: 300_000 },
    async () => {
      const owner = await createOpenClawTestInstance({
        name: "session-menu-native-bridge",
        gatewayToken,
        config: { gateway: { controlUi: { enabled: false } } },
      });
      try {
        const config = JSON.parse(await readFile(owner.configPath, "utf8")) as Record<
          string,
          unknown
        >;
        await owner.state.writeConfig({
          ...config,
          agents: {
            defaults: {
              workspace: owner.state.workspaceDir,
              model: { primary: "openai/gpt-5.6-luna" },
            },
            entries: {
              main: { identity: { name: "Bridge Proof" } },
            },
          },
        });
        await owner.startGateway();

        const sessionKey = "agent:main:native-bridge-proof";
        const label = "Native bridge proof";
        const created = await owner.cli([
          "gateway",
          "call",
          "sessions.create",
          "--params",
          JSON.stringify({ key: sessionKey, agentId: "main", label }),
          "--json",
        ]);
        expect(created.code, created.stderr).toBe(0);
        const session = JSON.parse(created.stdout) as { ok: boolean; sessionId: string };
        expect(session.ok).toBe(true);
        const reply = "The native link bridge opens this session route.";
        await appendTranscriptMessage(
          { agentId: "main", sessionKey, sessionId: session.sessionId, env: owner.env },
          {
            message: {
              role: "assistant",
              content: [{ type: "text", text: reply }],
              timestamp: Date.now(),
            },
          },
        );

        const expectedSessionUrl = controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat");

        await suite.withPage(
          { locale: "en-US", viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
          async ({ context, page }) => {
            // Stand in for the WKWebView host contract the macOS shell installs
            // before any page script runs: record openclawLink posts, observe
            // window.open reservations, and open posted links in a new tab the
            // way the native receiver opens the default browser.
            await page.addInitScript(() => {
              const posts: Array<{ type: string; url: string; target: string }> = [];
              const windowOpenCalls: string[] = [];
              const open = window.open.bind(window);
              Object.defineProperty(window, "nativeLinkProof", {
                value: { posts, windowOpenCalls },
                configurable: true,
              });
              window.open = (...args: Parameters<typeof open>) => {
                windowOpenCalls.push(String(args[0] ?? ""));
                return open(...args);
              };
              Object.defineProperty(window, "webkit", {
                value: {
                  messageHandlers: {
                    openclawLink: {
                      postMessage(message: { type: string; url: string; target: string }) {
                        posts.push(message);
                        open(message.url, "_blank");
                      },
                    },
                  },
                },
                configurable: true,
              });
            });
            const popups: Page[] = [];
            context.on("page", (popup) => {
              popups.push(popup);
            });

            const url = new URL(expectedSessionUrl);
            url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${owner.port}`);
            url.hash = `token=${encodeURIComponent(gatewayToken)}`;
            expect((await page.goto(url.toString()))?.status()).toBe(200);
            const confirmation = page.locator("openclaw-gateway-url-confirmation");
            await confirmation.waitFor({ timeout: 15_000 });
            await confirmation
              .getByRole("button", { name: `Switch to 127.0.0.1:${owner.port}`, exact: true })
              .click();
            await waitForControlUiGatewayReady(page);
            await page.getByText(reply, { exact: true }).waitFor();

            const activePane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
            const menuTrigger = activePane.getByRole("button", { name: `Actions for ${label}` });
            await expect.poll(() => menuTrigger.getAttribute("aria-expanded")).toBe("false");

            const nativePosts = () => page.evaluate(() => window.nativeLinkProof?.posts ?? []);
            const windowOpenCalls = () =>
              page.evaluate(() => window.nativeLinkProof?.windowOpenCalls ?? []);

            const expectedPost = { type: "open-link", url: expectedSessionUrl, target: "external" };

            for (const action of ["New window", "New tab"] as const) {
              await menuTrigger.click();
              await openSessionMenuSubmenu(page, "Open in");
              await page.getByRole("menuitem", { name: action, exact: true }).click();

              // The action posts the final session URL to the native bridge...
              await expect
                .poll(async () => (await nativePosts()).at(-1), { timeout: 10_000 })
                .toEqual(expectedPost);
              // ...without reserving an about:blank popup or showing the
              // blocked-popup toast that a WKWebView host cannot satisfy.
              expect(await windowOpenCalls()).toEqual([]);
              expect(
                await page.getByText("Allow pop-ups for this site, then try again.").count(),
              ).toBe(0);
            }
            // Both actions handed the same session destination to the bridge.
            expect(await nativePosts()).toEqual([expectedPost, expectedPost]);

            // The bridge-opened destination loads the intended session route.
            await expect.poll(() => popups.length, { timeout: 10_000 }).toBeGreaterThan(0);
            const popup = popups.at(-1)!;
            await popup.waitForLoadState("domcontentloaded");
            await waitForControlUiGatewayReady(popup);
            const expectedDestination =
              new URL(expectedSessionUrl).pathname + new URL(expectedSessionUrl).search;
            await expect
              .poll(() => new URL(popup.url()).pathname + new URL(popup.url()).search)
              .toBe(expectedDestination);
            await popup.getByText(reply, { exact: true }).waitFor({ timeout: 15_000 });
          },
        );
      } finally {
        await owner.cleanup();
      }
    },
  );
});
