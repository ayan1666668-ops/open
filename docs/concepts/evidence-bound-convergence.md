---
summary: "Exact candidate identity bound into native Swarm verifier launches"
title: "Evidence-bound convergence"
status: experimental
---

# Evidence-bound convergence

Liquid search is intentionally permissive about *which hypotheses are explored*.
Convergence is intentionally strict about *what exact candidate is being checked*.

OpenClaw therefore binds a verifier launch to one exact candidate manifest:

- candidate digest
- source digest
- execution recipe digest
- governing policy digest
- manifest version

The canonical manifest produces a stable candidate identity. That manifest and
identity are serialized into the verifier task before OpenClaw computes the
existing launch fingerprint. If source, recipe, policy, or candidate bytes change,
the launch identity changes too.

This is the deterministic half of the Liquid Swarm philosophy:

```text
many trajectories
      |
      v
candidate chosen
      |
      v
exact bytes + source + recipe + policy
      |
      v
stable candidate identity
      |
      v
verifier launch fingerprint
```

The digest proves identity of the supplied bytes. It does **not** prove that a
test ran, that a verifier is independent, that the candidate is correct, or that
an external effect is authorized.

## Trust boundary

Candidate identity is a data-binding primitive, not a proof system.

The current implementation does not mint trusted measurement receipts, attest
verifier independence, approve effects, publish artifacts, merge code, deploy,
or grant new tools. Existing OpenClaw admission, sandbox, policy, approval, and
external-effect owners remain authoritative.

A caller-side verification recipe can use the generic artifact-only boundary and
require the existing sandbox owner to accept `sandbox: "require"`, along with
candidate identity and artifact references. A rejection is surfaced as an error;
the bridge does not retry unsandboxed.

## Why this belongs next to mixed-phase search

Exploration can be stochastic, redundant, adversarial, or deliberately diverse.
Final comparison cannot be allowed to drift with it.

The invariant is:

> Increase entropy while searching; reduce ambiguity while converging.

A candidate is only useful to downstream verification if everyone is talking
about the same bytes under the same execution and policy context. Candidate
identity supplies that exact boundary.

## Integration status

Shipped in this experiment:

- canonical candidate manifest validation
- deterministic candidate identity
- manifest/identity binding into native dynamics spawn preparation
- launch fingerprint invalidation when candidate/source/recipe/policy changes
- conflict rejection between an explicit handoff digest and the manifest digest

Deferred work:

- authenticated measurement receipts
- trusted verifier-independence attestations
- effect-request construction
- promotion/merge/deploy authorization
- persistent execution provenance beyond existing OpenClaw owners

Those deferred layers must be added by the owners that can actually enforce them.

## Related

- [Liquid Software Factory](/concepts/liquid-software-factory) for the end-to-end search-to-convergence architecture.
