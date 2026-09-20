import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundContext } from "../../channels/plugins/types.adapters.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { revokePluginRecord } from "../../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createOutboundTestPlugin } from "../../test-utils/channel-plugins.js";
import {
  bindInboundChannelDelivery,
  createChannelHandler,
  resolveOutboundDurableFinalDeliverySupport,
} from "./deliver-channel.js";

const instances: PluginInstance[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});

function createManagedChannel(params: {
  channel?: string;
  label: string;
  registry?: PluginRegistry;
  onSend?: () => void;
}) {
  const channel = params.channel ?? "connected-channel";
  const registry = params.registry ?? createEmptyPluginRegistry();
  const record = createPluginRecord({ id: `${channel}-${params.label}` });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  instances.push(instance);
  const sendText = vi.fn(async (_ctx: ChannelOutboundContext) => {
    params.onSend?.();
    return { channel, messageId: params.label };
  });
  const plugin = instance.wrap(
    createOutboundTestPlugin({
      id: channel,
      outbound: {
        deliveryMode: "direct",
        deliveryCapabilities: { durableFinal: { text: true } },
        sendText,
      },
    }),
  );
  registry.channels.push({ pluginId: record.id, source: record.source, plugin });
  return { channel, registry, record, sendText };
}

describe("inbound channel delivery registration", () => {
  it("preserves the current caller scope while invoking the captured managed adapter", async () => {
    const staleRevalidate = vi.fn(async () => {});
    const revalidate = vi.fn(async () => {});
    const signal = new AbortController().signal;
    const hasCurrentClientAuthority = () => true;
    const inbound = createManagedChannel({
      label: "connected",
      onSend: () => {
        const scope = getPluginRuntimeGatewayRequestScope();
        expect(scope?.pluginRegistry).toBe(inbound.registry);
        expect(scope?.revalidate).toBe(revalidate);
        expect(scope?.signal).toBe(signal);
        expect(scope?.hasCurrentClientAuthority).toBe(hasCurrentClientAuthority);
      },
    });
    const detached = createManagedChannel({ label: "detached" });
    const runInboundDelivery = withPluginRuntimeGatewayRequestScope(
      {
        isWebchatConnect: () => false,
        pluginRegistry: inbound.registry,
        revalidate: staleRevalidate,
      },
      () => bindInboundChannelDelivery(inbound.channel),
    );
    const currentScope = {
      isWebchatConnect: () => false,
      pluginRegistry: detached.registry,
      revalidate,
      signal,
      hasCurrentClientAuthority,
    };

    await withPluginRuntimeGatewayRequestScope(currentScope, async () => {
      await runInboundDelivery(async () => {
        // Policy hooks retain the agent registry; only adapter invocation selects the channel owner.
        expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(detached.registry);
        await expect(
          resolveOutboundDurableFinalDeliverySupport({
            cfg: {},
            channel: inbound.channel,
            requirements: { text: true },
          }),
        ).resolves.toMatchObject({ ok: true });
        const handler = await createChannelHandler({
          cfg: {},
          channel: inbound.channel,
          to: "recipient",
        });
        await expect(handler.sendText("pong")).resolves.toMatchObject({ messageId: "connected" });
        expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(detached.registry);
      });
      expect(getPluginRuntimeGatewayRequestScope()).toBe(currentScope);
    });
    expect(inbound.sendText).toHaveBeenCalledOnce();
    expect(detached.sendText).not.toHaveBeenCalled();
    expect(staleRevalidate).not.toHaveBeenCalled();
  });

  it("leaves other channel sends with their current registration", async () => {
    const inbound = createManagedChannel({ label: "connected" });
    const detached = createManagedChannel({ label: "detached" });
    const other = createManagedChannel({
      channel: "other-channel",
      label: "other",
      registry: detached.registry,
    });
    const runInboundDelivery = withPluginRuntimeRegistryScope(inbound.registry, () =>
      bindInboundChannelDelivery(inbound.channel),
    );

    await withPluginRuntimeRegistryScope(detached.registry, () =>
      runInboundDelivery(async () => {
        const handler = await createChannelHandler({ cfg: {}, channel: other.channel, to: "room" });
        await expect(handler.sendText("hello")).resolves.toMatchObject({ messageId: "other" });
      }),
    );
    expect(other.sendText).toHaveBeenCalledOnce();
    expect(inbound.sendText).not.toHaveBeenCalled();
    expect(detached.sendText).not.toHaveBeenCalled();
  });

  it("does not revive a revoked adapter or fall through to a same-id registration", async () => {
    const inbound = createManagedChannel({ label: "connected" });
    const detached = createManagedChannel({ label: "detached" });
    const runInboundDelivery = withPluginRuntimeRegistryScope(inbound.registry, () =>
      bindInboundChannelDelivery(inbound.channel),
    );

    await withPluginRuntimeRegistryScope(detached.registry, () =>
      runInboundDelivery(async () => {
        const handler = await createChannelHandler({
          cfg: {},
          channel: inbound.channel,
          to: "recipient",
        });
        revokePluginRecord(inbound.registry, inbound.record);
        await expect(handler.sendText("must not send")).rejects.toThrow(/reloaded or disabled/);
      }),
    );
    expect(inbound.sendText).not.toHaveBeenCalled();
    expect(detached.sendText).not.toHaveBeenCalled();
  });
});
