import { inheritSessionExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
// Reset preservation retains accepted execution and explicit account choices.
import { resolveSessionAuthProfileOverrideSource } from "./auth-profile-override-provenance.js";
import type { SessionEntry } from "./types.js";

/** Preserve the accepted pair and explicit account pin across a fresh conversation. */
export function resolveResetPreservedSelection(params: {
  entry?: SessionEntry;
}): Partial<SessionEntry> {
  const { entry } = params;
  if (!entry) {
    return {};
  }

  const preserved = inheritSessionExecutionSelection(entry);

  const authProfileOverrideSource = resolveSessionAuthProfileOverrideSource(entry);
  if (authProfileOverrideSource === "user" && entry.authProfileOverride) {
    preserved.authProfileOverride = entry.authProfileOverride;
    preserved.authProfileOverrideSource = authProfileOverrideSource;
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      preserved.authProfileOverrideCompactionCount = entry.authProfileOverrideCompactionCount;
    }
  }

  return preserved;
}
