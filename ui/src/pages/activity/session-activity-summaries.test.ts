// @vitest-environment node
import { expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  ACTIVITY_SUMMARY_ENSURE_METHOD,
  SessionActivityController,
} from "./session-activity-controller.ts";

const filters = { personId: null, time: "all" as const, query: "" };
const row = (
  key = "agent:main:notes",
  overrides: Partial<GatewaySessionRow> = {},
): GatewaySessionRow => ({
  key,
  agentId: "main",
  sessionId: key,
  kind: "direct",
  updatedAt: 1,
  ...overrides,
});
const listing = (sessions: GatewaySessionRow[]): SessionsListResult => ({
  ts: 1,
  path: "",
  count: sessions.length,
  totalCount: sessions.length,
  sessions,
  defaults: { model: null, modelProvider: null, contextTokens: null },
});
const controller = () =>
  new SessionActivityController({
    addController() {},
    removeController() {},
    requestUpdate() {},
    updateComplete: Promise.resolve(true),
  });

it("backfills visible missing recaps in bounded batches without repeating reads or reordering sessions", async () => {
  const sessions = Array.from({ length: 25 }, (_, index) => row(`agent:main:notes-${index}`));
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const batches: Array<Array<{ key: string; agentId?: string }>> = [];
  vi.spyOn(client, "request").mockImplementation(async (method, params) => {
    if (method === "sessions.list") {
      return listing(sessions);
    }
    expect(method).toBe(ACTIVITY_SUMMARY_ENSURE_METHOD);
    const batch = (params as { sessions: Array<{ key: string; agentId?: string }> }).sessions;
    batches.push(batch);
    return {
      sessions: batch.map(({ key, agentId }) => ({
        key,
        agentId,
        activitySummary: { state: "updating" },
      })),
    };
  });
  const state = controller();
  state.load(client, filters, "query", true);
  await vi.waitFor(() =>
    expect(
      state.result?.sessions.every((entry) => entry.activitySummary?.state === "updating"),
    ).toBe(true),
  );
  expect(batches.map((batch) => batch.length)).toEqual([20, 5]);
  expect(state.result?.sessions.map((entry) => entry.key)).toEqual(
    sessions.map((entry) => entry.key),
  );
  expect(state.result?.totalCount).toBe(25);
  state.load(client, filters);
  expect(batches).toHaveLength(2);
  state.hostDisconnected();
});

it("keeps cached recaps readable without requesting generation on a read-only connection", async () => {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const result = listing([
    row(),
    row("agent:main:cached", {
      activitySummary: {
        state: "stale",
        text: "Verified the repair; rollout remains pending.",
        updatedAt: 1,
      },
    }),
  ]);
  const request = vi.spyOn(client, "request").mockResolvedValue(result);
  const state = controller();
  state.load(client, filters, "query", false);
  await vi.waitFor(() => expect(state.result).toEqual(result));
  state.retrySummary(state.result!.sessions[1]!);
  expect(request).toHaveBeenCalledTimes(1);
  state.hostDisconnected();
});

it("does not let a delayed backfill response overwrite a newer session-list recap", async () => {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const oldRow = row();
  const newRow = row(oldRow.key, {
    updatedAt: 2,
    activitySummary: { state: "current", text: "The repair is now merged.", updatedAt: 2 },
  });
  const request = vi
    .spyOn(client, "request")
    .mockResolvedValueOnce(listing([oldRow]))
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(listing([newRow]));
  const state = controller();
  state.load(client, filters, "query", true);
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  state.load(client, filters, "refresh");
  await vi.waitFor(() => expect(state.result?.sessions[0]).toEqual(newRow));
  finish({ sessions: [{ ...oldRow, activitySummary: { state: "updating" } }] });
  await pending;
  await Promise.resolve();
  expect(state.result?.sessions[0]).toEqual(newRow);
  state.hostDisconnected();
});

it("retains a failed recap and retries it without turning the session list into an error", async () => {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const source = row(undefined, {
    activitySummary: {
      state: "stale",
      text: "Found the failure; verification remains.",
      updatedAt: 1,
    },
  });
  const request = vi
    .spyOn(client, "request")
    .mockResolvedValueOnce(listing([source]))
    .mockRejectedValueOnce(new Error("Network interrupted"))
    .mockResolvedValueOnce({
      sessions: [{ ...source, activitySummary: { ...source.activitySummary, state: "updating" } }],
    });
  const state = controller();
  state.load(client, filters, "query", true);
  await vi.waitFor(() =>
    expect(state.result?.sessions[0]?.activitySummary?.state).toBe("unavailable"),
  );
  expect(state.result?.sessions[0]?.activitySummary?.text).toBe(source.activitySummary?.text);
  expect(state.error).toBeUndefined();
  state.retrySummary(state.result!.sessions[0]!);
  await vi.waitFor(() =>
    expect(state.result?.sessions[0]?.activitySummary?.state).toBe("updating"),
  );
  expect(request).toHaveBeenCalledTimes(3);
  state.hostDisconnected();
});

it("stops queued backfill batches when write access is revoked", async () => {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const sessions = Array.from({ length: 25 }, (_, index) => row(`agent:main:notes-${index}`));
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const request = vi
    .spyOn(client, "request")
    .mockResolvedValueOnce(listing(sessions))
    .mockReturnValueOnce(pending);
  const state = controller();
  state.load(client, filters, "query", true);
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  state.load(client, filters, "query", false);
  finish({
    sessions: sessions
      .slice(0, 20)
      .map(({ key, agentId }) => ({ key, agentId, activitySummary: { state: "updating" } })),
  });
  await pending;
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(2);
  expect(state.result?.sessions).toEqual(sessions);
  state.hostDisconnected();
});

it("keeps an explicit retry queued while another visible batch is pending", async () => {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const retryRow = row("agent:main:retry", {
    activitySummary: { state: "unavailable", text: "Previous recap", updatedAt: 1 },
  });
  const pendingRow = row();
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const request = vi
    .spyOn(client, "request")
    .mockResolvedValueOnce(listing([retryRow, pendingRow]))
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce({
      sessions: [
        { ...retryRow, activitySummary: { ...retryRow.activitySummary, state: "updating" } },
      ],
    });
  const state = controller();
  state.load(client, filters, "query", true);
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  state.retrySummary(state.result!.sessions[0]!);
  finish({ sessions: [{ ...pendingRow, activitySummary: { state: "updating" } }] });
  await vi.waitFor(() =>
    expect(state.result?.sessions[0]?.activitySummary?.state).toBe("updating"),
  );
  expect(request).toHaveBeenLastCalledWith(
    ACTIVITY_SUMMARY_ENSURE_METHOD,
    { sessions: [{ key: retryRow.key, agentId: "main" }] },
    expect.anything(),
  );
  state.hostDisconnected();
});
