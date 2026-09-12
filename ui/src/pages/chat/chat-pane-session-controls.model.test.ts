/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { renderChatPaneComposerControls } from "./chat-pane-session-controls.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { getChatSessionProjection, setChatRunOwner } from "./history-merge.ts";

describe("chat pane model controls", () => {
  it("does not show another session's pending model after switching sessions", () => {
    const previousSessionKey = "agent:main:previous";
    const selectedSession: GatewaySessionRow = {
      key: "agent:main:selected",
      kind: "direct",
      model: "primary",
      modelProvider: "example",
    };
    const state = makeChatHost({
      sessionKey: previousSessionKey,
      sessionsResult: { ...createSessionsListResult(), sessions: [selectedSession] },
      chatModelCatalog: [{ id: "primary", name: "Primary", provider: "example" }],
      chatModelSwitchPromises: {},
      requestHandlers: {},
    });
    getChatSessionProjection(state, { sessionKey: previousSessionKey });
    state.chatRunId = "previous-session-run";
    state.chatStream = "Working";
    state.chatSending = true;
    state.chatSendingScopeKey = storedChatOutboxScopeKey({ sessionKey: previousSessionKey });
    setChatRunOwner(state, state.chatRunId);
    state.sessionKey = selectedSession.key;

    const controls = renderChatPaneComposerControls({
      state: state as unknown as ChatPageHost,
      selectedSession,
      agentDefaultModel: "example/primary",
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      contextWindowAccess: { allowed: true, requiredScope: "operator.write" },
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: true,
      onModelSetup: vi.fn(),
    });
    const container = document.createElement("div");
    render(controls.composerControls, container);

    const trigger = container.querySelector<HTMLElement>("[data-chat-model-select]");
    expect(trigger?.textContent).toContain("Primary");
    expect(trigger?.textContent).not.toContain("Model pending");
    expect(trigger?.dataset.chatSelectValue).toBe("example/primary");
  });
});
