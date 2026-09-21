import { randomUUID } from "node:crypto";
import type { WorkboardCard, WorkboardStatus } from "@openclaw/workboard-contract";
import {
  assertCanMutateClaimedCard,
  cardParentIds,
  isActiveDependencyTarget,
  isDependencyPromotableStatus,
} from "./store-card-helpers.js";
import type { WorkboardCardPatch, WorkboardMutationScope } from "./store-inputs.js";
import { appendLinkPreservingDependencies } from "./store-normalizers.js";

export type WorkboardDependencyHost = {
  get(id: string): Promise<WorkboardCard | undefined>;
  list(): Promise<WorkboardCard[]>;
  updateCard(
    id: string,
    patch: WorkboardCardPatch,
    options?: { expectedUpdatedAt?: number },
  ): Promise<WorkboardCard>;
  listCardStatuses(ids: readonly string[]): Promise<Array<{ id: string; status: string }>>;
};

export async function dependencyParentsAreDone(
  parentIds: readonly string[],
  listCardStatuses: WorkboardDependencyHost["listCardStatuses"],
): Promise<boolean> {
  const ids = parentIds.map((parentId) => parentId.trim());
  if (ids.length === 0) {
    return true;
  }
  const parentCards = new Map((await listCardStatuses(ids)).map((parent) => [parent.id, parent]));
  return ids.every((id) => parentCards.get(id)?.status === "done");
}

async function dependencyTargetStatus(
  card: WorkboardCard,
  now: number,
  listCardStatuses: WorkboardDependencyHost["listCardStatuses"],
): Promise<WorkboardStatus> {
  // Deliberate blocked holds are outside automatic promotion. Claim and unblock
  // recover them; dispatch, link, and prepareStart must leave the hold in place.
  if (card.status === "blocked") {
    return "blocked";
  }
  const scheduledAt = card.metadata?.automation?.scheduledAt;
  const parents = cardParentIds(card);
  if (card.status === "scheduled" && !scheduledAt) {
    return "scheduled";
  }
  if (parents.length === 0) {
    if (scheduledAt && scheduledAt > now && isDependencyPromotableStatus(card.status)) {
      return "scheduled";
    }
    return card.status === "scheduled" ? "ready" : card.status;
  }
  const parentsDone = await dependencyParentsAreDone(parents, listCardStatuses);
  if (
    !parentsDone &&
    scheduledAt &&
    scheduledAt > now &&
    isDependencyPromotableStatus(card.status)
  ) {
    return "scheduled";
  }
  if (!parentsDone && isDependencyPromotableStatus(card.status)) {
    return "todo";
  }
  if (
    parentsDone &&
    scheduledAt &&
    scheduledAt > now &&
    isDependencyPromotableStatus(card.status)
  ) {
    return "scheduled";
  }
  return parentsDone && isDependencyPromotableStatus(card.status) ? "ready" : card.status;
}

async function cardDependsOn(
  host: WorkboardDependencyHost,
  cardId: string,
  targetParentId: string,
): Promise<boolean> {
  const cards = new Map((await host.list()).map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === targetParentId) {
      return true;
    }
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    const card = cards.get(id);
    return Boolean(card && cardParentIds(card).some(visit));
  };
  return visit(cardId);
}

export async function linkDependencyCards(
  host: WorkboardDependencyHost,
  parentId: string,
  childId: string,
  now = Date.now(),
  options: { allowStatusOnlyActiveChild?: boolean; scope?: WorkboardMutationScope } = {},
): Promise<WorkboardCard> {
  if (parentId.trim() === childId.trim()) {
    throw new Error("parent and child cards must differ.");
  }
  const parent = await host.get(parentId);
  const child = await host.get(childId);
  if (!parent) {
    throw new Error(`card not found: ${parentId}`);
  }
  if (!child) {
    throw new Error(`card not found: ${childId}`);
  }
  assertCanMutateClaimedCard(parent, options.scope);
  assertCanMutateClaimedCard(child, options.scope);
  if (child.status === "done" || child.status === "blocked") {
    const parentIds = [...cardParentIds(child), parent.id].filter(
      (id, index, ids) => ids.indexOf(id) === index,
    );
    const cardsById = new Map(
      (await host.listCardStatuses(parentIds)).map((card) => [card.id, card]),
    );
    if (parentIds.some((id) => cardsById.get(id)?.status !== "done")) {
      throw new Error("terminal child cards cannot gain incomplete parent dependencies.");
    }
  }
  if (isActiveDependencyTarget(child, { allowStatusOnly: options.allowStatusOnlyActiveChild })) {
    throw new Error("active child cards cannot gain parent dependencies.");
  }
  if (await cardDependsOn(host, parent.id, child.id)) {
    throw new Error("dependency link would create a cycle.");
  }
  const parentLinks = parent.metadata?.links ?? [];
  const childLinks = child.metadata?.links ?? [];
  const nextParentLinks = parentLinks.some(
    (link) => link.type === "child" && link.targetCardId === child.id,
  )
    ? parentLinks
    : appendLinkPreservingDependencies(parentLinks, {
        id: randomUUID(),
        type: "child" as const,
        targetCardId: child.id,
        createdAt: now,
      });
  const nextChildLinks = childLinks.some(
    (link) => link.type === "parent" && link.targetCardId === parent.id,
  )
    ? childLinks
    : appendLinkPreservingDependencies(childLinks, {
        id: randomUUID(),
        type: "parent" as const,
        targetCardId: parent.id,
        createdAt: now,
      });
  await host.updateCard(
    parent.id,
    {
      metadata: { ...parent.metadata, links: nextParentLinks },
    },
    { expectedUpdatedAt: parent.updatedAt },
  );
  const nextChild = await host.updateCard(
    child.id,
    { metadata: { ...child.metadata, links: nextChildLinks } },
    { expectedUpdatedAt: child.updatedAt },
  );
  return await promoteDependencyReady(host, nextChild.id);
}

export async function promoteDependencyReady(
  host: WorkboardDependencyHost,
  id: string,
  now = Date.now(),
): Promise<WorkboardCard> {
  const card = await host.get(id);
  if (!card) {
    throw new Error(`card not found: ${id}`);
  }
  if (card.metadata?.archivedAt) {
    return card;
  }
  const target = await dependencyTargetStatus(card, now, host.listCardStatuses);
  if (target === card.status) {
    return card;
  }
  return await host.updateCard(card.id, { status: target });
}
