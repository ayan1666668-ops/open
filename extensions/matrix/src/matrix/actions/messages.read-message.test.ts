// Matrix tests cover exact single-event message reads.
import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { readMatrixMessage } from "./messages.js";

describe("readMatrixMessage", () => {
  it("reads one Matrix event by id and rejects a missing id", async () => {
    const older = {
      event_id: "$older",
      sender: "@alice:example.org",
      type: "m.room.message",
      origin_server_ts: 1000,
      content: { msgtype: "m.text", body: "older" },
    };
    const getEvent = vi.fn(async (_roomId: string, eventId: string) => {
      if (eventId === older.event_id) {
        return older;
      }
      throw Object.assign(new Error("Event not found"), { errcode: "M_NOT_FOUND" });
    });
    const client = { getEvent, stop: vi.fn() } as unknown as MatrixClient;

    await expect(
      readMatrixMessage("room:!room:example.org", "$older", { client }),
    ).resolves.toMatchObject({ eventId: "$older", sender: "@alice:example.org", body: "older" });
    await expect(
      readMatrixMessage("room:!room:example.org", "$missing", { client }),
    ).rejects.toThrow("Matrix message $missing was not found in room !room:example.org.");
    expect(getEvent.mock.calls).toEqual([
      ["!room:example.org", "$older"],
      ["!room:example.org", "$missing"],
    ]);
  });
});
