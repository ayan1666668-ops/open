---
summary: "Generic dynamics contract and adaptive compute advisories for native Swarm collectors"
title: "Swarm dynamics"
status: experimental
---

# Swarm dynamics

Swarm already lets each child choose its own execution level. The dynamics
experiment keeps that primitive and adds bounded information flow plus population
advisories.

## Heterogeneous reasoning levels

Different workers in one group can intentionally run at different levels:

```javascript
const settled = await Promise.allSettled([
  agents.run("Generate a very different hypothesis.", {
    label: "cheap-explorer-a",
    thinking: "low",
    fastMode: true,
    dynamics: { boundary: "isolated" },
  }),
  agents.run("Try a second independent decomposition.", {
    label: "cheap-explorer-b",
    thinking: "low",
    fastMode: true,
    dynamics: { boundary: "isolated" },
  }),
  agents.run("Integrate only the supplied summaries.", {
    label: "coordinator",
    thinking: "medium",
    dynamics: { boundary: "summary-only" },
  }),
]);
```

Later, an unresolved lane can be run with `thinking: "high"`. The population
controller's `deepen` advisory explicitly suggests that existing OpenClaw thinking
level; it does not create another reasoning API or automatically spend the tokens.

## Generic dynamics contract

```typescript
type DynamicsBoundary =
  | "isolated"
  | "artifact-only"
  | "evidence-only"
  | "summary-only";

type DynamicsOptions = {
  boundary: DynamicsBoundary;
  requirements?: {
    sandbox?: "inherit" | "require";
    candidateDigest?: "optional" | "required";
    artifactRefs?: "optional" | "required";
  };
  handoff?: {
    candidateDigest?: string;
    artifactRefs?: string[];
    evidenceRefs?: string[];
    summary?: string;
  };
  candidate?: {
    version: 1;
    candidateDigest: string;
    sourceDigest: string;
    recipeDigest: string;
    policyDigest: string;
  };
};
```

The contract is monotone with respect to authority: it may require a stricter
sandbox or more identity/evidence fields, but it cannot grant tools, credentials,
approval, publication, merge, or deployment authority.

Calls without `dynamics` preserve the existing path.

## Explicit handoff boundaries

- `isolated` drops all explicit dynamics handoff fields
- `artifact-only` may carry candidate identity + artifact refs
- `evidence-only` may carry candidate identity + evidence refs
- `summary-only` carries only a bounded summary

Requirements are checked against the selected boundary. A contract that requires
artifacts across a boundary that drops artifacts is rejected.

References are caller-provided data. Handoff filtering is not a complete sandbox
and does not prove epistemic independence.

## Exact verifier launch

```javascript
const verified = await agents.run("Verify this exact frozen candidate.", {
  thinking: "high",
  dynamics: {
    boundary: "artifact-only",
    requirements: {
      sandbox: "require",
      candidateDigest: "required",
      artifactRefs: "required",
    },
    candidate: {
      version: 1,
      candidateDigest: "candidate:sha256:...",
      sourceDigest: "source:sha256:...",
      recipeDigest: "recipe:sha256:...",
      policyDigest: "policy:sha256:...",
    },
    handoff: {
      artifactRefs: ["artifact:candidate"],
    },
  },
});
```

The prepared launch requests `context: "isolated"` and delegates
`sandbox: "require"` to the existing native spawn owner. If the sandbox cannot be
provided, admission fails; there is no unsandboxed retry.

Candidate/source/recipe/policy identity participates in the exact prepared launch
bytes and therefore in the existing replay fingerprint.

Identity proves which candidate is being discussed. It does not prove correctness.

## Population measurements

The internal population substrate accepts typed measurements with a source:

- `host` — OpenClaw-owned facts such as concurrency pressure and terminal outcome
- `external` — semantic measurements supplied by another integration

The current native collector path only emits facts it actually owns. It does not
invent candidate entropy, coherence, acceptance progress, verifier disagreement,
or trajectory correlation from successful completion.

External measurement provenance is retained but is not an authenticated receipt.

## Advisory policy

The controller may recommend:

- `measure` unresolved conflict
- `deepen` a bounded subset, suggesting `thinking: "high"`
- `perturb` correlated or arrested search
- `freeze` a stable local candidate
- `spawn` one bounded coordinating lane
- `drain` under pressure
- `hold` when no change is justified

These are data, not actuators. Existing execution owners decide what actually runs.

## Lifecycle and replay

Dynamics bookkeeping belongs to the parent run. Parent disposal/abort releases the
observer without cancelling unrelated live collectors. Exact replay continues to
use OpenClaw's existing idempotency and request-fingerprint owners.

## Evidence boundary

Repository tests cover the generic contract, fail-closed sandbox admission,
replay mismatch rejection, lifecycle cleanup, typed measurement provenance,
selective deepening, correlation-aware fan-out suppression, acceptance progress,
and the full fold into an exact sandbox-required verifier preparation.

Final provider/model execution is still substituted in repository integration
tests. A redacted live native collector transcript remains stronger evidence than
another synthetic helper test.
