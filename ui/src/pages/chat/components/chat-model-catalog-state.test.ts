/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  renderChatModelCatalogRefresh,
  renderChatModelCatalogState,
  type ChatModelCatalogState,
} from "./chat-model-catalog-state.ts";

describe("model catalog refresh presentation", () => {
  it.each([
    { status: "loading", label: "Refreshing models…" },
    {
      status: "ready",
      pendingProviders: ["openai", "clawrouter"],
      label: "Refreshing models for OpenAI, Clawrouter…",
    },
  ] as const)("keeps a $status background refresh out of the model list", ({ label, ...state }) => {
    const catalog = { hasSnapshot: true, ...state };
    const container = document.createElement("div");
    render(renderChatModelCatalogState(catalog, true, true), container);
    expect(container.querySelector("[role=status]")).toBeNull();

    render(renderChatModelCatalogRefresh(catalog), container);
    expect(container.querySelector("[role=status]")?.textContent).toContain(label);
    expect(container.querySelector(".btn__spinner")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".sr-only")?.textContent).toBe(label);
  });

  it.each(["idle", "ready", "error", "offline"] as const)(
    "does not show a refresh spinner for a settled %s catalog",
    (status) => {
      const container = document.createElement("div");
      render(renderChatModelCatalogRefresh({ hasSnapshot: true, status }), container);
      expect(container.querySelector("[data-chat-model-refresh]")).toBeNull();
    },
  );

  it.each(["loading", "ready"] as const)(
    "shows initial loading instead of an empty %s catalog",
    (status) => {
      const container = document.createElement("div");
      render(
        renderChatModelCatalogState(
          { hasSnapshot: false, status, pendingProviders: ["clawrouter"] },
          false,
          false,
        ),
        container,
      );
      expect(container.textContent).toContain("Loading models…");
      expect(container.querySelector(".btn__spinner")).not.toBeNull();
      expect(container.textContent).not.toContain("No models available");
    },
  );

  it.each([
    { status: "error", label: "Some models could not be refreshed." },
    { status: "offline", label: "Offline" },
  ] as const)(
    "keeps $status visible even with retained models and pending providers",
    ({ status, label }) => {
      const container = document.createElement("div");
      const state: ChatModelCatalogState = {
        hasSnapshot: true,
        status,
        pendingProviders: ["clawrouter"],
      };
      render(renderChatModelCatalogRefresh(state), container);
      expect(container.querySelector("[data-chat-model-refresh]")).toBeNull();
      render(renderChatModelCatalogState(state, true, true), container);
      expect(container.querySelector("[role=status]")?.textContent).toContain(label);
      expect(container.querySelector(".btn__spinner")).toBeNull();
    },
  );

  it("preserves the empty-catalog setup action", () => {
    const container = document.createElement("div");
    const setup = vi.fn();
    render(
      renderChatModelCatalogState({ hasSnapshot: true, status: "ready" }, false, false, setup),
      container,
    );
    expect(container.textContent).toContain("No models available");
    container.querySelector<HTMLButtonElement>("[data-chat-model-setup]")?.click();
    expect(setup).toHaveBeenCalledOnce();
  });
});
