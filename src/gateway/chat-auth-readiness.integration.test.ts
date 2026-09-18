/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import "../../ui/src/app/app-host.ts";
import type { ApplicationContext } from "../../ui/src/app/context.ts";
import { makeChatHost, makeRequestMock } from "../../ui/src/pages/chat/chat-host.test-support.ts";
import { handlePageGatewayEvent } from "../../ui/src/pages/chat/chat-state-events.ts";
import type { ChatPageHost } from "../../ui/src/pages/chat/chat-state-host.ts";
import {
  refreshChatMetadata,
  retireChatMetadataRequests,
} from "../../ui/src/pages/chat/chat-state-refresh.ts";
import { createTestGatewayClient } from "../../ui/src/test-helpers/gateway-client.ts";
import { waitForFast } from "../../ui/src/test-helpers/wait-for.ts";
import { createSessionModelCatalogFixture } from "../agents/test-helpers/session-model-catalog.test-support.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  applySessionExecutionSelection,
  commitSessionExecutionSelection,
} from "../model-picker/apply-session-model-selection.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createLifecycleEventBroadcastHandler } from "./server-session-events.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

it("refreshes a retained pane from a persisted profile-only selection through the Gateway lifecycle broadcaster", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    // The picker supplies prepared capabilities; omission would start unrelated catalog discovery.
    const model = {
      provider: "anthropic",
      id: "claude-opus-4-6",
      name: "Model",
      reasoning: false,
      api: "anthropic-messages" as const,
      baseUrl: "https://profile-readiness.invalid/v1",
    };
    const cfg = {
      ...getRuntimeConfig(),
      models: {
        providers: {
          [model.provider]: {
            api: model.api,
            baseUrl: model.baseUrl,
            auth: "api-key" as const,
            models: [],
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    createSessionModelCatalogFixture().publish({
      config: cfg,
      agentId: "main",
      catalog: { entries: [model], routeVariants: [model] },
      profiles: {
        "anthropic:restored": {
          type: "api_key",
          provider: model.provider,
          key: "synthetic-credential",
        },
      },
    });
    const sessionKey = "agent:main:profile";
    const otherKey = "agent:main:other";
    const entry: SessionEntry = {
      sessionId: "profile-session",
      updatedAt: 1,
      authProfileOverride: "anthropic:missing",
      authProfileOverrideSource: "user" as const,
    };
    commitSessionExecutionSelection(entry, {
      model: { provider: model.provider, id: model.id },
      executor: { kind: "harness", id: "openclaw" },
    });
    await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: otherKey },
      { ...entry, sessionId: "other-session" },
    );
    const request = makeRequestMock({
      "chat.metadata": async () => ({ commands: [] }),
      "models.list": async (params: unknown) => {
        const selected = loadGatewaySessionEntryReadOnly(
          (params as { sessionKey: string }).sessionKey,
          { agentId: "main" },
        ).entry;
        const available = selected?.authProfileOverride === "anthropic:restored";
        return {
          commands: [],
          models: [
            { ...model, available, ...(available ? {} : { unavailableReason: "missing-auth" }) },
          ],
        };
      },
      "sessions.list": async () => ({ sessions: [], defaults: {}, count: 0, path: "", ts: 0 }),
    });
    const client = createTestGatewayClient(request);
    const retained = makeChatHost({
      sessionKey,
      chatMessage: "Keep this draft",
      client,
    }) as ChatPageHost;
    const sibling = makeChatHost({ sessionKey: otherKey, client }) as ChatPageHost;
    const shell = document.createElement("openclaw-app-shell") as HTMLElement & {
      runtime: { context: ApplicationContext };
      handleGatewayEvent: (event: { event: string; payload: unknown }) => void;
    };
    shell.runtime = {
      context: {
        gateway: { snapshot: { client, hello: retained.hello, phase: "connected" } },
        agents: { state: { agentsList: null } },
        sessions: retained.sessions,
      } as unknown as ApplicationContext,
    };
    await refreshChatMetadata(retained);
    await refreshChatMetadata(sibling);
    expect(retained.chatModelCatalog[0]?.available).toBe(false);
    const transcript = retained.chatMessages;
    const rowProjection = await createSessionRowProjection({ cfg: getRuntimeConfig() });
    const publications: Promise<void>[] = [];
    const publishLifecycle = createLifecycleEventBroadcastHandler({
      getSessionRowProjection: () => rowProjection,
      sessionEventSubscribers: { getAll: () => new Set(["reader"]) },
      chatAbortControllers: new Map(),
      broadcastToConnIds: (event, payload) => {
        shell.handleGatewayEvent({ event, payload });
        handlePageGatewayEvent(retained, { type: "event", event, payload });
        handlePageGatewayEvent(sibling, { type: "event", event, payload });
      },
    });
    const unsubscribe = onSessionLifecycleEvent((event) => {
      publications.push(publishLifecycle(event));
    });
    try {
      await expect(
        applySessionExecutionSelection({
          cfg,
          agentId: "main",
          sessionKey,
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
          sessionEntry: entry,
          sessionStore: { [sessionKey]: entry },
          currentProvider: model.provider,
          modelCatalog: [model],
          canPersistStickyModelSelection: false,
          markLiveSwitchPending: true,
          profileOverride: "anthropic:restored",
          request: { kind: "model", model: { provider: model.provider, id: model.id } },
        }),
      ).resolves.toMatchObject({ status: "applied", changed: true });
      await Promise.all(publications);
      await waitForFast(() => expect(retained.chatModelCatalog[0]?.available).toBe(true));
      expect(sibling.chatModelCatalog[0]?.available).toBe(false);
      expect(request.mock.calls.filter(([method]) => method === "chat.metadata")).toHaveLength(3);
      expect(retained.chatMessage).toBe("Keep this draft");
      expect(retained.chatMessages).toBe(transcript);
    } finally {
      unsubscribe();
      try {
        await Promise.all(publications);
      } finally {
        rowProjection.dispose();
        retireChatMetadataRequests(retained);
        retireChatMetadataRequests(sibling);
      }
    }
  });
});
