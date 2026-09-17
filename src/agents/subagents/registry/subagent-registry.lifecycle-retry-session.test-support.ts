import type { InternalSessionEntry as SessionEntry } from "../../../config/sessions/types.js";

type PatchSessionEntry =
  typeof import("../../../config/sessions/session-accessor.js").patchSessionEntryCore;

/** Keep lifecycle timing writes and requester reads on the same in-memory sessions. */
export function createLifecycleRetrySessionFixture() {
  const store = new Proxy<Record<string, SessionEntry>>(
    {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: 1,
        delivery: {
          kind: "external",
          route: { channel: "discord", accountId: "default", target: { to: "user-1" } },
          context: { channel: "discord", to: "user-1", accountId: "default" },
          origin: { provider: "discord", to: "user-1", accountId: "default" },
        },
      },
    },
    {
      get(target, prop, receiver) {
        if (typeof prop !== "string" || prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        return {
          sessionId: `sess-${prop.replace(/[^a-z0-9]+/gi, "-")}`,
          updatedAt: 1,
        };
      },
    },
  );
  const patchSessionEntryCore: PatchSessionEntry = async (scope, update, options) => {
    const current = store[scope.sessionKey];
    if (!current) {
      return null;
    }
    const patch = await update(structuredClone(current), {
      existingEntry: structuredClone(current),
    });
    if (!patch || options?.shouldCommit?.() === false) {
      return null;
    }
    const next = options?.replaceEntry ? patch : { ...current, ...patch };
    if (!next.sessionId || typeof next.updatedAt !== "number") {
      throw new Error("Lifecycle fixture patch must retain the session identity and timing");
    }
    options?.assertCommitAllowed?.();
    const entry = { ...next, sessionId: next.sessionId, updatedAt: next.updatedAt };
    store[scope.sessionKey] = entry;
    options?.onCommitted?.(structuredClone(entry));
    return structuredClone(entry);
  };
  return { store, patchSessionEntryCore };
}
