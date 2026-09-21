import type { WorkboardCard } from "@openclaw/workboard-contract";
import { cardBoardId, cardRunId } from "./store-card-helpers.js";
import { cardExecutionSessionKey, workboardSessionKeyMatches } from "./store-session-binding.js";

function sanitizeSessionSegment(value: string | undefined, fallback: string): string {
  const sanitized = (value ?? fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (sanitized || fallback).slice(0, 96);
}

export function workboardSessionKeyForCard(card: WorkboardCard): string {
  const boardId = sanitizeSessionSegment(cardBoardId(card), "default");
  const cardId = sanitizeSessionSegment(card.id, "card");
  const suffix = `subagent:workboard-${boardId}-${cardId}`;
  return card.agentId ? `agent:${sanitizeSessionSegment(card.agentId, "agent")}:${suffix}` : suffix;
}

export function workboardCardMatchesLifecycleLink(
  card: WorkboardCard,
  source: { sessionKey?: string; runId?: string },
): boolean {
  const linkedSessionKey = cardExecutionSessionKey(card);
  const sessionMatches = Boolean(
    source.sessionKey &&
    (linkedSessionKey
      ? workboardSessionKeyMatches(source.sessionKey, linkedSessionKey)
      : workboardSessionKeyMatches(source.sessionKey, workboardSessionKeyForCard(card))),
  );
  const linkedRunId = cardRunId(card);
  if (linkedRunId && source.runId) {
    if (source.runId !== linkedRunId && !linkedRunId.startsWith(`workboard:${card.id}:`)) {
      return false;
    }
    return linkedSessionKey && source.sessionKey ? sessionMatches : true;
  }
  return sessionMatches;
}

export function workboardCardSessionLookupKey(card: WorkboardCard): string {
  return cardExecutionSessionKey(card) ?? workboardSessionKeyForCard(card);
}
