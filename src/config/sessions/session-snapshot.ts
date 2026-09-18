import type { InternalSessionEntry as SessionEntry } from "./types.js";

type SessionEntryRecord = Partial<Record<keyof SessionEntry, unknown>>;

/** Replaces a caller-held snapshot with the latest persisted row in place. */
export function adoptPersistedSessionSnapshot(target: SessionEntry, current: SessionEntry): void {
  const targetRecord = target as SessionEntryRecord;
  const currentRecord = current as SessionEntryRecord;
  for (const field of Object.keys(target) as Array<keyof SessionEntry>) {
    if (!Object.hasOwn(current, field)) {
      delete targetRecord[field];
    }
  }
  for (const field of Object.keys(current) as Array<keyof SessionEntry>) {
    targetRecord[field] = currentRecord[field];
  }
}
