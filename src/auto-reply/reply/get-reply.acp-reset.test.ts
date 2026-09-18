import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, expect, it, vi } from "vitest";
import { AcpSessionManager, testing as managerTesting } from "../../acp/control-plane/manager.js";
import { requireReadySession } from "../../acp/control-plane/manager.utils.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import * as runtimePlugins from "../../agents/runtime-plugins.js";
import {
  loadSessionEntryReadOnly,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { tryDispatchAcpReplyHook } from "../../plugin-sdk/acpx.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { MODEL_SELECTION_LOCKED_RESET_MESSAGE } from "../../sessions/model-overrides.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

const backendId = "fixture-reset";
let state: OpenClawTestState | undefined;
let restoreRegistry: (() => void) | undefined;

afterEach(async () => {
  managerTesting.resetAcpSessionManagerForTests();
  unregisterAcpRuntimeBackend(backendId);
  resetGlobalHookRunner();
  restoreRegistry?.();
  restoreRegistry = undefined;
  await state?.cleanup();
  state = undefined;
  vi.restoreAllMocks();
});

it.each(
  [
    { agentId: "main", sessionKey: "agent:main:acp:reset-tail" },
    { agentId: "work", sessionKey: "shared-reset-tail" },
  ].flatMap(({ agentId, sessionKey }) =>
    ["unlocked", "locked", "stale-admission"].map((custody) => ({ agentId, sessionKey, custody })),
  ),
)(
  "routes an explicit ACP reset to $agentId/$sessionKey with $custody custody",
  async ({ agentId, sessionKey, custody }) => {
    state = await createOpenClawTestState({ scenario: "minimal", label: "explicit-acp-reset" });
    const scope = { agentId, sessionKey, storePath: state.path(agentId, "sessions.json") };
    const neighborScope = {
      agentId: "main",
      sessionKey,
      storePath: state.path("main", "sessions.json"),
    };
    const cfg = withFullRuntimeReplyConfig<OpenClawConfig>({
      session: { store: state.path("{agentId}", "sessions.json") },
      agents: {
        ownership: "explicit",
        entries: { main: {}, work: {} },
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          model: "fixture/default",
          models: { "fixture/default": {}, "fixture/alternate": {} },
        },
      },
      acp: {
        enabled: true,
        backend: backendId,
        dispatch: { enabled: true },
        allowedAgents: ["qa-agent"],
      },
      models: {
        providers: {
          fixture: {
            api: "openai-responses",
            apiKey: "synthetic-local-fixture",
            baseUrl: "http://127.0.0.1:1/v1",
            request: { allowPrivateNetwork: true },
            models: ["default", "alternate"].map((id) => ({
              id,
              name: id,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 1024,
            })),
          },
        },
      },
      plugins: { enabled: false },
      commands: { text: true },
    });
    await state.writeConfig(cfg);
    const ensureSession = vi.fn<AcpRuntime["ensureSession"]>(async (input) => ({
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      backend: backendId,
      runtimeSessionName: `${input.agentId}/${input.sessionKey}:runtime`,
    }));
    const runTurn = vi.fn<AcpRuntime["runTurn"]>(async function* () {
      yield { type: "text_delta", text: "The reset tail ran." };
      yield { type: "done" };
    });
    const close = vi.fn<AcpRuntime["close"]>(async () => {});
    const cancel = vi.fn<AcpRuntime["cancel"]>(async () => {});
    const setConfigOption = vi.fn<NonNullable<AcpRuntime["setConfigOption"]>>(async () => {});
    const runtime: AcpRuntime = {
      ownerAwareSessions: 1,
      ensureSession,
      runTurn,
      close,
      cancel,
      setConfigOption,
      getCapabilities: async () => ({
        controls: ["session/set_config_option"],
        configOptionKeys: ["model"],
      }),
      getStatus: async () => ({ summary: "ready" }),
      prepareFreshSession: async () => {},
    };
    registerAcpRuntimeBackend({ id: backendId, runtime });
    const manager = new AcpSessionManager();
    managerTesting.setAcpSessionManagerForTests(manager);
    await manager.initializeSession({
      cfg,
      agentId,
      sessionKey,
      agent: "qa-agent",
      mode: "persistent",
      runtimeOptions: { model: "qa-original" },
      backendId,
    });
    if (agentId === "work") {
      await manager.initializeSession({
        cfg,
        agentId: neighborScope.agentId,
        sessionKey,
        agent: "qa-agent",
        mode: "persistent",
        runtimeOptions: { model: "qa-neighbor" },
        backendId,
      });
    }
    const neighborBefore = agentId === "work" ? loadSessionEntryReadOnly(neighborScope) : undefined;
    if (custody === "locked") {
      await updateSessionEntry(scope, () => ({
        modelSelectionLocked: true,
      }));
    }
    const before = requireReadySession(manager.resolveSession({ cfg, agentId, sessionKey }));
    const previousRegistry = captureActivePluginRegistrySnapshot();
    restoreRegistry = () => {
      restoreActivePluginRegistrySnapshot(previousRegistry);
      if (previousRegistry.activeRegistry) {
        initializeGlobalHookRunner(previousRegistry.activeRegistry);
      }
    };
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: backendId,
      hookName: "reply_dispatch",
      handler: tryDispatchAcpReplyHook,
      source: "test",
      eligibleDispatchKinds: ["acp"],
    });
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    vi.spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle").mockReturnValue(registry);
    const delivered: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        if (payload.text) {
          delivered.push(payload.text);
        }
      },
    });
    const ctx = finalizeInboundContext({
      Body: "/new fixture/alternate explain the result",
      BodyForCommands: "/new fixture/alternate explain the result",
      BodyForAgent: "/new fixture/alternate explain the result",
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
      SessionKey: sessionKey,
      AgentId: agentId,
      CommandTargetSessionKey: sessionKey,
      CommandSource: "native",
      CommandAuthorized: true,
      GatewayClientScopes: ["operator.admin"],
    });
    const onSessionPrepared = vi.fn();
    const dispatch = dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyOptions: {
        expectedExistingSessionId:
          custody === "stale-admission" ? "retired-session" : before.entry.sessionId,
        onSessionPrepared,
      },
      replyResolver: (input, options) => getReplyFromConfig(input, options, cfg),
    });
    if (custody === "stale-admission") {
      await expect(dispatch).rejects.toThrow(/changed while starting work/i);
    } else {
      await dispatch;
    }
    await dispatcher.waitForIdle();
    const after = loadSessionEntryReadOnly(scope);
    if (neighborBefore) {
      expect(loadSessionEntryReadOnly(neighborScope)).toEqual(neighborBefore);
    }
    expect(after?.executionSelection).toEqual(before.entry.executionSelection);
    if (custody === "unlocked") {
      expect(setConfigOption).toHaveBeenCalledExactlyOnceWith({
        handle: expect.objectContaining({ agentId }),
        key: "model",
        value: "qa-original",
      });
      expect(close).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledWith(
        expect.objectContaining({ handle: expect.objectContaining({ agentId }) }),
      );
      expect(after?.sessionId).toBe(before.entry.sessionId);
      expect(after?.lifecycleRevision).toEqual(expect.any(String));
      expect(after?.lifecycleRevision).not.toBe(before.entry.lifecycleRevision);
      expect(runTurn, delivered.join("\n")).toHaveBeenCalledOnce();
      expect(runTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "fixture/alternate explain the result",
          handle: expect.objectContaining({ agentId }),
        }),
      );
      expect(ensureSession.mock.calls.at(-1)?.[0].model).toBe("qa-original");
      expect(delivered).toContain("The reset tail ran.");
      expect(onSessionPrepared).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: after?.sessionId }),
      );
    } else {
      expect(setConfigOption).not.toHaveBeenCalled();
      expect(after?.sessionId).toBe(before.entry.sessionId);
      expect(after?.lifecycleRevision).toBe(before.entry.lifecycleRevision);
      expect(close).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(runTurn).not.toHaveBeenCalled();
      if (custody === "locked") {
        expect(delivered.join("\n")).toContain(MODEL_SELECTION_LOCKED_RESET_MESSAGE);
      }
    }
  },
);
