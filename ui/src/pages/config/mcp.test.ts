/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderMcp } from "./mcp.ts";

type McpViewProps = Parameters<typeof renderMcp>[0];

function createProps(overrides: Partial<McpViewProps> = {}): McpViewProps {
  return {
    configObject: {
      mcp: {
        servers: {
          docs: {
            url: "https://mcp.example.com/mcp",
            auth: "oauth",
            toolFilter: { include: ["search"] },
          },
          local: {
            command: "node",
            enabled: false,
            supportsParallelToolCalls: true,
          },
        },
      },
    },
    pluginsHref: "/settings/plugins",
    configBusy: false,
    onAppsEnabledToggle: vi.fn(),
    editor: html`<div class="test-editor"></div>`,
    ...overrides,
  };
}

function expectRowByTitle(container: Element, text: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === text,
  );
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Expected MCP row "${text}"`);
  }
  return row;
}

function buttonByText(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${text} button`);
  }
  return button;
}

describe("renderMcp", () => {
  it("renders summary counts, operator commands, and the managed servers card", () => {
    const container = document.createElement("div");

    render(renderMcp(createProps()), container);

    const summary = container.querySelector(".mcp-page__summary");
    expect(summary?.textContent).toContain("Servers");
    expect(summary?.textContent?.replace(/\s+/gu, " ")).toContain("Servers 2");
    expect(summary?.textContent?.replace(/\s+/gu, " ")).toContain("Enabled 1");
    expect(summary?.textContent?.replace(/\s+/gu, " ")).toContain("OAuth 1");
    expect(summary?.textContent?.replace(/\s+/gu, " ")).toContain("Filtered 1");
    expect(container.textContent).toContain("openclaw mcp doctor --probe");

    const card = container.querySelector("openclaw-mcp-servers-card");
    expect(card).not.toBeNull();
    expect(card?.pluginsHref).toBe("/settings/plugins");
  });

  it("keeps the summary free of save actions and preserves the embedded editor", () => {
    const container = document.createElement("div");

    render(renderMcp(createProps()), container);

    expect(buttonByText.bind(null, container, "Save")).toThrow();
    expect(buttonByText.bind(null, container, "Save & Publish")).toThrow();
    expect(container.querySelector(".test-editor")).not.toBeNull();
  });

  it("lets operators toggle MCP Apps and shows it as off by default", () => {
    const onAppsEnabledToggle = vi.fn();
    const container = document.createElement("div");

    render(renderMcp(createProps({ onAppsEnabledToggle })), container);

    const appsRow = expectRowByTitle(container, "MCP Apps");
    const appsSwitch = appsRow.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
    expect(appsSwitch).toBeInstanceOf(HTMLElement);
    expect(appsSwitch?.checked).toBe(false);
    if (!appsSwitch) {
      throw new Error("Expected MCP Apps switch");
    }
    appsSwitch.checked = true;
    appsSwitch.dispatchEvent(new Event("change"));
    expect(onAppsEnabledToggle).toHaveBeenCalledWith(true);
  });

  it("reflects an enabled override and locks the toggle while config is busy", () => {
    const container = document.createElement("div");

    render(
      renderMcp(
        createProps({
          configObject: { mcp: { apps: { enabled: true } } },
          configBusy: true,
        }),
      ),
      container,
    );

    const appsRow = expectRowByTitle(container, "MCP Apps");
    const appsSwitch = appsRow.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
    expect(appsSwitch?.checked).toBe(true);
    expect(appsSwitch?.hasAttribute("disabled")).toBe(true);
  });
});
