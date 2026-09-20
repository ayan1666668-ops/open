import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Gateway status with native account identity" });

async function connectionStatusOverlapsComposer(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const statusBounds = document
      .querySelector(".shell-connection-status")!
      .getBoundingClientRect();
    const composerBounds = document
      .querySelector(".agent-chat__composer-shell")!
      .getBoundingClientRect();
    return (
      statusBounds.left < composerBounds.right &&
      statusBounds.right > composerBounds.left &&
      statusBounds.top < composerBounds.bottom &&
      statusBounds.bottom > composerBounds.top
    );
  });
}

suite.define(() => {
  it("keeps connection recovery available when the hidden sidebar chunk fails to load", async () => {
    await suite.withPage(
      {
        viewport: { width: 390, height: 844 },
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        let blockedSidebarRequests = 0;
        await page.route(/\/assets\/app-sidebar-[^/]+\.js(?:\?.*)?$/u, async (route) => {
          blockedSidebarRequests += 1;
          await route.abort("failed");
        });
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}new`);
        await waitForControlUiGatewayReady(page);
        await page.locator(".new-session-page__message").waitFor({ state: "visible" });
        await expect.poll(() => blockedSidebarRequests).toBeGreaterThan(0);
        expect(await page.locator(".sidebar-identity-card").isVisible()).toBe(false);

        await gateway.setOnline(false);
        const connectionStatus = page.locator(".shell-connection-status");
        await connectionStatus
          .locator(".gateway-status__label")
          .getByText("Reconnecting…", { exact: true })
          .waitFor({ state: "visible" });
        const socketCount = await gateway.getSocketCount();
        await connectionStatus.getByRole("button", { name: /Retry now/ }).click();
        await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
        await gateway.setOnline(true);
        await waitForControlUiGatewayReady(page);
        await expect.poll(() => connectionStatus.count()).toBe(0);
      },
    );
  });

  it("keeps reconnect status clear of the composer in a compact native window", async () => {
    await suite.withPage(
      {
        viewport: { width: 1000, height: 900 },
        locale: "en-US",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        await installNativeWebChrome(page);
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiGatewayReady(page);
        await page.locator(".agent-chat__composer-combobox textarea").waitFor({ state: "visible" });
        await gateway.emitGatewayEvent("ui.command", {
          command: { kind: "sidebar", visible: false },
        });
        await page.locator(".shell--nav-collapsed").waitFor({ state: "visible" });
        await gateway.setOnline(false);
        await page
          .locator(".shell-connection-status .gateway-status__label")
          .getByText("Reconnecting…", { exact: true })
          .waitFor({ state: "visible" });
        await expect.poll(() => connectionStatusOverlapsComposer(page)).toBe(false);
      },
    );
  });

  it("shows reconnect once with queued messages and keeps the account menu usable", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        await page.addInitScript(() => {
          Object.assign(window, {
            __OPENCLAW_NATIVE_GATEWAYS__: {
              currentId: "profile:studio",
              gateways: [
                {
                  id: "profile:studio",
                  name: "Studio Gateway",
                  kind: "remote",
                  isPrimary: false,
                  canPromote: true,
                  health: "unknown",
                },
              ],
            },
            webkit: { messageHandlers: { openclawGateways: { postMessage() {} } } },
          });
        });
        const gateway = await installMockGateway(page, {
          presenceUsers: [{ self: true, id: "alex", name: "Alex", email: "alex@example.test" }],
          historyMessages: [],
          assistantName: "Assistant",
          agentModel: "example/sample-model",
          models: [{ id: "sample-model", name: "Sample model", provider: "example" }],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiGatewayReady(page);
        expect((await gateway.getRequests("connect")).length).toBeGreaterThan(0);
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor({ state: "visible" });
        await gateway.setOnline(false);
        for (const message of ["First synthetic draft", "Second synthetic draft"]) {
          await composer.fill(message);
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          await expect.poll(() => composer.inputValue()).toBe("");
        }
        const footer = page.locator(".sidebar-footer-bar");
        await expect.poll(() => page.locator(".chat-queue__item").count()).toBe(2);
        await expect.poll(() => footer.textContent()).toContain("Reconnecting…");
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await footer.screenshot({
            path: path.join(suite.artifactDir, "native-reconnecting.png"),
          });
        }
        const visibleStatus = footer.locator(".gateway-status__label");
        expect(await visibleStatus.count()).toBe(1);
        expect(await visibleStatus.textContent()).toBe("Reconnecting…");
        expect(await footer.locator(".sidebar-identity-card").textContent()).toContain("Alex");
        expect(await footer.locator(".sidebar-identity-card [role=status]").count()).toBe(0);
        const announcement = footer.getByRole("status");
        expect(await announcement.textContent()).toContain("Reconnecting…");
        expect(await announcement.textContent()).toContain("2 in outbox");
        expect(await footer.textContent()).toContain("2 in outbox");
        expect(await page.locator(".chat-queue__item").count()).toBe(2);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);

        await page.setViewportSize({ width: 390, height: 844 });
        const mobileStatus = page.locator(".shell-connection-status");
        await mobileStatus.waitFor({ state: "visible" });
        await expect.poll(() => connectionStatusOverlapsComposer(page)).toBe(false);
        expect(await mobileStatus.textContent()).toContain("2 in outbox");
        await page.setViewportSize({ width: 1280, height: 900 });
        await footer.waitFor({ state: "visible" });

        await footer.locator(".sidebar-identity-card").click();
        const menu = page.locator("wa-dropdown.sidebar-identity-menu");
        await menu.getByText("Alex", { exact: true }).waitFor();
        await menu.getByText("Studio Gateway", { exact: true }).waitFor();
        const socketCount = await gateway.getSocketCount();
        await menu.locator('wa-dropdown-item[value="command:retry-connect"]').click();
        await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
        await gateway.setOnline(true);
        await waitForControlUiGatewayReady(page);
        await expect.poll(() => footer.textContent()).not.toContain("Reconnecting…");
        expect(await footer.locator(".sidebar-identity-card").textContent()).toContain("Alex");
      },
    );
  });
});
