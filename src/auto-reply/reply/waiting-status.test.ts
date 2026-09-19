import { describe, expect, it } from "vitest";
import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { buildWaitingStatusPayload } from "./waiting-status.js";

describe("buildWaitingStatusPayload", () => {
  const baseParams = {
    completion: resolveReplyCompletion("required", "pending"),
    yielded: true,
    yieldAcknowledgment: " Research started; results will follow. ",
    hasVisibleMessageDelivery: false,
  } as const;

  it("builds an explicit waiting status", () => {
    const payload = buildWaitingStatusPayload(baseParams);

    expect(payload).toEqual({
      text: "Research started; results will follow.",
    });
    expect(getReplyPayloadMetadata(payload ?? {})?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it.each([{ yielded: true }, { yielded: false, continuationPending: true }])(
    "keeps required pending work visible without model output: %j",
    (pending) => {
      const payload = buildWaitingStatusPayload({
        ...baseParams,
        ...pending,
        yieldAcknowledgment: undefined,
      });

      expect(payload).toEqual({ text: expect.stringMatching(/\S/) });
      expect(getReplyPayloadMetadata(payload ?? {})).toMatchObject({
        deliverDespiteSourceReplySuppression: true,
        ...("continuationPending" in pending ? { continuationStatus: true } : {}),
      });
    },
  );

  it.each([
    { label: "turn without continuation", overrides: { yielded: false } },
    {
      label: "optional continuation",
      overrides: { completion: resolveReplyCompletion("optional", "pending") },
    },
    ...(["ready", "delivered", "blocked", "empty"] as const).map((evidence) => ({
      label: `${evidence} completion`,
      overrides: { completion: resolveReplyCompletion("required", evidence) },
    })),
    { label: "visible message delivery", overrides: { hasVisibleMessageDelivery: true } },
  ])("suppresses the status for a $label", ({ overrides }) => {
    expect(buildWaitingStatusPayload({ ...baseParams, ...overrides })).toBeUndefined();
    expect(
      buildWaitingStatusPayload({ ...baseParams, yieldAcknowledgment: undefined, ...overrides }),
    ).toBeUndefined();
  });
});
