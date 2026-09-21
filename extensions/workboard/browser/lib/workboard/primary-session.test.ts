// @vitest-environment node
import "../../test/host.setup.ts";
import { GatewayProtocolRequestError as GatewayRequestError } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import { workboardCardExecutionSessionKey } from "./card-state.ts";
import { stopWorkboardCard } from "./execution.ts";
import { getWorkboardState, saveWorkboardCardDraft, type WorkboardCard } from "./index.ts";
import { getWorkboardLifecycle } from "./lifecycle.ts";
import { normalizeCardPayload } from "./normalization.ts";
import { workboardCardSessionTarget } from "./session-resolution.ts";
import { taskMatchesCard, selectWorkboardTaskDiscoveryQueries } from "./task-links.ts";
import {
  createWorkboardCard as makeCard,
  createWorkboardExecution,
  createWorkboardTestClient as createClient,
  type WorkboardTestClient,
} from "./test/index-helpers.ts";

function fixture() {
  const host = {};
  const state = getWorkboardState(host);
  function openEditDraft(card: WorkboardCard) {
    Object.assign(state, {
      draftOpen: true,
      editingCardId: card.id,
      editingCardBase: card,
      draftTitle: card.title,
      draftNotes: card.notes ?? "",
      draftStatus: card.status,
      draftPriority: card.priority,
      draftLabels: card.labels.join(", "),
      draftAgentId: card.agentId ?? "",
      draftSessionKey: card.sessionKey ?? "",
    });
  }
  return {
    state,
    openEditDraft,
    saveDraft: (client: WorkboardTestClient) => saveWorkboardCardDraft({ host, client }),
  };
}
function createSequencedClient(routes: Record<string, unknown[]>) {
  return createClient((method) => {
    const value = routes[method]?.shift();
    if (value instanceof Error) {
      throw value;
    }
    return value;
  });
}
describe("primary session draft intent", () => {
  it("keeps explicit detach through gateway decoding without losing worker controls", () => {
    const legacy = makeCard({
      sessionKey: undefined,
      execution: createWorkboardExecution({ sessionKey: "worker" }),
    });
    expect(workboardCardSessionTarget(legacy)).toEqual({ sessionKey: "worker" });
    const detached = normalizeCardPayload({ card: { ...legacy, primarySessionDetached: true } });
    expect(workboardCardSessionTarget(detached)).toBeUndefined();
    expect(workboardCardSessionTarget(detached, { sessionKey: "worker" })).toBeUndefined();
    expect(workboardCardExecutionSessionKey(detached)).toBe("worker");
  });
  it("keeps A-to-B-to-A binding intent through a concurrent rebind conflict", async () => {
    const { state, openEditDraft, saveDraft } = fixture();
    const base = makeCard({ sessionKey: "A" });
    const current = makeCard({ sessionKey: "C", updatedAt: base.updatedAt + 1 });
    state.cards = [base];
    openEditDraft(base);
    state.draftSessionKey = "B";
    state.draftSessionKeyDirty = true;
    state.draftSessionKey = "A";
    const client = createSequencedClient({
      "workboard.cards.update": [
        new GatewayRequestError({
          code: "workboard_conflict",
          message: "Changed",
          details: { type: "workboard_card_conflict", card: current },
        }),
        { card: { ...current, sessionKey: "A", updatedAt: current.updatedAt + 1 } },
      ],
    });
    await saveDraft(client);
    expect(state.draftSessionKey).toBe("A");
    expect(state.draftSessionKeyDirty).toBe(true);
    expect(state.editingCardBase).toEqual(current);
    await saveDraft(client);
    expect(client.request).toHaveBeenLastCalledWith("workboard.cards.update", {
      id: base.id,
      expectedUpdatedAt: current.updatedAt,
      patch: { sessionKey: "A" },
    });
    expect(state.draftSessionKeyDirty).toBe(false);
  });

  it("does not promote an execution-only session during a title edit", async () => {
    const { state, openEditDraft, saveDraft } = fixture();
    const base = makeCard({
      sessionKey: undefined,
      execution: createWorkboardExecution({ sessionKey: "worker" }),
    });
    state.cards = [base];
    openEditDraft(base);
    state.draftTitle = "Updated";
    const client = createClient({
      "workboard.cards.update": { card: { ...base, title: "Updated" } },
    });
    await saveDraft(client);
    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: base.id,
      expectedUpdatedAt: base.updatedAt,
      patch: { title: "Updated" },
    });
  });
});

describe("distinct primary and execution browser identities", () => {
  const primary = "agent:main:operator";
  const worker = "agent:main:worker";
  function runningCard() {
    return makeCard({
      status: "running",
      sessionKey: primary,
      runId: "primary-run",
      execution: createWorkboardExecution({ sessionKey: worker, runId: "worker-run" }),
    });
  }
  it("finds worker tasks and queries execution without moving primary navigation", () => {
    const card = runningCard();
    expect(
      taskMatchesCard(
        {
          id: "worker-task",
          taskId: "worker-task",
          status: "running",
          runId: "worker-run",
          sessionKey: worker,
        },
        card,
      ),
    ).toBe(true);
    expect(
      taskMatchesCard(
        {
          id: "primary-task",
          taskId: "primary-task",
          status: "running",
          runId: "worker-run",
          sessionKey: primary,
        },
        card,
      ),
    ).toBe(false);
    expect(selectWorkboardTaskDiscoveryQueries({}, [card], new Map(), new Set())).toEqual([
      { sessionKey: worker },
    ]);
    expect(workboardCardSessionTarget(card)).toEqual({ sessionKey: primary });
  });
  it("uses worker completion rather than a still-running primary chat", () => {
    const card = runningCard();
    const sessions = [
      { key: primary, kind: "direct" as const, status: "running" as const, hasActiveRun: true },
      { key: worker, kind: "direct" as const, status: "done" as const, hasActiveRun: false },
    ];
    expect(getWorkboardLifecycle(card, sessions)).toMatchObject({
      state: "succeeded",
      targetStatus: "review",
      session: sessions[1],
    });
  });
  it("keeps both Stop attempts on the worker even with a stale primary target", async () => {
    const card = runningCard();
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [card];
    let aborts = 0;
    const client = createClient((method) => {
      if (method === "chat.abort") {
        return { aborted: ++aborts > 1 };
      }
      if (method === "workboard.cards.update") {
        return { card: { ...card, status: "blocked", updatedAt: 2 } };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    await stopWorkboardCard({ host, client, card, session: { sessionKey: primary } });
    expect(client.request.mock.calls.filter(([method]) => method === "chat.abort")).toEqual([
      ["chat.abort", { sessionKey: worker, runId: "worker-run" }],
      ["chat.abort", { sessionKey: worker }],
    ]);
    expect(state.error).toBeNull();
    expect(state.cards[0]?.sessionKey).toBe(primary);
  });
});
