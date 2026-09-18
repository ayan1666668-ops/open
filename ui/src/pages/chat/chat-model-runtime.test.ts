/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../api/types.ts";
import {
  resolveChatFastModeSelectState,
  resolveChatModelSelectState,
  resolveChatModelUnavailableReason,
} from "../../lib/chat/model-select-state.ts";
import { createChatModelState, createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { switchChatModel } from "./chat-session.ts";
import { renderChatModelControls } from "./components/chat-model-controls.ts";

const model: ModelCatalogEntry = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: "openai",
  available: true,
  contextWindow: 1_000_000,
  agentRuntime: { id: "openclaw", source: "model" },
  runtimeChoices: [
    { agentRuntime: { id: "codex", source: "model" }, available: true, contextWindow: 200_000 },
  ],
};

function renderRuntimeModel(
  entry: ModelCatalogEntry,
  selectedRuntime?: string,
  overrides: Partial<
    Pick<
      Parameters<typeof renderChatModelControls>[0],
      "selectedSession" | "modelOverrides" | "sessionsResult" | "modelCatalog"
    >
  > = {},
) {
  const result = createSessionsListResult({
    model: entry.id,
    modelProvider: entry.provider,
    defaultsModel: entry.id,
    defaultsProvider: entry.provider,
  });
  if (selectedRuntime) {
    result.sessions[0]!.agentRuntime = { id: selectedRuntime, source: "session-key" };
  }
  const container = document.createElement("div");
  render(
    renderChatModelControls({
      activeRunId: null,
      connected: true,
      gatewayAvailable: true,
      loading: false,
      modelCatalog: [entry],
      modelSwitching: false,
      sending: false,
      sessionKey: "main",
      selectedSession: result.sessions[0],
      sessionsResult: result,
      stream: null,
      ...overrides,
    }),
    container,
  );
  return container;
}

describe("chat model runtime choices", () => {
  it("does not gate an opaque app model on a colliding catalog route's credentials", () => {
    const catalog = [
      {
        id: "qa-model",
        name: "Catalog model",
        provider: "qa-provider",
        available: false,
        unavailableReason: "missing-auth" as const,
      },
    ];
    expect(
      resolveChatModelUnavailableReason("qa-provider/qa-model", undefined, catalog),
    ).toBeUndefined();
    expect(resolveChatModelUnavailableReason("qa-model", "qa-provider", catalog)).toBe(
      "missing-auth",
    );
  });

  it.each([true, false])(
    "uses catalog speed metadata only for local/concrete selection, server-managed=%s",
    (serverManagedModel) => {
      const state = resolveChatFastModeSelectState({
        activeRunId: null,
        connected: true,
        gatewayAvailable: true,
        loading: false,
        sending: false,
        stream: null,
        sessionsResult: null,
        currentModelOverride: "qa-provider/qa-model",
        serverManagedModel,
        fastModeTarget: {
          model: "qa-provider/qa-model",
          agentRuntime: { id: "qa-app", source: "session" },
        },
        catalog: [
          {
            id: "qa-model",
            name: "Catalog model",
            provider: "qa-provider",
            supportsFastMode: true,
          },
        ],
      });
      expect(state.supported).toBe(!serverManagedModel);
      expect(state.disabled).toBe(serverManagedModel);
    },
  );

  it("keeps opaque server values and labels despite catalog collisions", () => {
    const state = createChatModelState({
      activeSession: {
        key: "main",
        kind: "direct",
        updatedAt: null,
        model: "qa-provider/QA-model",
        agentRuntime: { id: "qa-app", source: "session" },
      },
      chatModelCatalog: [
        { id: "qa-model", name: "Unrelated catalog model", provider: "qa-provider" },
      ],
    });
    expect(resolveChatModelSelectState(state)).toMatchObject({
      currentOverride: "qa-provider/QA-model",
      appModelLabel: "qa-provider/QA-model",
    });
  });

  it.each(["session", "implicit", "model", "session-key"] as const)(
    "identifies app-managed defaults from server runtime source %s",
    (source) => {
      const state = createChatModelState({
        activeSession: {
          key: "main",
          kind: "direct",
          updatedAt: null,
          agentRuntime: { id: "qa-app", source },
        },
        agentDefaultModel: "qa-provider/qa-default",
      });
      const resolved = resolveChatModelSelectState(state);
      expect(resolved.appModelLabel).toBe(source === "session" ? "App default model" : undefined);
      expect(resolved.defaultLabel).toBe("Default (qa-default · qa-provider)");
      expect(
        resolveChatModelSelectState({ ...state, modelOverrides: { main: null } }).appModelLabel,
      ).toBeUndefined();
    },
  );
  it.each([
    { model: undefined, expected: "App default model" },
    { model: "qa-model", expected: "qa-model" },
    { model: "qa-provider/qa-model", expected: "qa-provider/qa-model" },
  ])(
    "renders the server-owned model label $expected without catalog inference",
    ({ model: selectedModel, expected }) => {
      const catalogEntry: ModelCatalogEntry = {
        id: "qa-model",
        name: "Unrelated catalog model",
        provider: "qa-provider",
        supportsTools: false,
        contextWindow: 4096,
      };
      const sessions = createSessionsListResult({
        model: selectedModel ?? null,
        modelProvider: null,
      });
      const session = expectDefined(sessions.sessions[0], "selected session");
      session.agentRuntime = { id: "qa-app", source: "session" };
      session.contextTokens = 123;
      const container = renderRuntimeModel(catalogEntry, undefined, { selectedSession: session });
      const trigger = expectDefined(
        container.querySelector<HTMLElement>('[data-chat-model-select="true"]'),
        "model control",
      );
      expect(trigger.textContent).toContain(expected);
      expect(trigger.textContent).not.toContain("Unrelated catalog model");
      expect(trigger.getAttribute("aria-label")).toBe(`Chat model: ${expected}`);
      expect(trigger.dataset.chatSelectValue).toBeUndefined();
      expect(trigger.dataset.chatModelTools).toBe("available");
      expect(container.querySelector('[data-chat-model-option][aria-selected="true"]')).toBeNull();
      expect(
        container.querySelector('[data-chat-model-option="qa-provider/qa-model"]')?.textContent,
      ).not.toContain("123 active");
      const pendingLocal = renderRuntimeModel(catalogEntry, undefined, {
        selectedSession: session,
        modelOverrides: { main: "qa-provider/qa-model" },
      });
      expect(
        pendingLocal
          .querySelector('[data-chat-model-option="qa-provider/qa-model"]')
          ?.getAttribute("aria-selected"),
      ).toBe("true");
      expect(
        pendingLocal.querySelector<HTMLElement>('[data-chat-model-select="true"]')?.dataset
          .chatModelTools,
      ).toBe("unavailable");
    },
  );

  it("shows the active fallback model without changing the selected preference", () => {
    const catalog = [
      { id: "gpt-5.5", name: "GPT-5.5", provider: "codex" },
      { id: "qwen3.5:9b", name: "Qwen 3.5 9B", provider: "ollama" },
    ];
    const sessions = createSessionsListResult({ model: "gpt-5.5", modelProvider: "codex" });
    const session = expectDefined(sessions.sessions[0], "selected session");
    Object.assign(session, { activeModel: "qwen3.5:9b", activeModelProvider: "ollama" });
    const container = renderRuntimeModel(catalog[0]!, undefined, {
      selectedSession: session,
      modelCatalog: catalog,
    });
    const trigger = expectDefined(
      container.querySelector<HTMLElement>('[data-chat-model-select="true"]'),
      "model control",
    );
    expect(trigger.textContent).toContain("Qwen 3.5 9B");
    expect(trigger.getAttribute("aria-label")).toBe("Chat model: Qwen 3.5 9B");
    expect(trigger.dataset.chatSelectValue).toBe("codex/gpt-5.5");
    expect(
      container
        .querySelector('[data-chat-model-option="codex/gpt-5.5"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
  });

  it.each([false, true])(
    "retains generic selection, honors explicit runtime and resets from Default with runtime locked: %s",
    async (runtimeLocked) => {
      const defaultModel: ModelCatalogEntry = {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        agentRuntime: { id: "openclaw", source: "model" },
      };
      const customModel: ModelCatalogEntry = {
        ...model,
        agentRuntime: { id: "custom-harness", source: "model" },
      };
      const models = [defaultModel, customModel];
      const result = createSessionsListResult({
        model: defaultModel.id,
        defaultsModel: defaultModel.id,
        modelOverrideSource: null,
      });
      result.sessions[0]!.agentRuntime = runtimeLocked
        ? { id: "acpx", source: "session-key" }
        : defaultModel.agentRuntime;
      result.sessions[0]!.runtimeSelectionLocked = runtimeLocked || undefined;
      const host = makeChatHost({
        sessionKey: "main",
        sessionsResult: result,
        chatModelCatalog: models,
        chatModelSwitchPromises: {},
        requestHandlers: {
          "sessions.patch": { ok: true, key: "main", path: "", entry: { sessionId: "main" } },
          "sessions.list": result,
        },
      });
      const container = document.createElement("div");
      let selection: Promise<boolean> | undefined;
      const draw = () =>
        render(
          renderChatModelControls({
            activeRunId: null,
            connected: true,
            gatewayAvailable: true,
            loading: false,
            modelCatalog: models,
            modelSwitching: false,
            sending: false,
            sessionKey: "main",
            selectedSession: result.sessions[0],
            sessionsResult: result,
            stream: null,
            onModelSelect: (value, key, runtime) => {
              selection = switchChatModel(host, value, key, runtime);
              return selection;
            },
          }),
          container,
        );
      try {
        draw();
        const rows = container.querySelectorAll<HTMLButtonElement>(
          '[data-chat-model-option="openai/gpt-5.6-sol"]',
        );
        rows[0]!.click();
        await selection;
        expect(host.request).toHaveBeenCalledWith("sessions.patch", {
          key: "main",
          model: "openai/gpt-5.6-sol",
        });
        expect(
          Array.from(
            rows,
            (row) => row.querySelector(".chat-controls__model-option-name")?.textContent,
          ),
        ).toEqual(runtimeLocked ? ["GPT-5.6 Sol"] : ["GPT-5.6 Sol", "GPT-5.6 Sol"]);
        expect(rows[0]?.getAttribute("data-chat-model-default")).toBeNull();
        expect(rows[0]?.getAttribute("data-chat-model-runtime")).toBe(
          runtimeLocked ? null : "custom-harness",
        );
        result.sessions[0]!.model = customModel.id;
        result.sessions[0]!.modelOverrideSource = "user";
        result.sessions[0]!.agentRuntime = runtimeLocked
          ? { id: "acpx", source: "session-key" }
          : customModel.agentRuntime;
        draw();
        if (runtimeLocked) {
          expect(container.querySelector('[data-chat-model-runtime="codex"]')).toBeNull();
          container.querySelector<HTMLButtonElement>('[data-chat-model-default="true"]')!.click();
          await selection;
          expect(host.request).toHaveBeenCalledWith("sessions.patch", { key: "main", model: null });
          return;
        }
        container.querySelector<HTMLButtonElement>('[data-chat-model-runtime="codex"]')!.click();
        await selection;
        expect(host.request).toHaveBeenCalledWith("sessions.patch", {
          key: "main",
          model: "openai/gpt-5.6-sol",
          agentRuntime: "codex",
        });
        result.sessions[0]!.agentRuntime = { id: "codex", source: "session-key" };
        customModel.runtimeChoices = undefined;
        draw();
        const patchesBeforeReset = host.request.mock.calls.filter(
          ([method]) => method === "sessions.patch",
        ).length;
        container
          .querySelector<HTMLButtonElement>('[data-chat-model-option="openai/gpt-5.6-sol"]')!
          .click();
        await selection;
        expect(
          host.request.mock.calls.filter(([method]) => method === "sessions.patch"),
        ).toHaveLength(patchesBeforeReset);
        expect(result.sessions[0]!.agentRuntime).toEqual({ id: "codex", source: "session-key" });
        container.querySelector<HTMLButtonElement>('[data-chat-model-default="true"]')!.click();
        await selection;
        const patches = host.request.mock.calls.filter(([method]) => method === "sessions.patch");
        expect(patches).toHaveLength(patchesBeforeReset + 1);
        expect(patches.at(-1)?.[1]).toEqual({ key: "main", model: null });
      } finally {
        host.sessions.dispose();
      }
    },
  );

  it.each([undefined, "codex"])(
    "selects exactly one row with absent base runtime metadata and selected runtime %s",
    (selectedRuntime) => {
      const { agentRuntime: _runtime, ...unknownRuntimeModel } = model;
      const container = renderRuntimeModel(
        {
          ...unknownRuntimeModel,
          runtimeChoices: [
            { agentRuntime: { id: "codex", source: "model" }, available: true },
            { agentRuntime: { id: "openclaw", source: "model" }, available: true },
          ],
        },
        selectedRuntime,
      );
      expect(container.querySelectorAll("[data-chat-model-runtime]")).toHaveLength(2);
      expect(
        container.querySelectorAll('[data-chat-model-runtime][aria-selected="true"]'),
      ).toHaveLength(selectedRuntime ? 1 : 0);
      expect(
        container.querySelectorAll('[data-chat-model-option][aria-selected="true"]'),
      ).toHaveLength(1);
    },
  );

  it("uses the selected harness capability for the model trigger", () => {
    const container = renderRuntimeModel(
      {
        ...model,
        supportsTools: true,
        runtimeChoices: [{ ...model.runtimeChoices![0]!, supportsTools: false }],
      },
      "codex",
    );
    expect(
      container.querySelector("[data-chat-model-select]")?.getAttribute("data-chat-model-tools"),
    ).toBe("unavailable");
    expect(
      container.querySelector(".chat-controls__model-capability-badge")?.textContent,
    ).toContain("Chat only");
  });

  it("uses alternate thinking metadata when the base runtime identity is absent", () => {
    const { agentRuntime: _runtime, ...unknownRuntimeModel } = model;
    const container = renderRuntimeModel(
      {
        ...unknownRuntimeModel,
        thinkingLevels: [{ id: "medium", label: "Medium" }],
        thinkingDefault: "medium",
        runtimeChoices: [
          {
            ...model.runtimeChoices![0]!,
            thinkingLevels: [{ id: "high", label: "High" }],
            thinkingDefault: "high",
          },
        ],
      },
      "codex",
    );
    expect(container.querySelector('[data-chat-thinking-option="high"]')).not.toBeNull();
    expect(container.querySelector('[data-chat-thinking-option="medium"]')).toBeNull();
  });

  it.each([
    { name: "an inherited default model", initialRuntime: "openclaw", modelOverrideSource: null },
    { name: "a pinned model", initialRuntime: "openclaw", modelOverrideSource: "user" },
    {
      name: "an effective matching harness without a runtime pin",
      initialRuntime: "codex",
      modelOverrideSource: "user",
    },
  ] as const)(
    "pins the chosen harness for $name and resets through Default",
    async ({ initialRuntime, modelOverrideSource }) => {
      const result = createSessionsListResult({
        model: model.id,
        defaultsModel: model.id,
        modelOverrideSource,
      });
      result.sessions[0]!.agentRuntime = { id: initialRuntime, source: "provider" };
      const host = makeChatHost({
        sessionKey: "main",
        sessionsResult: result,
        chatModelCatalog: [model],
        chatModelSwitchPromises: {},
        requestHandlers: {
          "sessions.patch": { ok: true, key: "main", path: "", entry: { sessionId: "main" } },
          "sessions.list": result,
        },
      });
      const container = document.createElement("div");
      let selection: Promise<boolean> | undefined;
      const draw = () =>
        render(
          renderChatModelControls({
            activeRunId: null,
            connected: true,
            gatewayAvailable: true,
            loading: false,
            modelCatalog: [model],
            modelSwitching: false,
            sending: false,
            sessionKey: "main",
            selectedSession: result.sessions[0],
            sessionsResult: result,
            stream: null,
            onModelSelect: (value, key, runtime) => {
              selection = switchChatModel(host, value, key, runtime);
              return selection;
            },
          }),
          container,
        );
      try {
        draw();
        const rows = () =>
          Array.from(container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]"));
        expect(
          rows().map((row) => row.querySelector(".chat-controls__model-option-name")?.textContent),
        ).toEqual(["GPT-5.6 Sol", "GPT-5.6 Sol"]);
        expect(rows().map((row) => row.getAttribute("aria-selected"))).toEqual(
          initialRuntime === "codex" ? ["false", "true"] : ["true", "false"],
        );
        expect(rows()[0]?.textContent).toContain("1M · OpenClaw");
        expect(rows()[1]?.textContent).toContain("200k · Codex");
        rows()[1]!.click();
        await selection;
        expect(host.request).toHaveBeenCalledWith("sessions.patch", {
          key: "main",
          model: "openai/gpt-5.6-sol",
          agentRuntime: "codex",
        });
        result.sessions[0]!.agentRuntime = { id: "codex", source: "session-key" };
        draw();
        expect(rows().map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "true"]);
        const patches = () =>
          host.request.mock.calls.filter(([method]) => method === "sessions.patch");
        expect(patches()).toHaveLength(1);
        rows()[1]!.click();
        await selection;
        expect(patches()).toHaveLength(1);
        rows()[0]!.click();
        await selection;
        expect(host.request).toHaveBeenCalledWith("sessions.patch", {
          key: "main",
          model: null,
        });
      } finally {
        host.sessions.dispose();
      }
    },
  );

  it.each(["missing-auth", "cooldown", "unsupported-runtime", "locked"] as const)(
    "preserves the %s guard for additional harness rows",
    (guard) => {
      const onSelect = vi.fn();
      const onSetup = vi.fn();
      const result = createSessionsListResult({ model: model.id, defaultsModel: model.id });
      result.sessions[0]!.agentRuntime = model.agentRuntime;
      const container = document.createElement("div");
      render(
        renderChatModelControls({
          activeRunId: null,
          connected: true,
          gatewayAvailable: true,
          loading: false,
          modelCatalog: [
            {
              ...model,
              runtimeChoices: [
                {
                  ...model.runtimeChoices![0]!,
                  available: false,
                  ...(guard === "locked" ? {} : { unavailableReason: guard }),
                },
              ],
            },
          ],
          modelSelectionLocked: guard === "locked",
          modelSwitching: false,
          sending: false,
          sessionKey: "main",
          selectedSession: result.sessions[0],
          sessionsResult: result,
          stream: null,
          onModelSelect: onSelect,
          onModelSetup: onSetup,
        }),
        container,
      );
      const row = container.querySelector<HTMLButtonElement>('[data-chat-model-runtime="codex"]');
      if (guard === "locked") {
        expect(row).toBeNull();
      } else {
        expect(row?.disabled).toBe(guard === "cooldown" || guard === "unsupported-runtime");
        if (guard === "unsupported-runtime") {
          expect(row?.title).toBe("This harness is unavailable for this model.");
        }
        row?.click();
      }
      expect(onSelect).not.toHaveBeenCalled();
      expect(onSetup).toHaveBeenCalledTimes(guard === "missing-auth" ? 1 : 0);
    },
  );
});
