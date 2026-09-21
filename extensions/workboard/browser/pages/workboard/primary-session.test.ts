import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { render as litRender } from "lit";
import type { ControlUiComponents } from "openclaw/plugin-sdk/control-ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { getWorkboardState } from "../../lib/workboard/index.ts";
import {
  createWorkboardCard,
  createWorkboardExecution,
} from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { renderWorkboard } from "./view.ts";

const renderedRoots = new Set<ReturnType<typeof litRender>>();

function render(...args: Parameters<typeof litRender>) {
  const root = litRender(...args);
  renderedRoots.add(root);
  return root;
}

afterEach(() => {
  for (const root of renderedRoots) {
    root.setConnected(false);
  }
  renderedRoots.clear();
});

type ControlUiSelectPickerProps = Parameters<ControlUiComponents["mountSelectPicker"]>[1];

type WorkboardRenderProps = Parameters<typeof renderWorkboard>[0];

function createWorkboardRenderProps(
  host: WorkboardRenderProps["host"],
  overrides: Partial<WorkboardRenderProps> = {},
): WorkboardRenderProps {
  return {
    host,
    client: null,
    connected: true,
    agentsList: null,
    sessions: [],
    onOpenSession: () => undefined,
    onRefresh: () => undefined,
    ...overrides,
  };
}

function renderInto(container: HTMLElement, props: WorkboardRenderProps) {
  workboardTestHost().connection.connected = props.connected;
  if (!container.isConnected) {
    document.body.append(container);
  }
  render(renderWorkboard(props), container);
}

function createWorkboardView(
  overrides: Partial<WorkboardRenderProps> = {},
  host: WorkboardRenderProps["host"] = {},
) {
  const state = getWorkboardState(host);
  state.loaded = true;
  const container = document.createElement("div");
  const props = createWorkboardRenderProps(host, overrides);
  const renderView = (next: Partial<WorkboardRenderProps> = {}) =>
    renderInto(container, { ...props, ...next });
  return { host, state, container, renderView };
}

function buttonByLabel(container: Element, label: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) =>
        button.getAttribute("aria-label") === label || button.textContent?.trim() === label,
    ) ?? null
  );
}

function draftPicker(container: Element, label: string) {
  return expectDefined(
    [
      ...container.querySelectorAll<HTMLElement & ControlUiSelectPickerProps>(
        ".workboard-draft [data-test-select-picker]",
      ),
    ].find((picker) => picker.accessibleLabel === label),
    `card ${label} picker`,
  );
}

function sessionPicker(container: Element) {
  return draftPicker(container, "Session");
}

describe("primary session editor", () => {
  it("records explicit A-to-B-to-A session selection intent", () => {
    const card = createWorkboardCard({ sessionKey: "A" });
    const { state, container, renderView } = createWorkboardView();
    state.cards = [card];
    state.detailCardId = card.id;
    renderView();
    buttonByLabel(container, "Edit card")!.click();
    renderView();
    sessionPicker(container).onSelect("B");
    sessionPicker(container).onSelect("A");
    expect(state.draftSessionKey).toBe("A");
    expect(state.draftSessionKeyDirty).toBe(true);
  });

  it.each([
    {
      scenario: "an execution-owned linked session",
      sessionKey: "agent:main:execution-linked-session",
      topLevelSessionKey: undefined,
    },
    {
      scenario: "the authoritative top-level session",
      sessionKey: "agent:main:top-level-linked-session",
      topLevelSessionKey: "agent:main:top-level-linked-session",
    },
  ])("preserves $scenario when editing a Workboard card", async (testCase) => {
    const card = createWorkboardCard({
      title: "Keep my linked session",
      ...(testCase.topLevelSessionKey ? { sessionKey: testCase.topLevelSessionKey } : {}),
      execution: createWorkboardExecution({
        sessionKey: "agent:main:execution-linked-session",
      }),
    });
    const request = vi.fn(async () => ({
      card: { ...card, title: "Renamed without unlinking", updatedAt: 2 },
    }));
    const { state, container, renderView } = createWorkboardView({
      client: { request } as unknown as GatewayBrowserClient,
      onRequestUpdate: () => undefined,
      sessions: [
        {
          key: testCase.sessionKey,
          kind: "direct",
          displayName: "Active linked session",
          updatedAt: 1,
          status: "running",
        },
      ],
    });
    state.cards = [card];
    state.detailCardId = card.id;

    renderView();
    const editButton = buttonByLabel(container, "Edit card");
    expect(editButton).not.toBeNull();
    editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();

    expect(state.draftSessionKey).toBe(testCase.topLevelSessionKey ?? "");
    expect(sessionPicker(container).value).toBe(testCase.topLevelSessionKey ?? "");

    const title = container.querySelector<HTMLInputElement>(".workboard-draft__title");
    expect(title).not.toBeNull();
    title!.value = "Renamed without unlinking";
    title!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    container
      .querySelector<HTMLFormElement>(".workboard-draft")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("workboard.cards.update", {
      id: card.id,
      expectedUpdatedAt: card.updatedAt,
      patch: { title: "Renamed without unlinking" },
    });
    expect(state.cards[0]?.execution?.sessionKey).toBe("agent:main:execution-linked-session");
    renderView();
    state.detailTab = "session";
    renderView();
    expect(container.querySelector("[data-test-session-summary]")).not.toBeNull();
  });
});
