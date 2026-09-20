import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { dispatchAssembledChannelTurn } from "./lifecycle.js";
import {
  createCtx,
  createDispatch,
  createRecordInboundSession,
} from "./run-channel-turn.delivery.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("inbound durable delivery owner", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["+15555550100", "120363000000001@g.us"])(
    "sends the first reply to %s through the connected inbound registration",
    async (to) => {
      const stateDir = tempDirs.make("openclaw-inbound-delivery-owner-");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const connectedSend = vi.fn(async () => ({
        channel: "whatsapp" as const,
        messageId: "sent-1",
      }));
      const detachedSend = vi.fn(async () => {
        throw new PlatformMessageNotDispatchedError("No active WhatsApp Web listener", {
          cause: new Error("unconnected registration"),
        });
      });
      const registry = (sendText: typeof connectedSend | typeof detachedSend) =>
        createTestRegistry([
          {
            pluginId: "whatsapp",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "whatsapp",
              outbound: {
                deliveryMode: "direct",
                deliveryCapabilities: { durableFinal: { text: true, messageSendingHooks: true } },
                sendText,
              },
            }),
          },
        ]);
      const connected = registry(connectedSend);
      const detached = registry(detachedSend);
      const directFallback = vi.fn();
      let delivered: unknown;
      const dispatch = createDispatch([], { text: "pong" }, (result) => {
        delivered = result;
      });

      await withPluginRuntimeRegistryScope(connected, () =>
        dispatchAssembledChannelTurn({
          cfg: {},
          channel: "whatsapp",
          accountId: "work",
          agentId: "main",
          routeSessionKey: "agent:main:whatsapp:test",
          storePath: path.join(stateDir, "sessions.json"),
          ctxPayload: createCtx({
            SessionKey: "agent:main:whatsapp:test",
            Provider: "whatsapp",
            Surface: "whatsapp",
            From: to,
            To: to,
            OriginatingTo: to,
            ChatType: to.endsWith("@g.us") ? "group" : "direct",
          }),
          recordInboundSession: createRecordInboundSession(),
          delivery: { durable: { to }, deliver: directFallback },
          dispatchReplyWithBufferedBlockDispatcher: (params) =>
            withPluginRuntimeRegistryScope(detached, () => dispatch(params)),
        }),
      );

      expect(connectedSend).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ to, accountId: "work", text: "pong" }),
      );
      expect(detachedSend).not.toHaveBeenCalled();
      expect(directFallback).not.toHaveBeenCalled();
      expect(delivered).toMatchObject({
        visibleReplySent: true,
        receipt: { primaryPlatformMessageId: "sent-1" },
      });
    },
  );
});
