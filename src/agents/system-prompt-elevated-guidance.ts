import type {
  EmbeddedFullAccessBlockedReason,
  EmbeddedSandboxInfo,
} from "./embedded-agent-runner/types.js";

type ElevatedSandboxState = NonNullable<EmbeddedSandboxInfo["elevated"]>;

/**
 * Renders the human-readable reason auto-approved `/elevated full` is unavailable.
 *
 * @param reason - Machine-readable blocker reported by the sandbox metadata owner.
 * @returns Prompt-safe label; falls back to "runtime constraints" for unknown reasons.
 */
function formatFullAccessBlockedReason(reason?: EmbeddedFullAccessBlockedReason): string {
  if (reason === "host-policy") {
    return "host policy";
  }
  if (reason === "channel") {
    return "channel constraints";
  }
  if (reason === "sandbox") {
    return "sandbox constraints";
  }
  return "runtime constraints";
}

/**
 * Resolves the blocked-reason label for the elevated guidance section.
 *
 * @param elevated - Per-run elevated-exec facts, when the sandbox reports them.
 * @returns The label, or `undefined` when full access is available or unknown.
 */
function resolveFullAccessBlockedReasonLabel(elevated?: ElevatedSandboxState): string | undefined {
  if (!elevated || elevated.fullAccessAvailable) {
    return undefined;
  }
  return formatFullAccessBlockedReason(elevated.fullAccessBlockedReason);
}

/**
 * Builds the advisory lines describing elevated exec for the current run.
 *
 * Elevated availability and the toggle surface vary per run type: a normal parent
 * turn and a `sessions_yield`/announce turn can disagree about `allowed` and
 * `fullAccessAvailable`. These lines therefore belong below the system-prompt cache
 * boundary. Rendering them into the stable prefix makes the prefix stop being
 * byte-identical across turns, so provider-side literal prefix caches re-evaluate
 * the whole prompt instead of reusing it.
 *
 * Advisory text only: the sandbox metadata owner still decides what is permitted.
 *
 * @param params.sandboxEnabled - Whether the run executes inside a sandbox.
 * @param params.elevated - Per-run elevated-exec facts, when the sandbox reports them.
 * @returns Prompt lines in render order; empty when elevated guidance does not apply.
 */
export function buildElevatedGuidanceLines(params: {
  sandboxEnabled: boolean;
  elevated: ElevatedSandboxState | undefined;
}): string[] {
  const { sandboxEnabled, elevated } = params;
  if (!sandboxEnabled || !elevated) {
    return [];
  }
  const blockedReasonLabel = resolveFullAccessBlockedReasonLabel(elevated);
  return [
    elevated.allowed
      ? "Elevated exec is available for this session."
      : "Elevated exec is unavailable for this session.",
    elevated.allowed && elevated.fullAccessAvailable
      ? "User can toggle with /elevated on|off|ask|full."
      : "",
    elevated.allowed && !elevated.fullAccessAvailable
      ? "User can toggle with /elevated on|off|ask."
      : "",
    elevated.allowed && elevated.fullAccessAvailable
      ? "You may also send /elevated on|off|ask|full when needed."
      : "",
    elevated.allowed && !elevated.fullAccessAvailable
      ? "You may also send /elevated on|off|ask when needed."
      : "",
    blockedReasonLabel
      ? `Auto-approved /elevated full is unavailable here (${blockedReasonLabel}).`
      : "",
    elevated.allowed ? "" : "Do not tell the user to switch to /elevated full in this session.",
  ].filter(Boolean);
}
