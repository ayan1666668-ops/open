// @vitest-environment node
import { GatewayProtocolRequestError as GatewayRequestError } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import { getWorkboardState, saveWorkboardCardDraft, type WorkboardCard } from "./index.ts";
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
