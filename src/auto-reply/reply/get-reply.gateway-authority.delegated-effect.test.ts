import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { bindAgentToolGatewayRequest } from "../../agents/tools/in-process-gateway.js";
import { buildChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../../channels/inbound-event/host-context-builder.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import { registerChannelIngressHostOwner } from "../../channels/message-access/ingress-host-owner.js";
import { resolveStableChannelMessageIngress } from "../../channels/message-access/runtime.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "../../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { initFastReplySessionState, withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { finalizeInboundContext } from "./inbound-context.js";

// Retained channel authority must expire before a delegated Gateway operation
// performs its final effect. The Gateway host stays live in every case here, so
// only the channel's own lifetime can reject the already-prepared call.

const METHOD = "sessions.list";
const SCOPE = "operator.read";

let state: OpenClawTestState | undefined;
let disposeOwner: (() => void) | undefined;
afterEach(async () => {
  disposeOwner?.();
  disposeOwner = undefined;
  await state?.cleanup();
  state = undefined;
});

function createLiveGateway(
  handler: (options: GatewayRequestHandlerOptions) => unknown,
): GatewayRequestContext {
  const context = {
    trackExecution: trackAsyncWork,
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    logGateway: { error: () => {}, warn: () => {} },
  } as unknown as GatewayRequestContext;
  context.getGatewayMethodRegistry = () =>
    createGatewayMethodRegistry([
      {
        name: METHOD,
        scope: SCOPE,
        owner: { kind: "core", area: "sessions" },
        handler: handler as never,
      },
    ]);
  return context;
}

it.each([
  { lifecycle: "live", midFlight: false, effect: true },
  { lifecycle: "unbound", midFlight: false, effect: false },
  { lifecycle: "retired", midFlight: false, effect: false },
  { lifecycle: "replaced", midFlight: false, effect: false },
  { lifecycle: "retired", midFlight: true, effect: false },
  { lifecycle: "replaced", midFlight: true, effect: false },
])(
  "rejects a prepared delegated operation before its effect when $lifecycle (mid-flight: $midFlight)",
  async ({ lifecycle, midFlight, effect }) => {
    state = await createOpenClawTestState({
      label: "channel-gateway-delegated-effect",
      env: { OPENCLAW_TEST_FAST: "0" },
    });
    const cfg = withFullRuntimeReplyConfig({
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          model: { primary: "mock-openai/gpt-5.6-luna" },
          models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
        },
      },
      plugins: { enabled: false },
      session: { dmScope: "per-channel-peer" },
    });
    await state.writeConfig(cfg);

    const effectPath = path.join(state.workspaceDir, "delegated-effect.txt");
    let handlerEntered = 0;
    let revokeMidFlight: (() => void) | undefined;
    const gatewayContext = createLiveGateway(async (options) => {
      handlerEntered += 1;
      if (midFlight) {
        await Promise.resolve();
        revokeMidFlight?.();
        await Promise.resolve();
      }
      // Production pre-commit fence every session-mutating handler runs.
      options.sessionMutationCommitGuard?.();
      fs.writeFileSync(effectPath, "delegated effect performed");
      options.respond(true, { sessions: [] });
    });
    let successorResolutions = 0;
    const successorGateway = createLiveGateway(() => {
      throw new Error("successor Gateway must not be redeemed by a retired channel binding");
    });

    let live = true;
    const owner = {
      channelId: "discord",
      record: {},
      epoch: {},
      isLive: () => live,
      // The Gateway never goes away; only the channel lifetime is revoked.
      resolveGatewayContext: () => gatewayContext,
    };
    disposeOwner = registerChannelIngressHostOwner(owner);
    const revoke = () => {
      live = false;
      if (lifecycle === "replaced") {
        disposeOwner?.();
        disposeOwner = registerChannelIngressHostOwner({
          channelId: "discord",
          record: {},
          epoch: {},
          isLive: () => true,
          resolveGatewayContext: () => {
            successorResolutions += 1;
            return successorGateway;
          },
        });
      }
    };

    const sessionKey = "agent:main:discord:direct:person-42";
    const ingress = await resolveStableChannelMessageIngress({
      channelId: "discord",
      accountId: "primary",
      subject: { stableId: "person-42" },
      conversation: { kind: "direct", id: "dm-1" },
      contextBinding: {
        agentId: "main",
        sessionKey,
        messageId: "msg-1",
        inboundEventKind: "user_request",
      },
      dmPolicy: "allowlist",
      groupPolicy: "disabled",
      allowFrom: ["person-42"],
    });
    const context = await createHostChannelInboundEventContextBuilder(
      buildChannelInboundEventContext,
      owner,
    )({
      channel: "discord",
      accountId: "primary",
      messageId: "msg-1",
      from: "discord:user:person-42",
      sender: { id: "person-42" },
      conversation: { kind: "direct", id: "dm-1", nativeChannelId: "dm-1" },
      route: { agentId: "main", routeSessionKey: sessionKey },
      reply: { to: "channel:dm-1" },
      message: { rawBody: "hello" },
      channelIngress: ingress,
    });
    const input = finalizeInboundContext(lifecycle === "unbound" ? { ...context } : context);
    const fast = initFastReplySessionState({
      ctx: input,
      cfg,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: state.workspaceDir,
    });
    const resolver = readChannelContextGatewayContextResolver(fast.sessionCtx);
    expect(resolver !== undefined).toBe(lifecycle !== "unbound");

    const outcome = await withPluginRuntimeGatewayContextResolver(resolver, async () => {
      const call = bindAgentToolGatewayRequest();
      if (midFlight) {
        revokeMidFlight = revoke;
      } else if (lifecycle !== "live") {
        revoke();
      }
      // The binding is already captured; asynchronous reply preparation follows.
      await Promise.resolve();
      try {
        await call({ method: METHOD, params: {}, scopes: [SCOPE] });
        return "accepted";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });

    expect(fs.existsSync(effectPath)).toBe(effect);
    expect(outcome === "accepted").toBe(effect);
    expect(successorResolutions).toBe(0);
    if (!effect) {
      // The handler may have started, but it must never reach its final effect.
      expect(handlerEntered).toBe(midFlight ? 1 : 0);
    }

    // The Gateway host itself is untouched: a call bound straight to a live root
    // Gateway still reaches final I/O.
    const controlPath = path.join(state.workspaceDir, "control-effect.txt");
    const controlGateway = createLiveGateway((options) => {
      options.sessionMutationCommitGuard?.();
      fs.writeFileSync(controlPath, "control effect performed");
      options.respond(true, { sessions: [] });
    });
    await withPluginRuntimeGatewayContextResolver(
      () => controlGateway,
      async () =>
        await bindAgentToolGatewayRequest()({ method: METHOD, params: {}, scopes: [SCOPE] }),
    );
    expect(fs.existsSync(controlPath)).toBe(true);
  },
);
