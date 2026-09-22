/* @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { buildPendingInputItems } from "./chat-pending-inputs.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { resetChatThreadState } from "./chat-thread.ts";

const sessionKey = "agent:main:system-notices";
const input: ChatPendingInputsPage["items"][number] = {
  id: "input-1",
  runId: "run-queued",
  acceptedAt: 100,
  state: "queued",
  message: { role: "user", content: "Keep my accepted input", timestamp: 100 },
};

afterEach(() => resetChatThreadState());

describe("system-notice projection across input promotion", () => {
  it.each([
    {
      sourceTool: "main_session_restart_recovery",
      label: "System · restart recovery",
      startsTurn: true,
    },
    {
      sourceTool: "cli_harness_context",
      label: "System · injected context",
      startsTurn: undefined,
    },
    { sourceTool: "unknown_system_source", label: "System", startsTurn: true },
  ])(
    "projects pending $sourceTool with the history notice contract",
    ({ sourceTool, label, startsTurn }) => {
      const items = buildPendingInputItems([
        {
          ...input,
          state: "queued",
          message: {
            role: "user",
            timestamp: 100,
            content: "[System] Resume safely.",
            provenance: { kind: "internal_system", sourceTool },
          },
        },
      ]);
      expect(items).toEqual([expect.objectContaining({ kind: "notice", label })]);
      expect(items[0]).toHaveProperty("timestamp", 100);
      expect(items[0]).toEqual(expect.not.objectContaining({ kind: "message" }));
      if (items[0]?.kind === "notice") {
        expect(items[0].startsTurn).toBe(startsTurn);
        expect(items[0].collapsedBody).toBe(
          sourceTool === "cli_harness_context" ? true : undefined,
        );
        expect(items[0].text).toBe(
          sourceTool === "main_session_restart_recovery"
            ? "Turn interrupted by a gateway restart — asked the agent to resume and finish the response."
            : "Resume safely.",
        );
      }
    },
  );

  it("does not turn a user's System prefix into system provenance", () => {
    const message = { role: "user", content: "[System] My quoted example" };
    expect(buildPendingInputItems([{ ...input, state: "queued", message }])).toEqual([
      expect.objectContaining({ kind: "message", message }),
    ]);
  });

  it.each([false, true])("promotes pending input exactly once (system=%s)", (system) => {
    const clients = [{ id: "cli", mode: "cli", displayName: "Release helper" }];
    const promoted = {
      role: "user",
      content: "Keep my accepted input",
      ...(system
        ? { provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" } }
        : {}),
      __openclaw: {
        id: "input-1",
        seq: 2,
        idempotencyKey: "run-queued:user",
        transport: { clients },
      },
    };
    const props = {
      paneId: "promoted-pane",
      sessionKey,
      messages: [promoted],
      pendingInputs: [
        {
          ...input,
          message: {
            ...promoted,
            __openclaw: { id: `pending:${input.id}`, transport: { clients } },
          },
        },
      ],
      queue: [],
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    };
    const pendingItems = buildChatItems({ ...props, messages: [] });
    expect(pendingItems).toHaveLength(1);
    expect(pendingItems[0]).toMatchObject(
      system
        ? { kind: "notice", label: "System · restart recovery" }
        : { kind: "group", role: "user", sourceClients: clients },
    );

    const items = buildChatItems(props);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject(
      system
        ? {
            kind: "notice",
            label: "System · restart recovery",
            boundaryId: "send:run-queued",
          }
        : {
            kind: "group",
            role: "user",
            sourceClients: clients,
            messages: [{ message: promoted }],
          },
    );
  });
});
