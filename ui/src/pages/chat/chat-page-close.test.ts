/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page-close.test/"} */

import { expectDefined } from "@openclaw/normalization-core";
import { createRouter, definePage } from "@openclaw/uirouter";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

vi.mock("./chat-pane.ts", () => ({}));

import { createDeferred } from "../../../../test/helpers/promise.js";
import type { RouteId } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { setViewerPresenceContext } from "./chat-page.test-support.ts";
import { ChatPage } from "./chat-page.ts";
import type { SessionChatRouteData } from "./session-route-data.ts";
import type { ChatSplitLayout } from "./split-layout-types.ts";
import { insertPane, panesOf, singlePaneLayout } from "./split-layout.ts";

const A = "agent:main:alpha";
const B = "agent:main:beta";
const C = "agent:main:gamma";

type RenderedPane = HTMLElement & {
  paneId: string;
  sessionKey: string;
  active: boolean;
  presented: boolean;
  onClosePane?: (paneId: string) => void;
  onOpenSplitView?: () => void;
  discardStagedAttachments?: () => void;
};

function panes(page: ChatPage) {
  return [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")];
}

function paneFor(page: ChatPage, paneId: string) {
  return expectDefined(
    panes(page).find((pane) => pane.paneId === paneId),
    "rendered pane",
  );
}

async function settle(page: ChatPage) {
  await page.updateComplete;
  await Promise.resolve();
}

async function mount(layout: ChatSplitLayout) {
  patchSettings({ chatSplitLayout: layout });
  const page = new ChatPage();
  const navigation = setViewerPresenceContext(page);
  page.data = {
    sessionKey: expectDefined(
      panesOf(layout).find((pane) => pane.id === layout.activePaneId),
      "active session",
    ).sessionKey,
  };
  document.body.append(page);
  await settle(page);
  return { page, ...navigation };
}

function split(edge: "left" | "right" | "down" = "right", first = A, second = B) {
  return insertPane(singlePaneLayout("c1", "p1", first), "p1", second, edge);
}

async function close(page: ChatPage, pane: RenderedPane) {
  expectDefined(pane.onClosePane, "rendered close action")(pane.paneId);
  await settle(page);
}

function expectSelected(page: ChatPage, survivor: RenderedPane, sessionKey: string) {
  expect(panes(page)).toContain(survivor);
  expect(survivor.sessionKey).toBe(sessionKey);
  expect(survivor.active).toBe(true);
  expect(survivor.presented).toBe(true);
  expect(survivor.hasAttribute("inert")).toBe(false);
  expect(survivor.getAttribute("aria-hidden")).toBe("false");
}

async function mountWithRouter() {
  const layout = split();
  const fixture = await mount(layout);
  const { page, context, replace } = fixture;
  const sourceData = page.data;
  const pendingA = createDeferred<SessionChatRouteData>();
  const pendingC = createDeferred<SessionChatRouteData>();
  const location = (sessionKey: string) => ({
    pathname: sessionNavigationTarget({ face: "chat", sessionKey, fallbackAgentId: "main" }).options
      .pathname!,
    search: "",
    hash: "",
  });
  const router = createRouter<RouteId, ApplicationContext, null, SessionChatRouteData>({
    routes: [
      definePage({
        id: "chat",
        path: "/chat",
        component: () => null,
        loaderDeps: (_context, target) => target.pathname,
        loader: (_context, { location: target }) =>
          target.pathname === location(B).pathname
            ? sourceData
            : target.pathname === location(A).pathname
              ? pendingA.promise
              : pendingC.promise,
      }),
    ],
  });
  Object.assign(context, { router });
  await router.navigate("chat", context, {}, location(B));
  const unsubscribe = router.subscribe(() => {
    const state = router.getState();
    if (state.status === "success" && state.matches[0]?.data) {
      page.data = state.matches[0].data;
    }
  });
  let closeNavigation: Promise<void> = Promise.resolve();
  replace.mockImplementation((routeId, options) => {
    closeNavigation = router
      .navigate(
        routeId,
        context,
        {},
        {
          pathname: options?.pathname ?? "/chat",
          search: options?.search ?? "",
          hash: options?.hash ?? "",
        },
      )
      .then(() => undefined);
    void closeNavigation.catch(() => undefined);
  });
  onTestFinished(async () => {
    unsubscribe();
    pendingA.resolve({ sessionKey: A });
    pendingC.resolve({ sessionKey: C });
    router.stop();
    await closeNavigation.catch(() => undefined);
  });
  return { ...fixture, layout, sourceData, router, pendingA, pendingC, location };
}

describe("closing split panes while route data is pending", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal(
      "matchMedia",
      vi.fn((media: string) => ({
        matches: false,
        media,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it.each(["left", "right", "down"] as const)(
    "keeps the survivor selected without admitting the closed %s session",
    async (edge) => {
      const layout = split(edge);
      const { page, context, request, chatAttachmentHandoff } = await mount(layout);
      const survivor = paneFor(page, "p1");
      const closing = paneFor(page, layout.activePaneId);
      const discard = vi.fn();
      closing.discardStagedAttachments = discard;
      const pendingData = page.data;

      await close(page, closing);
      // Navigation is intentionally unresolved: the previous route still names B.
      expect(page.data).toBe(pendingData);
      expect(panes(page)).toEqual([survivor]);
      expectSelected(page, survivor, A);
      expect(context.gateway.setSessionKey).toHaveBeenLastCalledWith(A);
      expect(loadSettings().sessionKey).toBe(A);
      expect(loadSettings().chatSplitLayout).toBeUndefined();
      expect(request).toHaveBeenLastCalledWith("sessions.viewers.set", { sessionKeys: [A] });
      expect(discard).toHaveBeenCalledOnce();
      expect(chatAttachmentHandoff.clearPane).toHaveBeenCalledWith(closing.paneId);

      page.requestUpdate();
      await settle(page);
      expect(panes(page)).toEqual([survivor]);
      page.data = { sessionKey: A };
      await settle(page);
      expect(panes(page)).toEqual([survivor]);
      expectSelected(page, survivor, A);
    },
  );

  it.each([
    { name: "inactive pane", first: A, second: B, closeActive: false },
    { name: "same session", first: A, second: A, closeActive: true },
    { name: "canonical alias", first: "main", second: "agent:main:main", closeActive: true },
  ])("preserves the survivor when closing $name", async ({ first, second, closeActive }) => {
    const layout = split("right", first, second);
    const { page } = await mount(layout);
    const closing = paneFor(page, closeActive ? layout.activePaneId : "p1");
    const survivor = paneFor(page, closeActive ? "p1" : layout.activePaneId);
    await close(page, closing);
    expect(panes(page)).toEqual([survivor]);
    expectSelected(page, survivor, closeActive ? first : second);
  });

  it("keeps both surviving presentations when three panes become two", async () => {
    const two = split();
    const layout = insertPane(two, two.activePaneId, C, "down");
    const { page } = await mount(layout);
    const survivors = panes(page).filter((pane) => pane.paneId !== layout.activePaneId);
    await close(page, paneFor(page, layout.activePaneId));
    expect(panes(page)).toEqual(survivors);
    expect(survivors.every((pane) => pane.presented)).toBe(true);
    expect(loadSettings().chatSplitLayout).toBeDefined();
  });

  it("lets newer route data replace the pending survivor selection", async () => {
    const layout = split();
    const { page, context, request } = await mount(layout);
    await close(page, paneFor(page, layout.activePaneId));
    page.data = { sessionKey: C };
    await settle(page);
    expect(
      panes(page)
        .filter((pane) => pane.presented)
        .map((pane) => pane.sessionKey),
    ).toEqual([C]);
    expect(context.gateway.setSessionKey).toHaveBeenLastCalledWith(C);
    expect(request).toHaveBeenLastCalledWith("sessions.viewers.set", { sessionKeys: [C] });
  });

  it("opens another split from the survivor before its route resolves", async () => {
    const layout = split();
    const { page } = await mount(layout);
    const survivor = paneFor(page, "p1");
    await close(page, paneFor(page, layout.activePaneId));
    expectDefined(survivor.onOpenSplitView, "open split action")();
    await settle(page);
    expect(panes(page).map((pane) => pane.sessionKey)).toEqual([A, A]);
    expect(panes(page)[0]).toBe(survivor);
  });

  it("restores a cached source route even when cancellation reuses the same data object", async () => {
    const { page, layout, context, request, router, location, sourceData, pendingA } =
      await mountWithRouter();
    await close(page, paneFor(page, layout.activePaneId));
    expect(panes(page).map((pane) => pane.sessionKey)).toEqual([A]);
    await router.navigate("chat", context, {}, location(B));
    await settle(page);
    expect(page.data).toBe(sourceData);
    expect(
      panes(page)
        .filter((pane) => pane.presented)
        .map((pane) => pane.sessionKey),
    ).toEqual([B]);
    expect(context.gateway.setSessionKey).toHaveBeenLastCalledWith(B);
    expect(request).toHaveBeenLastCalledWith("sessions.viewers.set", { sessionKeys: [B] });
    pendingA.resolve({ sessionKey: A });
    await settle(page);
    expect(page.data).toBe(sourceData);
    expect(
      panes(page)
        .filter((pane) => pane.presented)
        .map((pane) => pane.sessionKey),
    ).toEqual([B]);
  });

  it("keeps the survivor while a newer destination loads, then adopts that destination", async () => {
    const { page, layout, context, router, location, pendingA, pendingC } = await mountWithRouter();
    const survivor = paneFor(page, "p1");
    await close(page, paneFor(page, layout.activePaneId));
    const navigation = router.navigate("chat", context, {}, location(C));
    await settle(page);
    expect(panes(page)).toEqual([survivor]);
    expectSelected(page, survivor, A);
    pendingC.resolve({ sessionKey: C });
    await navigation;
    await settle(page);
    expect(
      panes(page)
        .filter((pane) => pane.presented)
        .map((pane) => pane.sessionKey),
    ).toEqual([C]);
    expect(panes(page).some((pane) => pane.sessionKey === B)).toBe(false);
    pendingA.resolve({ sessionKey: A });
    await settle(page);
    expect(page.data.sessionKey).toBe(C);
  });

  it("applies cached route cancellation to the active pane of a reopened split", async () => {
    const { page, layout, context, request, router, location, sourceData, pendingA } =
      await mountWithRouter();
    const survivor = paneFor(page, "p1");
    await close(page, paneFor(page, layout.activePaneId));
    expectDefined(survivor.onOpenSplitView, "open split action")();
    await settle(page);
    const reopenedPane = expectDefined(
      panes(page).find((pane) => pane.active),
      "active reopened pane",
    );
    expect(reopenedPane.paneId).not.toBe(survivor.paneId);

    await router.navigate("chat", context, {}, location(B));
    await settle(page);
    expect(page.data).toBe(sourceData);
    const visible = panes(page).filter((pane) => pane.presented);
    expect(visible.map((pane) => pane.sessionKey)).toEqual([A, B]);
    const active = expectDefined(
      visible.find((pane) => pane.active),
      "active destination",
    );
    expect(active.paneId).toBe(reopenedPane.paneId);
    expect(active.sessionKey).toBe(B);
    expect(visible[0]).toBe(survivor);
    expect(context.gateway.setSessionKey).toHaveBeenLastCalledWith(B);
    expect(request).toHaveBeenLastCalledWith("sessions.viewers.set", { sessionKeys: [A, B] });

    pendingA.resolve({ sessionKey: A });
    await settle(page);
    expect(page.data).toBe(sourceData);
    expect(
      panes(page)
        .filter((pane) => pane.active)
        .map((pane) => pane.sessionKey),
    ).toEqual([B]);
  });

  it.each(["suspend", "disconnect"] as const)(
    "releases pending close ownership on %s and uses the current route on return",
    async (lifecycle) => {
      const layout = split();
      const { page, request } = await mount(layout);
      await close(page, paneFor(page, layout.activePaneId));
      if (lifecycle === "suspend") {
        page.presented = false;
        await settle(page);
        expect(panes(page).every((pane) => !pane.presented)).toBe(true);
      } else {
        page.remove();
      }
      expect(request).toHaveBeenLastCalledWith("sessions.viewers.set", { sessionKeys: [] });
      if (lifecycle === "suspend") {
        page.presented = true;
      } else {
        document.body.append(page);
      }
      await settle(page);
      expect(
        panes(page)
          .filter((pane) => pane.presented)
          .map((pane) => pane.sessionKey),
      ).toEqual([B]);
      expect(request).toHaveBeenLastCalledWith("sessions.viewers.set", { sessionKeys: [B] });
    },
  );
});
