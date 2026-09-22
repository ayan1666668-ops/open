---
summary: "Exact candidate identity bound into native Swarm verifier launches"
title: "Identity-bound convergence"
status: experimental
---

# Identity-bound convergence

Exploration may be stochastic. Verification must agree on the exact object being
verified.

A candidate manifest binds:

- candidate digest
- source digest
- execution recipe digest
- governing policy digest
- manifest version

Canonical serialization produces a stable candidate identity. The manifest and
identity enter the prepared verifier task before OpenClaw computes its existing
launch fingerprint. Candidate/source/recipe/policy drift therefore changes replay
identity.

This is **identity binding**, not proof of correctness.

Typed population measurements in the same experiment retain `host` or `external`
provenance, but external measurements are not authenticated receipts. The current
implementation therefore does not claim cryptographic evidence provenance.

## Verifier boundary

A caller-side verifier can require an artifact-only handoff, exact candidate
identity, artifact references, and `sandbox: "require"`.

If native admission cannot provide the required sandbox, launch fails; the bridge
does not retry unsandboxed.

The exact identity tells the verifier which computation/candidate is in scope.
It does not prove:

- the test ran,
- the verifier was independent,
- the result is correct,
- an effect is authorized.

## Deterministic half of adaptive search

```text
many trajectories
      |
      v
candidate selected
      |
      v
candidate + source + recipe + policy
      |
      v
stable identity
      |
      v
sandbox-required verifier launch
      |
      v
existing replay / authority owners
```

## Deferred proof layers

Still separate from this PR:

- authenticated measurement receipts
- verifier-independence attestation
- persistent execution provenance beyond existing owners
- effect-request construction
- promotion / merge / deployment authorization

Those layers should be added only where OpenClaw has an enforcement owner capable
of making the claim true.
