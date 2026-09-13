import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { useBrowserDashboardTestHarness } from "../../browser-dashboard.test-harness.js";
import type { BrowserActRequest } from "../client-actions.types.js";
import type { BrowserTab } from "../client.types.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "../pw-tools-core.test-harness.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "../server-context.test-harness.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const browser = vi.hoisted(() => ({
  open: vi.fn(),
  tabs: vi.fn(),
  ownership: vi.fn(),
  closeOwned: vi.fn(),
}));
vi.mock("../client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client.js")>()),
  browserOpenTab: browser.open,
  browserTabs: browser.tabs,
}));
vi.mock("../cdp.helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cdp.helpers.js")>()),
  resolveCdpTabOwnership: browser.ownership,
  closeTrackedCdpTarget: browser.closeOwned,
}));
vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: async () => await import("../pw-tools-core.interactions.execution.js"),
}));

import {
  assertBrowserDashboardTargetCurrent,
  reconcileBrowserDashboards,
  requestBrowserDashboard,
  stopBrowserDashboard,
} from "../../browser-dashboard.js";
import { registerBrowserAgentActRoutes } from "./agent.act.js";

installPwToolsCoreTestHooks();
const sessionKey = "agent:main:dashboard-action-proof";
const request = { sessionKey, agentId: "main", name: "service" };

function actionRoute(tab: BrowserTab) {
  const profile = makeBrowserProfile();
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected browser profile operation");
  };
  const profileCtx: ProfileContext = {
    profile,
    ensureBrowserAvailable: async () => {},
    ensureTabAvailable: async () => tab,
    isHttpReachable: async () => true,
    isTransportAvailable: async () => true,
    isReachable: async () => true,
    listTabs: async () => [tab],
    openTab: unused,
    labelTab: unused,
    focusTab: unused,
    closeTab: unused,
    stopRunningBrowser: unused,
    resetProfile: unused,
  };
  const state = makeBrowserServerState({
    profile,
    resolvedOverrides: { evaluateEnabled: true, ssrfPolicy: undefined },
  });
  const context: BrowserRouteContext = {
    ...profileCtx,
    state: () => state,
    forProfile: () => profileCtx,
    listProfiles: unused,
    mapTabError: () => null,
  };
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentActRoutes(app, context);
  return postHandlers.get("/act")!;
}

describe("dashboard action ownership", () => {
  const fixture = useBrowserDashboardTestHarness(browser, sessionKey);

  it.each([
    { revoke: "Stop", boundary: "batch" },
    { revoke: "Stop", boundary: "nested batch" },
    { revoke: "replacement", boundary: "batch" },
    { revoke: "replacement", boundary: "nested batch" },
    { revoke: "Stop", boundary: "submit" },
    { revoke: "replacement", boundary: "navigation preparation" },
  ])(
    "blocks the next effect after $revoke during $boundary with delayed tab close",
    async ({ revoke, boundary }) => {
      const dashboard = await requestBrowserDashboard(request);
      const targetId = dashboard.browserTab!.targetId;
      const tab: BrowserTab = { targetId, type: "page", title: "Service", url: dashboard.url };
      const waitEntered = createDeferred<void>();
      const releaseWait = createDeferred<void>();
      const closeEntered = createDeferred<void>();
      const releaseClose = createDeferred<{ status: "closed" }>();
      const nextEffect = vi.fn(async () => {});
      const holdAction = async () => {
        waitEntered.resolve();
        await releaseWait.promise;
      };
      const mainFrame = { url: () => tab.url };
      setPwToolsCoreCurrentPage({
        url: () => tab.url,
        mainFrame: () => mainFrame,
        isClosed: () => false,
        waitForTimeout: holdAction,
      });
      setPwToolsCoreCurrentRefLocator({
        click: nextEffect,
        fill: holdAction,
        press: nextEffect,
      });
      if (boundary === "navigation preparation") {
        getPwToolsCoreSessionMocks().withPageNavigationRequestGuard.mockImplementationOnce(
          async ({ action, page }) => {
            await holdAction();
            return await action(page.url());
          },
        );
      }
      browser.closeOwned.mockImplementation(async () => {
        closeEntered.resolve();
        return await releaseClose.promise;
      });
      const actions: BrowserActRequest[] = [
        { kind: "wait", timeMs: 1 },
        { kind: "click", ref: "1" },
      ];
      let body: BrowserActRequest = {
        kind: "batch",
        targetId,
        stopOnError: false,
        actions:
          boundary === "nested batch"
            ? [
                { kind: "batch", stopOnError: false, actions },
                { kind: "click", ref: "2" },
              ]
            : actions,
      };
      if (boundary === "submit") {
        body = { kind: "type", targetId, ref: "1", text: "updated value", submit: true };
      } else if (boundary === "navigation preparation") {
        body = { kind: "click", targetId, ref: "1" };
      }
      const response = createBrowserRouteResponse();
      const operation = Promise.resolve(
        actionRoute(tab)(
          {
            params: {},
            query: {},
            body,
            assertCurrent: async (profile) =>
              await assertBrowserDashboardTargetCurrent(dashboard, "main", {}, profile),
          },
          response.res,
        ),
      );
      let retirement: Promise<unknown> | undefined;
      try {
        await Promise.race([
          waitEntered.promise,
          operation.then(() => {
            throw new Error(
              `Action ended before wait: ${response.statusCode} ${JSON.stringify(response.body)}`,
            );
          }),
        ]);
        if (revoke === "replacement") {
          fixture.widgets[0]!.instanceId = "instance-two";
          retirement = reconcileBrowserDashboards();
        } else {
          retirement = stopBrowserDashboard(request);
        }
        await Promise.race([
          closeEntered.promise,
          retirement.then(() => {
            throw new Error("Dashboard retirement ended before closing its tab");
          }),
        ]);
        expect(fixture.tabs.map((entry) => entry.targetId)).toContain(targetId);
        releaseWait.resolve();
        await operation;
        expect(nextEffect).not.toHaveBeenCalled();
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(response.body).toMatchObject({
          error: expect.stringMatching(/dashboard|Dashboard/),
        });
      } finally {
        releaseWait.resolve();
        releaseClose.resolve({ status: "closed" });
        await Promise.allSettled([operation, retirement]);
      }
    },
  );
});
