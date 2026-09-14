import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { copyReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { createAcpReplyProjector } from "./acp-projector.js";
import { createAcpDispatchDeliveryCoordinator } from "./dispatch-acp-delivery.js";
import { prepareAcpDeliveryPayload } from "./dispatch-acp-payload.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { routeReply } from "./route-reply.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

const transport = vi.hoisted(() => ({
  send: vi.fn(async (params: { payloads: ReplyPayload[] }) =>
    params.payloads.map((_, index) => ({ channel: "telegram", messageId: `sent-${index}` })),
  ),
}));

vi.mock("../../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: transport.send,
  deliverOutboundPayloadsInternal: transport.send,
}));
vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: transport.send,
  deliverOutboundPayloadsInternal: transport.send,
}));

function createFlow(routed: boolean) {
  const cfg = createAcpTestConfig({
    acp: {
      enabled: true,
      stream: { deliveryMode: "live", tagVisibility: { available_commands_update: true } },
    },
    agents: {
      defaults: {
        blockStreamingChunk: { minChars: 1, maxChars: 20, breakPreference: "paragraph" },
      },
    },
    channels: { telegram: { textChunkLimit: 20, streaming: { chunkMode: "newline" } } },
  });
  const directPayloads: ReplyPayload[] = [];
  const sourcePayloads: ReplyPayload[] = [];
  const dispatcher = createReplyDispatcher({
    deliver: async (payload) => {
      directPayloads.push(payload);
    },
  });
  const delivery = createAcpDispatchDeliveryCoordinator({
    cfg,
    ctx: buildTestCtx({ Provider: "telegram", Surface: "telegram" }),
    dispatcher,
    inboundAudio: false,
    shouldRouteToOriginating: routed,
    ...(routed ? { originatingChannel: "telegram" as const, originatingTo: "123" } : {}),
  });
  const projector = createAcpReplyProjector({
    cfg,
    provider: "telegram",
    shouldSendToolSummaries: true,
    shouldSendFullToolDetails: false,
    deliver: (kind, payload, meta) => {
      if (kind === "block") {
        sourcePayloads.push(payload);
      }
      return delivery.deliver(kind, payload, meta);
    },
  });
  const flush = async () => {
    await projector.flush(true);
    await dispatcher.waitForIdle();
  };
  onTestFinished(async () => {
    await flush();
    dispatcher.markComplete();
  });
  return {
    cfg,
    dispatcher,
    sourcePayloads,
    emitStatus: () =>
      projector.onEvent({ type: "status", text: "Working", tag: "available_commands_update" }),
    emit: (text: string) =>
      projector.onEvent({ type: "text_delta", text, tag: "agent_message_chunk" }),
    flush,
    payloads: () =>
      routed ? transport.send.mock.calls.flatMap(([params]) => params.payloads) : directPayloads,
  };
}

describe("ACP source boundaries through real delivery preparation", () => {
  beforeEach(() => {
    transport.send.mockClear();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: createChannelTestPluginBase({ id: "telegram" }),
          source: "test",
        },
      ]),
    );
  });
  afterEach(() => setActivePluginRegistry(createTestRegistry()));

  it.each([
    { routed: false, deltas: ["First.\n", "Second."] },
    { routed: true, deltas: ["First.\n", "Second."] },
    { routed: false, deltas: ["First\n\n", "Second"] },
    { routed: true, deltas: ["First\n\n", "Second"] },
    { routed: false, deltas: ["First.\n", "\nSecond"] },
    { routed: true, deltas: ["First.\n", "\nSecond"] },
  ])("reconstructs $deltas through routed=$routed", async ({ routed, deltas }) => {
    const flow = createFlow(routed);
    for (const text of deltas) {
      await flow.emit(text);
    }
    await flow.flush();
    const payloads = flow.payloads();
    expect(payloads).toHaveLength(2);
    expect(payloads.map((payload) => payload.text).join("")).toBe(deltas.join(""));
    expect(payloads.every((payload) => payload.text?.trim() && payload.text.length <= 20)).toBe(
      true,
    );
  });

  it.each([false, true])(
    "does not let a silent first source establish routed=%s continuation",
    async (routed) => {
      const flow = createFlow(routed);
      await flow.emit("NO_REPLY\n\n");
      await flow.flush();
      expect(flow.payloads()).toEqual([]);
      await flow.emit("\nFirst.");
      await flow.flush();
      expect(flow.payloads().map((payload) => payload.text)).toEqual(["First."]);
      await flow.emit("\nSecond.");
      await flow.flush();
      expect(flow.payloads().map((payload) => payload.text)).toEqual(["First.", "\nSecond."]);
    },
  );

  it.each([false, true])(
    "does not let status output establish routed=%s source continuation",
    async (routed) => {
      const flow = createFlow(routed);
      await flow.emitStatus();
      await flow.flush();
      expect(flow.payloads()).toHaveLength(1);
      await flow.emit("\nFirst.");
      await flow.flush();
      expect(flow.payloads()).toHaveLength(2);
      expect(flow.payloads().at(-1)?.text).toBe("First.");
    },
  );

  it.each(["final", "tool"] as const)(
    "renormalizes a prepared source block reused by routeReply as %s",
    async (replyKind) => {
      const flow = createFlow(true);
      await flow.emit("First.\n");
      await flow.emit("Second.");
      await flow.flush();
      const continuation = expectDefined(flow.sourcePayloads[1], "source continuation block");
      const prepared = prepareAcpDeliveryPayload({
        cfg: flow.cfg,
        dispatcher: flow.dispatcher,
        kind: "block",
        routed: true,
        payload: copyReplyPayloadMetadata(continuation, { text: "\nCompleted answer" }),
      });
      expect(prepared.kind).toBe("deliver");
      if (prepared.kind !== "deliver") {
        throw new Error("Expected the prepared continuation");
      }
      expect(prepared.payload.text).toBe("\nCompleted answer");
      const result = await routeReply({
        cfg: flow.cfg,
        payload: prepared.payload,
        channel: "telegram",
        to: "123",
        replyKind,
        mirror: false,
      });
      expect(result).toMatchObject({ ok: true, delivered: true });
      expect(flow.payloads().at(-1)?.text).toBe("Completed answer");
    },
  );
});
