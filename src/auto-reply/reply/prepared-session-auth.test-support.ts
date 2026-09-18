import { isDeepStrictEqual } from "node:util";
import type { PreparedSessionAuthSelection } from "../../agents/auth-profiles/session-override.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
function preparedAuthFixture(entry?: Partial<SessionEntry>): PreparedSessionAuthSelection {
  const initial = {
    authProfileOverride: entry?.authProfileOverride,
    authProfileOverrideSource: entry?.authProfileOverrideSource,
    authProfileOverrideCompactionCount: entry?.authProfileOverrideCompactionCount,
  };
  return {
    selection: entry?.authProfileOverride
      ? {
          profileId: entry.authProfileOverride,
          source: resolveCollapsedSessionAuthPinSource(entry) ?? "auto",
          routeRequirement: undefined,
        }
      : undefined,
    state: { ...initial },
    validate: (current, expected = initial) => {
      const currentState = {
        authProfileOverride: current?.authProfileOverride,
        authProfileOverrideSource: current?.authProfileOverrideSource,
        authProfileOverrideCompactionCount: current?.authProfileOverrideCompactionCount,
      };
      return isDeepStrictEqual(currentState, expected)
        ? undefined
        : "The selected account changed. Try again.";
    },
  };
}

export { preparedAuthFixture };
