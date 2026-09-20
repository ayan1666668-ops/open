import { expect, it } from "vitest";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureDeviceRuntimeUiProof,
  createNewSessionPageE2eSuite,
  installMockGateway,
  openEnvironmentPicker,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each([
    { name: "desktop", width: 1280, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ])(
    "uses commands on the selected computer without moving the session ($name)",
    async ({ name, width, height }) => {
      const context = await suite.browser.newContext({
        ...createControlUiE2eContextOptions(),
        viewport: { width, height },
      });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        agentModel: "openai/test-model",
        models: [
          {
            available: true,
            id: "test-model",
            name: "Example model",
            provider: "openai",
            agentRuntime: {
              id: "codex",
              nodeToolsSupported: true,
              cloudPlacementSupported: true,
              devicePlacementSupported: true,
              devicePlacement: {
                requiredNodeCommands: ["codex.exec-server.stdio.v1"],
                consumesWorkerSlot: false,
              },
              source: "model",
            },
          },
        ],
        methodResponses: {
          "environments.list": {
            environments: [
              {
                id: "node:build-mac",
                type: "node",
                label: "Build Mac",
                platform: "macos",
                status: "available",
                sessionHost: true,
                workerSlots: { total: 4, available: 4 },
                capabilities: ["system.run"],
                invocableCommands: ["system.run"],
                requiredNodeCommand: { command: "codex.exec-server.stdio.v1", state: "undeclared" },
              },
            ],
          },
          "sessions.create": { key: "agent:main:direct-node", runStarted: true },
        },
      });
      try {
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("environments.list");
        await openEnvironmentPicker(page);
        const row = page.locator('[data-value$=":build-mac"]');
        await row.locator(".session-menu__description").getByText("Run commands here").waitFor();
        await captureDeviceRuntimeUiProof(suite, page, `node-tools-picker-${name}.png`);
        expect(await row.getAttribute("data-value")).toBe("node-tools:build-mac");
        expect(await row.textContent()).toContain("Run commands here");
        await row.click();
        await expect
          .poll(() => page.locator("#new-session-where-trigger").textContent())
          .toContain("Build Mac");
        expect(await page.locator(".new-session-page__node-tools-hint").textContent()).toContain(
          "Commands run on Build Mac.",
        );
        expect(
          await page.locator("#new-session-where-trigger").getAttribute("aria-description"),
        ).toContain("The assistant stays on the OpenClaw server.");
        await captureDeviceRuntimeUiProof(suite, page, `node-tools-selected-${name}.png`);
        await page.locator(".new-session-page__message").fill("Check the node operating system");
        await page.getByRole("button", { name: "Start session" }).click();
        const create = await gateway.waitForRequest("sessions.create");
        expect(create.params).toMatchObject({
          execNode: "build-mac",
          message: "Check the node operating system",
        });
        for (const key of [
          "cwd",
          "projectId",
          "projectGitUrl",
          "repository",
          "worktree",
          "worktreeSource",
        ]) {
          expect(create.params).not.toHaveProperty(key);
        }
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
      } finally {
        await context.close();
      }
    },
  );
});
