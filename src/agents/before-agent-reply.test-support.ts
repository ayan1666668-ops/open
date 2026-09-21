import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, type Mock, vi } from "vitest";
import { getReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.public.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { createHookRunner } from "../plugins/hooks.js";
import { createLazyPluginRuntime } from "../plugins/loader-module-runtime.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";

export function createRegisteredBeforeAgentReplyFixture(reply: ReplyPayload) {
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createLazyPluginRuntime({
      loadPluginModule: () => {
        throw new Error("Claimed replies must not load the plugin runtime");
      },
    }),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "claimed-reply-proof", origin: "bundled" });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  const handler = vi.fn(() => ({ handled: true as const, reply }));
  api.on("before_agent_reply", handler);
  const sendText = vi.fn<NonNullable<ChannelOutboundAdapter["sendText"]>>(async () => ({
    channel: "slack",
    messageId: "claimed-text-delivered",
  }));
  const sendMedia = vi.fn<NonNullable<ChannelOutboundAdapter["sendMedia"]>>(async () => ({
    channel: "slack",
    messageId: "claimed-media-delivered",
  }));
  api.registerChannel({
    plugin: {
      ...createChannelTestPluginBase({
        id: "slack",
        label: "Slack",
        config: { listAccountIds: () => [], resolveAccount: () => ({}) },
      }),
      outbound: { deliveryMode: "direct", sendText, sendMedia },
    },
  });
  return {
    registry: builder.registry,
    hookRunner: createHookRunner(builder.registry),
    handler,
    sendText,
    sendMedia,
  };
}

export async function expectClaimedReplyPersisted(params: {
  result: { payloads?: ReplyPayload[] };
  reply: ReplyPayload;
  transcript: string;
  sessionTarget: Parameters<typeof loadTranscriptEvents>[0];
  runId: string;
}): Promise<{
  payload: ReplyPayload;
  beforeDelivery: Awaited<ReturnType<typeof loadTranscriptEvents>>;
}> {
  const payload = expectDefined(params.result.payloads?.[0], "expected claimed reply payload");
  expect(payload).toMatchObject(params.reply);
  const events = await loadTranscriptEvents(params.sessionTarget);
  const assistantMessages = events.filter(
    (event) => isRecord(event) && isRecord(event.message) && event.message.role === "assistant",
  );
  expect(assistantMessages).toHaveLength(1);
  expect(assistantMessages).toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({ type: "text", text: params.transcript }),
        ]),
      }),
    }),
  );
  expect(getReplyPayloadMetadata(payload)).toMatchObject({
    assistantTranscriptOwned: true,
    assistantTranscriptIdempotencyKey: `cli-assistant:${params.runId}`,
    heartbeatScratchProposal: "preserved plugin metadata",
  });
  return { payload, beforeDelivery: events };
}

export function expectClaimedReplyDelivered(params: {
  reply: ReplyPayload;
  sendText: Mock<NonNullable<ChannelOutboundAdapter["sendText"]>>;
  sendMedia: Mock<NonNullable<ChannelOutboundAdapter["sendMedia"]>>;
}): void {
  const mediaUrls = params.reply.mediaUrls?.length
    ? params.reply.mediaUrls
    : params.reply.mediaUrl
      ? [params.reply.mediaUrl]
      : [];
  if (mediaUrls.length > 0) {
    expect(params.sendText).not.toHaveBeenCalled();
    expect(params.sendMedia).toHaveBeenCalledTimes(mediaUrls.length);
    expect(params.sendMedia.mock.calls.map(([context]) => context.mediaUrl)).toEqual(mediaUrls);
    expect(params.sendMedia.mock.calls[0]?.[0].text).toBe(params.reply.text ?? "");
    return;
  }
  expect(params.sendMedia).not.toHaveBeenCalled();
  expect(params.sendText).toHaveBeenCalledTimes(1);
  expect(params.sendText).toHaveBeenCalledWith(
    expect.objectContaining({ text: params.reply.text }),
  );
}
