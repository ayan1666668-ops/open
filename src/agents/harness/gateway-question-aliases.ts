/**
 * Answer aliases let another conversation's plain-text replies resolve a
 * pending question, such as the chat that requested a voice consult. The
 * owning session key stays the question's identity; aliases only widen lookup.
 */

/** Points each free alias key at the state; occupied keys keep their own question. */
export function registerQuestionAliases<T extends { sessionKey: string }>(
  registry: Map<string, T>,
  state: T,
  aliasKeys: readonly string[] | undefined,
): ReadonlySet<string> {
  const registered = new Set<string>();
  for (const rawKey of aliasKeys ?? []) {
    const key = rawKey.trim();
    if (key && key !== state.sessionKey && !registry.has(key)) {
      registry.set(key, state);
      registered.add(key);
    }
  }
  return registered;
}

/** Removes only the alias entries that still point at this state. */
export function releaseQuestionAliases<T>(
  registry: Map<string, T>,
  state: T,
  aliasKeys: ReadonlySet<string>,
): void {
  for (const key of aliasKeys) {
    if (registry.get(key) === state) {
      registry.delete(key);
    }
  }
}
