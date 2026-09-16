import { commitSessionExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
import { decodeSessionExecutionSelection } from "../../model-picker/execution-selection-codec.js";
import {
  executionSelectionCodecMetadata,
  getSessionExecutionSelection,
} from "../../model-picker/execution-selection-state.js";
import { resolveSessionAuthProfileOverrideSource } from "./auth-profile-override-provenance.js";
import type { SessionPatchProjectionSnapshot } from "./session-accessor.types.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

type SessionProjectionTarget = {
  candidateKeys?: readonly string[];
  primaryKey: string;
};

export class SessionLabelOwnerIndex {
  readonly #owners = new Map<string, Set<string>>();

  constructor(private readonly store: Record<string, SessionEntry>) {
    for (const [sessionKey, entry] of Object.entries(this.store)) {
      this.#update(sessionKey, entry.label, true);
    }
  }

  isLabelInUse(label: string, excludedKeys: readonly string[]): boolean {
    for (const sessionKey of this.#owners.get(label) ?? []) {
      if (!excludedKeys.includes(sessionKey)) {
        return true;
      }
    }
    return false;
  }

  replaceEntry(
    candidateKeys: readonly string[],
    primaryKey: string,
    entry: SessionEntry,
  ): SessionEntry {
    for (const sessionKey of new Set([...candidateKeys, primaryKey])) {
      this.#update(sessionKey, this.store[sessionKey]?.label, false);
      delete this.store[sessionKey];
    }
    const cloned = structuredClone(entry);
    this.store[primaryKey] = cloned;
    this.#update(primaryKey, cloned.label, true);
    return cloned;
  }

  #update(sessionKey: string, label: string | undefined, add: boolean): void {
    if (label === undefined) {
      return;
    }
    const owners = this.#owners.get(label) ?? new Set<string>();
    if (add) {
      owners.add(sessionKey);
      this.#owners.set(label, owners);
      return;
    }
    owners.delete(sessionKey);
  }
}

/** Carries only user/runtime selection into a new dashboard fork. */
export function inheritSessionSelection(
  parentEntry: SessionEntry | undefined,
): Partial<InternalSessionEntry> {
  if (!parentEntry) {
    return {};
  }
  const decoded = decodeSessionExecutionSelection(parentEntry, executionSelectionCodecMetadata());
  const authProfileOverrideSource = resolveSessionAuthProfileOverrideSource(parentEntry);
  const selection = getSessionExecutionSelection(parentEntry);
  const inherited: Partial<InternalSessionEntry> = {};
  if (selection && selection.executor.kind !== "acp") {
    commitSessionExecutionSelection(inherited, selection, {
      cause: { kind: "inherit", entry: parentEntry },
    });
  }
  const inheritAuthProfile =
    !(decoded.kind === "uninitialized" && decoded.discardAutomaticAuth) ||
    authProfileOverrideSource === "user" ||
    authProfileOverrideSource === "user-link";
  return {
    ...inherited,
    ...(parentEntry.contextWindow ? { contextWindow: parentEntry.contextWindow } : {}),
    ...(parentEntry.thinkingLevel ? { thinkingLevel: parentEntry.thinkingLevel } : {}),
    ...(parentEntry.fastMode !== undefined ? { fastMode: parentEntry.fastMode } : {}),
    ...(parentEntry.toolOverrides ? { toolOverrides: parentEntry.toolOverrides } : {}),
    ...(parentEntry.verboseLevel ? { verboseLevel: parentEntry.verboseLevel } : {}),
    ...(parentEntry.traceLevel ? { traceLevel: parentEntry.traceLevel } : {}),
    ...(parentEntry.reasoningLevel ? { reasoningLevel: parentEntry.reasoningLevel } : {}),
    ...(parentEntry.elevatedLevel ? { elevatedLevel: parentEntry.elevatedLevel } : {}),
    ...(inheritAuthProfile && authProfileOverrideSource && parentEntry.authProfileOverride
      ? { authProfileOverride: parentEntry.authProfileOverride }
      : {}),
    ...(inheritAuthProfile && authProfileOverrideSource ? { authProfileOverrideSource } : {}),
  };
}

function cloneOptionalSessionEntry(entry: SessionEntry | undefined): SessionEntry | undefined {
  return entry ? structuredClone(entry) : undefined;
}

export function resolveProjectionExistingEntry(
  snapshot: SessionPatchProjectionSnapshot,
  target: SessionProjectionTarget,
): SessionEntry | undefined {
  const candidateKeys = target.candidateKeys ?? [target.primaryKey];
  let freshest: SessionEntry | undefined;
  for (const candidateKey of candidateKeys) {
    const entry = snapshot.store[candidateKey];
    if (entry && (!freshest || (entry.updatedAt ?? 0) > (freshest.updatedAt ?? 0))) {
      freshest = entry;
    }
  }
  return cloneOptionalSessionEntry(freshest);
}
