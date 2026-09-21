import type { WorkboardCard } from "@openclaw/workboard-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export function cardSessionKey(
  card: Pick<WorkboardCard, "sessionKey" | "execution">,
): string | undefined {
  return (
    normalizeOptionalString(card.sessionKey) ?? normalizeOptionalString(card.execution?.sessionKey)
  );
}

export function workboardSessionKeyMatches(candidate: string, stored: string): boolean {
  return (
    candidate === stored ||
    (stored.startsWith("subagent:workboard-") && candidate.endsWith(`:${stored}`))
  );
}

export function cardExecutionSessionKey(card: WorkboardCard): string | undefined {
  return (
    normalizeOptionalString(card.execution?.sessionKey) ?? normalizeOptionalString(card.sessionKey)
  );
}

export function canHoldPrimarySessionBinding(
  card: Pick<WorkboardCard, "status" | "metadata">,
): boolean {
  return !card.metadata?.archivedAt && card.status !== "blocked" && card.status !== "done";
}

export function capturedSessionCard(
  cards: WorkboardCard[],
  sessionKey: string,
): WorkboardCard | undefined {
  const matches = cards
    .filter((card) => cardSessionKey(card) === sessionKey)
    .toSorted((left, right) => right.updatedAt - left.updatedAt);
  if (matches.filter(canHoldPrimarySessionBinding).length > 1) {
    throw new Error(
      `session ${sessionKey} is reserved by multiple cards; explicitly detach or rebind a duplicate.`,
    );
  }
  return (
    matches.find(canHoldPrimarySessionBinding) ??
    matches.find((card) => !card.metadata?.archivedAt) ??
    matches[0]
  );
}
