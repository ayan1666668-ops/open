// @vitest-environment node
import { createSessionProjection } from "@openclaw/gateway-client/browser";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it } from "vitest";
import { buildChatItems, type BuildChatItemsProps } from "./chat-thread-build.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import { buildMessageItems } from "./chat-thread-items.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";
import { coalesceToolActivityMessages } from "./chat-tool-activity-coalesce.ts";
import { getChatSessionProjection, publishChatSessionProjection } from "./history-merge.ts";

const saved = {
  role: "assistant",
  content: "Ready.",
  timestamp: 2,
  __openclaw: { id: "answer", seq: 2 },
};
function props(messages: unknown[]): BuildChatItemsProps {
  return {
    paneId: "display-run",
    sessionKey: "agent:main:main",
    messages,
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
  };
}

describe("receipt-owned display run", () => {
  beforeEach(() => resetChatThreadState());

  it("invalidates cached grouping on metadata-only publication without altering saved bytes", () => {
    const owner = { sessionKey: "agent:main:main", chatMessages: [saved] };
    const original = getChatSessionProjection(owner);
    const input = props(owner.chatMessages);
    const before = buildCachedChatItems({ ...input, projectionEntries: original.entries });
    const next = publishChatSessionProjection(owner, original, {
      displayRunIds: new Map([[saved, "run-1"]]),
    });
    const after = buildCachedChatItems({ ...input, projectionEntries: next.entries });
    expect(next.messages).toBe(original.messages);
    expect(next.entries).not.toBe(original.entries);
    expect(before[0]).toMatchObject({ kind: "group" });
    expect(before[0] && "runId" in before[0] ? before[0].runId : undefined).toBeUndefined();
    expect(after[0]).toMatchObject({ kind: "group", runId: "run-1" });
    expect(owner.chatMessages).toEqual([saved]);
    expect(JSON.stringify(owner.chatMessages)).not.toContain("displayRunId");
  });

  it("uses canonical run ownership and never trusts a raw message display field", () => {
    const forged = { ...saved, displayRunId: "forged" };
    expect(buildMessageItems([forged])[0]).not.toHaveProperty("displayRunId");
    expect(buildMessageItems([forged], undefined, new Map([[forged, "receipt"]]))[0]).toMatchObject(
      { displayRunId: "receipt" },
    );
    const entries = createSessionProjection({}, [forged]).entries;
    expect(
      buildChatItems({ ...props([forged]), projectionEntries: entries })[0],
    ).not.toHaveProperty("runId");
    const canonical = { ...saved, __openclaw: { ...saved["__openclaw"], runId: "canonical" } };
    expect(
      groupMessages([
        { kind: "message", key: "answer", message: canonical, displayRunId: "receipt" },
      ])[0],
    ).toMatchObject({ runId: "canonical" });
    expect(
      groupMessages([
        {
          kind: "message",
          key: "user",
          message: { role: "user", content: "Ask" },
          displayRunId: "receipt",
        },
      ])[0],
    ).not.toHaveProperty("runId");
  });

  it("carries prepared ownership through canvas enrichment", () => {
    const answer = { ...saved, content: '[embed ref="cv_receipt" title="Widget" /]\n\nReady.' };
    const tool = {
      role: "toolResult",
      toolCallId: "canvas-call",
      toolName: "show_widget",
      timestamp: 1,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            kind: "canvas",
            view: {
              backend: "canvas",
              id: "cv_receipt",
              url: "/__openclaw__/canvas/documents/cv_receipt/index.html",
              title: "Widget",
            },
            presentation: { target: "assistant_message" },
          }),
        },
      ],
    };
    const messages = [tool, answer];
    const projection = createSessionProjection({}, messages);
    expectDefined(projection.entries[1], "saved entry").displayRunId = "run-1";
    const groups = buildChatItems({
      ...props(messages),
      projectionEntries: projection.entries,
    })
      .filter((item) => item.kind === "group")
      .filter((item) => item.role === "assistant");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.runId).toBe("run-1");
    expect(groups[0]?.messages[0]?.message).not.toBe(answer);
    expect(groups[0]?.messages[0]?.message).toMatchObject({
      content: expect.arrayContaining([expect.objectContaining({ type: "canvas" })]),
    });
  });

  it("carries prepared ownership through synthesized tool activity", () => {
    const call = {
      role: "assistant",
      content: [{ type: "tool_use", id: "call-1", name: "read", input: { path: "README.md" } }],
    };
    const result = {
      role: "assistant",
      content: [
        { type: "tool_result", id: "call-1", name: "read", content: "Contents" },
        { type: "text", text: "Ready." },
      ],
    };
    const prepared = coalesceToolActivityMessages([
      { kind: "message", key: "call", message: call },
      { kind: "message", key: "result", message: result, displayRunId: "run-1" },
    ]);
    const groups = groupMessages(prepared)
      .filter((item) => item.kind === "group")
      .filter((item) => item.role === "assistant");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.runId).toBe("run-1");
    const retained = expectDefined(groups[0]?.messages[0]?.message, "assistant remainder");
    expect(retained).not.toBe(result);
    expect(retained).toMatchObject({ content: [{ type: "text", text: "Ready." }] });
  });
});
