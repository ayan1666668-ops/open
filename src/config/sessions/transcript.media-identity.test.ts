import { describe, expect, it } from "vitest";
import { loadTranscriptEvents, replaceSessionEntry } from "./session-accessor.js";
import { readTranscriptEventMessage } from "./session-accessor.sqlite-read.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { appendAssistantMessageToSessionTranscript } from "./transcript.js";

describe("assistant mirror media identity", () => {
  const fixture = useTempSessionsFixture("transcript-media-identity-");

  it.each([false, true])("records media identity with content=%s", async (explicitContent) => {
    const scope = {
      agentId: "main",
      sessionId: "media-session",
      sessionKey: "agent:main:media",
      storePath: fixture.storePath(),
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const params = {
      ...scope,
      expectedSessionId: scope.sessionId,
      idempotencyKey: "media-reply",
      text: "Chart",
      ...(explicitContent ? { content: [{ type: "text" as const, text: "Chart" }] } : {}),
      mediaUrls: ["https://example.com/chart.png"],
    };
    const first = await appendAssistantMessageToSessionTranscript(params);
    expect(first.ok).toBe(true);
    expect(await appendAssistantMessageToSessionTranscript(params)).toEqual(first);
    await expect(
      appendAssistantMessageToSessionTranscript({
        ...params,
        mediaUrls: ["https://different.example/chart.png"],
      }),
    ).rejects.toThrow("conflicts with the admitted message");
    await expect(
      appendAssistantMessageToSessionTranscript({
        ...params,
        text: "Different",
        ...(explicitContent ? { content: [{ type: "text" as const, text: "Different" }] } : {}),
      }),
    ).rejects.toThrow("conflicts with the admitted message");
    const events = await loadTranscriptEvents(scope);
    expect(
      events.filter((event) => readTranscriptEventMessage(event)?.role === "assistant"),
    ).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          role: "assistant",
          openclawDelivery: { mediaUrls: params.mediaUrls },
          content: [{ type: "text", text: explicitContent ? "Chart" : "Chart\nchart.png" }],
        }),
      }),
    ]);
  });
});
