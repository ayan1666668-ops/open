import { describe, expect, it } from "vitest";
import { ChannelsSchema } from "./zod-schema.providers.js";

// Meta-test: every built-in channel that accepts a DM policy must also
// enforce its allowFrom rules ("open" requires "*", "allowlist" requires at
// least one entry). Guards against adding channel #N+1 with a dmPolicy field
// but without wiring the allowlist validation into its schema refinement.

const OPEN_ISSUE_RE = /to include "\*"/;
const ALLOWLIST_ISSUE_RE = /to contain at least one sender ID/;

// Both config shapes used by built-in channels today.
const OPEN_PROBES: Record<string, unknown>[] = [{ dmPolicy: "open" }, { dm: { policy: "open" } }];
const ALLOWLIST_PROBES: Record<string, unknown>[] = [
  { dmPolicy: "allowlist" },
  { dm: { policy: "allowlist" } },
];

function channelKeys(): string[] {
  const shape = ChannelsSchema.unwrap().shape;
  return Object.keys(shape).filter((key) => key !== "defaults" && key !== "modelByChannel");
}

type ProbeOutcome = "enforced" | "accepted-without-enforcement" | "not-applicable";

function probeChannel(key: string, probe: Record<string, unknown>, anchor: RegExp): ProbeOutcome {
  const result = ChannelsSchema.safeParse({ [key]: probe });
  if (result.success) {
    // The channel accepted this dm-policy shape and raised no issue at all:
    // an "open"/"allowlist" policy without allowFrom sailed through.
    return "accepted-without-enforcement";
  }
  const issues = result.error.issues;
  if (issues.some((issue) => anchor.test(issue.message))) {
    return "enforced";
  }
  // Failed for another reason (e.g. the probe shape does not exist on this
  // channel). Treat as not applicable; the aggregate assertion below makes
  // sure every channel enforces via at least one probe shape.
  return "not-applicable";
}

function enforcementFor(key: string, probes: Record<string, unknown>[], anchor: RegExp) {
  let sawEnforced = false;
  for (const probe of probes) {
    const outcome = probeChannel(key, probe, anchor);
    if (outcome === "accepted-without-enforcement") {
      return "accepted-without-enforcement";
    }
    if (outcome === "enforced") {
      sawEnforced = true;
    }
  }
  return sawEnforced ? "enforced" : "not-applicable";
}

describe("dm policy allowFrom enforcement (all built-in channels)", () => {
  it("covers every channel key in ChannelsSchema", () => {
    // If this list shrinks unexpectedly, the schema shape changed out from
    // under the meta-test; update deliberately.
    expect(channelKeys().length).toBeGreaterThanOrEqual(10);
  });

  for (const key of channelKeys()) {
    it(`${key}: dmPolicy="open" without allowFrom must be rejected`, () => {
      expect(enforcementFor(key, OPEN_PROBES, OPEN_ISSUE_RE)).toBe("enforced");
    });

    it(`${key}: dmPolicy="allowlist" without entries must be rejected`, () => {
      expect(enforcementFor(key, ALLOWLIST_PROBES, ALLOWLIST_ISSUE_RE)).toBe("enforced");
    });
  }
});
