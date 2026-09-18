import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Replaces a caller-held snapshot with the latest persisted row in place. */
export function adoptPersistedSessionSnapshot(target: SessionEntry, current: SessionEntry): void {
  for (const field of Object.keys(target)) {
    if (!Object.hasOwn(current, field) && !Reflect.deleteProperty(target, field)) {
      throw new TypeError(`Cannot remove stale session snapshot field: ${field}`);
    }
  }
  Object.assign(target, current);
}
