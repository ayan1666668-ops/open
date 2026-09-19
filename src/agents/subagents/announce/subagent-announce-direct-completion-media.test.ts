// Direct completion-media tests cover the text fallback that carries child
// completion text and attachments to a requester when the agent handoff cannot.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { callGateway as runtimeCallGateway } from "../../../gateway/call.js";
import { OutboundDeliveryError } from "../../../infra/outbound/deliver-types.js";
import { sendMessage as runtimeSendMessage } from "../../../infra/outbound/message.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import type {
  EmbeddedAgentQueueMessageOptions,
  EmbeddedAgentQueueMessageOutcome,
} from "../../embedded-agent-runner/runs.js";
import type { AgentInternalEvent } from "../../internal-events.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../internal-runtime-context.js";
import {
  expectDeliveryPath,
  expectRecordFields,
  mockCallArg,
  taskCompletionEvents,
} from "../../subagent-test-fixtures.test-helpers.js";
import { deliverSubagentAnnouncement, testing } from "./subagent-announce-delivery.test-support.js";

const sessionDeliveryQueueMocks = vi.hoisted(() => ({
  enqueueClaimedSessionDelivery: vi.fn(
    (_payload: unknown, _leaseMs: number, _queueContext: OpenClawStateWorkerContext) => ({
      id: "session-delivery-media",
      claimed: true,
      status: "pending" as "pending" | "failed" | "completed" | "unknown",
    }),
  ),
  releaseSessionDeliveryClaim: vi.fn(async () => {}),
  scheduleSessionDelivery: vi.fn(async () => true),
}));

vi.mock("../completion/subagent-completion-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../completion/subagent-completion-delivery.js")>()),
  admitCorrelatedSubagentSessionDelivery: (params: { payload: Record<string, unknown> }) =>
    sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery(
      params.payload,
      125_000,
      captureOpenClawStateWorkerContext(),
    ),
}));

vi.mock("../../../infra/session-delivery-queue-storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/session-delivery-queue-storage.js")>()),
  enqueueClaimedSessionDelivery: async (
    ...args: Parameters<typeof sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery>
  ) => sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery(...args),
  releaseSessionDeliveryClaim: sessionDeliveryQueueMocks.releaseSessionDeliveryClaim,
}));

vi.mock("../../../infra/session-delivery-queue-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/session-delivery-queue-runtime.js")>()),
  scheduleSessionDelivery: sessionDeliveryQueueMocks.scheduleSessionDelivery,
}));

type QueueEmbeddedAgentMessageWithOutcome = (
  sessionId: string,
  message: string,
  options?: EmbeddedAgentQueueMessageOptions,
) => EmbeddedAgentQueueMessageOutcome | Promise<EmbeddedAgentQueueMessageOutcome>;

const sentDeliveryStatus = { status: "sent", resultCount: 1 } as const;

function createGatewayMock(response: Record<string, unknown> = {}, onCall?: () => void) {
  return vi.fn(async (opts: Parameters<typeof runtimeCallGateway>[0]) => {
    onCall?.();
    opts.onAccepted?.({ status: "accepted" });
    return response;
  }) as unknown as typeof runtimeCallGateway;
}

function createPayloadGatewayMock(...payloads: Record<string, unknown>[]) {
  return createGatewayMock({
    result: { payloads, ...(payloads.length > 0 ? { deliveryStatus: sentDeliveryStatus } : {}) },
  });
}

function createSendMessageMock() {
  return vi.fn(async () => ({
    channel: "slack",
    to: "channel:C123",
    via: "direct" as const,
    mediaUrl: null,
    result: { messageId: "msg-1" },
  })) as unknown as typeof runtimeSendMessage;
}

async function deliverDiscordDirectMessageCompletion(params: {
  callGateway: typeof runtimeCallGateway;
  sendMessage?: typeof runtimeSendMessage;
  completionTarget?: "parent";
  currentRequesterSessionId?: string | null;
  internalEvents?: AgentInternalEvent[];
  isActive?: boolean;
  requesterSessionKey?: string;
  requesterAgentId?: string;
  runtimeConfig?: Record<string, unknown>;
  queueEmbeddedAgentMessageWithOutcome?: QueueEmbeddedAgentMessageWithOutcome;
  sourceSessionKey?: string;
  sourceTool?: string;
  signal?: AbortSignal;
  onDeliveryResult?: Parameters<typeof deliverSubagentAnnouncement>[0]["onDeliveryResult"];
  isSourceSessionEffectsAllowed?: () => boolean;
}) {
  const origin = {
    channel: "discord",
    to: "dm:U123",
    accountId: "acct-1",
  };
  const requesterSessionKey = params.requesterSessionKey ?? "agent:main:discord:dm:U123";
  testing.setDepsForTest({
    callGateway: params.callGateway,
    getRequesterSessionActivity: () => ({
      sessionId:
        params.currentRequesterSessionId === null
          ? undefined
          : (params.currentRequesterSessionId ?? "requester-session-dm"),
      isActive: params.isActive === true,
    }),
    getRuntimeConfig: () => (params.runtimeConfig ?? {}) as never,
    sendMessage: params.sendMessage ?? runtimeSendMessage,
    ...(params.queueEmbeddedAgentMessageWithOutcome
      ? { queueEmbeddedAgentMessageWithOutcome: params.queueEmbeddedAgentMessageWithOutcome }
      : {}),
  });

  return deliverSubagentAnnouncement({
    requesterSessionKey,
    requesterAgentId: params.requesterAgentId,
    targetRequesterSessionKey: requesterSessionKey,
    triggerMessage: "child done",
    steerMessage: "child done",
    requesterSessionOrigin: origin,
    completionDirectOrigin: origin,
    directOrigin: origin,
    requesterIsSubagent: false,
    expectsCompletionMessage: true,
    ...(params.completionTarget
      ? {
          completionTarget: params.completionTarget,
          completionRequesterSessionId: "requester-session-dm",
        }
      : {}),
    bestEffortDeliver: true,
    directIdempotencyKey: "announce-dm-fallback-empty",
    internalEvents: params.internalEvents,
    sourceRunId: "run-generated-media",
    sourceSessionKey: params.sourceSessionKey,
    sourceTool: params.sourceTool,
    signal: params.signal,
    onDeliveryResult: params.onDeliveryResult,
    isSourceSessionEffectsAllowed: params.isSourceSessionEffectsAllowed,
  });
}

afterEach(() => {
  vi.useRealTimers();
  setActivePluginRegistry(createTestRegistry());
  testing.setDepsForTest();
  sessionDeliveryQueueMocks.enqueueClaimedSessionDelivery.mockClear();
  sessionDeliveryQueueMocks.releaseSessionDeliveryClaim.mockClear();
  sessionDeliveryQueueMocks.scheduleSessionDelivery.mockClear();
});

describe("subagent announce direct completion media", () => {
  it("stages structured completion media through the direct text fallback", async () => {
    const callGateway = createPayloadGatewayMock();
    const sendMessage = createSendMessageMock();
    const attachment = {
      type: "image" as const,
      path: "/tmp/generated-daily.png",
      name: "generated-daily.png",
      mimeType: "image/png",
      sizeBytes: 1234,
    };

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        result: "Generated 1 image.",
        mediaUrls: ["/tmp/generated-daily.png"],
        attachments: [attachment],
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Generated 1 image.",
        mediaUrls: ["/tmp/generated-daily.png"],
      }),
    );
  });

  it("delivers caption-less completion media through the direct text fallback", async () => {
    const callGateway = createPayloadGatewayMock();
    const sendMessage = createSendMessageMock();

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        result: "",
        mediaUrls: ["/tmp/generated-daily.png"],
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "",
        mediaUrls: ["/tmp/generated-daily.png"],
      }),
    );
  });

  it("does not attach child media to a failed completion notice", async () => {
    const childSessionKey = "agent:worker:subagent:failed-media-child";
    const callGateway = vi.fn(async () => {
      throw new Error("provider rejected requester synthesis");
    }) as unknown as typeof runtimeCallGateway;
    const sendMessage = createSendMessageMock();

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      sourceSessionKey: childSessionKey,
      sourceTool: "subagent_announce",
      internalEvents: taskCompletionEvents({
        childSessionKey,
        childSessionId: "failed-media-child-session-id",
        status: "error",
        statusLabel: "failed: all models failed",
        result: "(no output)",
        mediaUrls: ["/tmp/partial-daily.png"],
      }),
    });

    expectRecordFields(result, { delivered: true, path: "direct" });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(mockCallArg(sendMessage, 0, 0)).not.toHaveProperty("mediaUrls");
  });

  it("reports a terminal partial failure when completion media fails after an identified send", async () => {
    const callGateway = createPayloadGatewayMock();
    const onDeliveryResult = vi.fn();
    const sendMessage = vi.fn(async (params: Parameters<typeof runtimeSendMessage>[0]) => {
      await params.onDeliveryResult?.({ channel: "discord", messageId: "msg-1" });
      throw new OutboundDeliveryError("second attachment failed", {
        cause: new Error("platform rejected media"),
        results: [{ channel: "discord", messageId: "msg-1" }],
      });
    }) as unknown as typeof runtimeSendMessage;

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      onDeliveryResult,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        result: "Generated 1 image.",
        mediaUrls: ["/tmp/generated-daily.png"],
      }),
    });

    expectRecordFields(result, {
      delivered: false,
      path: "direct",
      terminal: true,
      missingMediaUrls: ["/tmp/generated-daily.png"],
    });
    expect(onDeliveryResult).not.toHaveBeenCalled();
  });

  it("forwards announcement-reply media through the direct text fallback", async () => {
    // Normal producer events carry no structured media (subagent-announce.ts);
    // media owned only by the requester-agent reply must still reach send.
    const callGateway = createGatewayMock({
      result: {
        payloads: [
          {
            text: "Image ready\nMEDIA:/tmp/directive.png",
            mediaUrls: ["/tmp/structured.png", "/tmp/directive.png"],
          },
        ],
      },
    });
    const sendMessage = createSendMessageMock();

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Image ready",
        mediaUrls: ["/tmp/structured.png", "/tmp/directive.png"],
      }),
    );
  });

  it("excludes hidden runtime context media from the payload fallback", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [
          {
            text: [
              "Image ready",
              "MEDIA:/tmp/visible-directive.png",
              INTERNAL_RUNTIME_CONTEXT_BEGIN,
              "This context is runtime-generated, not user-authored. Keep internal details private.",
              "MEDIA:/tmp/hidden-context.png",
              INTERNAL_RUNTIME_CONTEXT_END,
            ].join("\n"),
            mediaUrls: ["/tmp/structured.png"],
          },
        ],
      },
    });
    const sendMessage = createSendMessageMock();

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: taskCompletionEvents({ childSessionId: "child-session-id" }),
    });

    expectDeliveryPath(result, "direct");
    // Hidden context may not contribute attachments; visible directives still do.
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Image ready",
        mediaUrls: ["/tmp/structured.png", "/tmp/visible-directive.png"],
      }),
    );
  });

  it("excludes hidden runtime context media from the completion event result", async () => {
    const callGateway = createPayloadGatewayMock();
    const sendMessage = createSendMessageMock();

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        result: [
          "Generated 1 image.",
          INTERNAL_RUNTIME_CONTEXT_BEGIN,
          "This context is runtime-generated, not user-authored. Keep internal details private.",
          "MEDIA:/tmp/hidden-context.png",
          INTERNAL_RUNTIME_CONTEXT_END,
        ].join("\n"),
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Generated 1 image." }),
    );
    expect(mockCallArg(sendMessage, 0, 0)).not.toHaveProperty("mediaUrls");
  });

  it("delivers a visible MEDIA directive from the completion event result", async () => {
    const callGateway = createPayloadGatewayMock();
    const sendMessage = createSendMessageMock();

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        result: "Generated 1 image.\nMEDIA:/tmp/visible-directive.png",
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Generated 1 image.",
        mediaUrls: ["/tmp/visible-directive.png"],
      }),
    );
  });

  // Matched pair: identical inputs apart from the producer-owned absence fact.
  // They fail if direct delivery goes back to matching display wording.
  it("delivers a genuine completion result that only reads like the placeholder", async () => {
    const callGateway = createPayloadGatewayMock();
    const sendMessage = createSendMessageMock();

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        result: "(no output)",
      }),
    });

    expectDeliveryPath(result, "direct");
    expect(mockCallArg(sendMessage, 0, 0).content).toBe("(no output)");
  });

  it("does not deliver a completion result the producer recorded as absent", async () => {
    const callGateway = createPayloadGatewayMock();
    const sendMessage = createSendMessageMock();

    await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        result: "(no output)",
        noVisibleResult: true,
      }),
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("settles completion media at the complete-payload boundary before mirroring settles", async () => {
    const callGateway = createPayloadGatewayMock();
    let releaseMirror!: () => void;
    const mirrorPending = new Promise<void>((resolve) => {
      releaseMirror = resolve;
    });
    let resolvePayloadSettled!: () => void;
    const payloadSettled = new Promise<void>((resolve) => {
      resolvePayloadSettled = resolve;
    });
    const onDeliveryResult = vi.fn(() => resolvePayloadSettled());
    const sendMessage = vi.fn(async (params: Parameters<typeof runtimeSendMessage>[0]) => {
      // Per-attachment platform evidence arrives first and must not settle the
      // batch: a later attachment can still fail.
      await params.onDeliveryResult?.({ channel: "discord", messageId: "msg-1" });
      expect(onDeliveryResult).not.toHaveBeenCalled();
      // The complete-payload boundary reports the finished media fanout while
      // transcript mirroring still holds sendMessage open.
      params.onDeliveredPayload?.({
        text: "Generated 1 image.",
        mediaUrls: ["/tmp/generated-daily.png"],
      });
      await mirrorPending;
      return {
        channel: "discord",
        to: "dm:U123",
        via: "direct" as const,
        mediaUrl: null,
        result: { channel: "discord", messageId: "msg-2" },
      };
    }) as unknown as typeof runtimeSendMessage;

    const delivery = deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      onDeliveryResult,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        result: "Generated 1 image.",
        mediaUrls: ["/tmp/generated-daily.png"],
      }),
    });
    await payloadSettled;

    expect(onDeliveryResult).toHaveBeenCalledTimes(1);
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({ delivered: true, path: "direct", deliveredAt: expect.any(Number) }),
    );
    releaseMirror();
    await expect(delivery).resolves.toMatchObject({ delivered: true, path: "direct" });
    expect(onDeliveryResult).toHaveBeenCalledTimes(1);
  });

  it("keeps a settled media batch delivered when later send bookkeeping fails", async () => {
    const callGateway = createPayloadGatewayMock();
    const onDeliveryResult = vi.fn();
    const sendMessage = vi.fn(async (params: Parameters<typeof runtimeSendMessage>[0]) => {
      params.onDeliveredPayload?.({
        text: "Generated 1 image.",
        mediaUrls: ["/tmp/generated-daily.png"],
      });
      throw new Error("post-send bookkeeping failed");
    }) as unknown as typeof runtimeSendMessage;

    const result = await deliverDiscordDirectMessageCompletion({
      callGateway,
      sendMessage,
      onDeliveryResult,
      internalEvents: taskCompletionEvents({
        childSessionId: "child-session-id",
        result: "Generated 1 image.",
        mediaUrls: ["/tmp/generated-daily.png"],
      }),
    });

    expectRecordFields(result, { delivered: true, path: "direct" });
    expect(onDeliveryResult).toHaveBeenCalledTimes(1);
  });
});
