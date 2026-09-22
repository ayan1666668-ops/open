import { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  replaceSessionEntrySync,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionByKeyReadHandlers } from "./sessions-read-by-key.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  requestContext,
} from "./sessions-read-cache.test-support.js";

it("keeps warm, dirty, and archived keyed RPCs off host SQLite while preserving raw messages", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:raw-worker-history",
      sessionId: "raw-worker-history",
    };
    replaceSessionEntrySync(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      visibility: "shared",
    });
    const messages = [
      { role: "user", content: "Earlier message" },
      { role: "assistant", channel: "commentary", content: "Checking the fixture" },
      { role: "toolResult", toolCallId: "synthetic-call", content: "Synthetic tool output" },
      { role: "assistant", content: "Final answer" },
    ];
    await replaceTranscriptEvents(scope, [
      { type: "session", id: scope.sessionId },
      ...messages.map((message, index) => ({
        type: "message",
        id: `message-${index}`,
        parentId: index === 0 ? null : `message-${index - 1}`,
        message,
      })),
    ]);
    const context = requestContext({ agents: { entries: { main: {} } } });
    const client = identifiedClient("synthetic-viewer");
    await initializeSessionReadContext(context);
    const read = async (method: "sessions.get" | "sessions.describe" = "sessions.get") => {
      const respond = vi.fn();
      await sessionByKeyReadHandlers[method]!({
        req: { type: "req", id: "raw-worker-history", method },
        params: { key: scope.sessionKey, ...(method === "sessions.get" ? { limit: 3 } : {}) },
        client,
        context,
        respond,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      return respond.mock.calls[0]?.[1];
    };
    const expected = await read();
    expect(expected).toMatchObject({
      messages: messages.slice(1).map((message, index) => ({
        ...message,
        __openclaw: { id: `message-${index + 1}` },
      })),
    });
    const statements = new Map<string, number>();
    const spies = (["all", "get", "run", "iterate"] as const).map((method) => {
      const original = StatementSync.prototype[method];
      return vi.spyOn(StatementSync.prototype, method).mockImplementation(
        new Proxy(original, {
          apply(target, receiver: StatementSync, args) {
            statements.set(receiver.sourceSQL, (statements.get(receiver.sourceSQL) ?? 0) + 1);
            return Reflect.apply(target, receiver, args);
          },
        }),
      );
    });
    try {
      for (let index = 0; index < 100; index++) {
        expect(await read()).toEqual(expected);
      }
      expect([...statements]).toEqual([]);
      for (const method of ["sessions.get", "sessions.describe"] as const) {
        for (let index = 0; index < 100; index++) {
          sessionChanges.emit({ agentId: scope.agentId, sessionKey: scope.sessionKey });
          // Count the RPC read, independently of the committed writer's publication work.
          statements.clear();
          const result = await read(method);
          if (method === "sessions.get") {
            expect(result).toEqual(expected);
          } else {
            expect(result).toMatchObject({ session: { sessionId: scope.sessionId } });
          }
          expect([...statements]).toEqual([]);
        }
      }
      replaceSessionEntrySync(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        visibility: "shared",
        archivedAt: 1,
      });
      for (const method of ["sessions.get", "sessions.describe"] as const) {
        sessionChanges.emit({ all: true, scope: "catalog" });
        statements.clear();
        const result = await read(method);
        if (method === "sessions.get") {
          expect(result).toEqual(expected);
        } else {
          expect(result).toMatchObject({ session: { sessionId: scope.sessionId, archivedAt: 1 } });
        }
        expect([...statements]).toEqual([]);
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});
