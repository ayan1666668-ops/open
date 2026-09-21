---
summary: "Liquid Software Factory: stochastic multi-agent search with deterministic convergence"
title: "Liquid Software Factory"
status: experimental
---

# Liquid Software Factory

Liquid Software Factory is an experimental way to structure multi-agent search:

> Search can be stochastic. Promotion cannot be accidental.

The system deliberately allows high diversity during exploration, then reduces
ambiguity as work approaches verification and external effect.

```text
high entropy                                             low ambiguity
     |                                                        |
     v                                                        v
trajectory presets -> mixed local phases -> exact candidate -> verification -> effect owner
        |                    |                  |                  |              |
    heterogeneous       search-only         immutable-ish      sandboxed      existing
       search            advisories           identity          checking       authority
```

No layer in this experiment grants new authority. Existing OpenClaw admission,
tool policy, sandbox, cancellation, approval, publication, merge, and deployment
owners remain authoritative.

## Layer 1: trajectory presets

The generic internal contract is `DynamicsProfile`:

- role
- effective temperature
- mutation budget
- verification weight
- information boundary

The five built-in names are presets over that contract, not five new security
principals:

- `explorer`
- `builder`
- `critic`
- `independent-verifier`
- `glass-breaker`

The first layer binds the resolved preset and bounded explicit handoff into the
existing native collector launch path. The verifier preset additionally requests
the existing sandbox owner with `sandbox: "require"`; rejection is not retried
unsandboxed.

Implementation:

- `dynamics-types.ts`
- `dynamics-profiles.ts`
- `dynamics-handoffs.ts`
- `dynamics-spawn.ts`

## Layer 2: local population thermodynamics

A Swarm does not need one global mode. Different replicas may simultaneously
look gas-like, liquid-like, critical, crystalline, glassy, jammed, or unknown.

The controller therefore reasons locally and remains search-only:

- a local crystal may freeze without stopping unrelated exploration
- verifier disagreement triggers measurement rather than being averaged away
- a jammed minority lane remains visible
- missing semantic telemetry remains unknown instead of being invented

Host runtime integration only projects facts OpenClaw can actually observe,
including completion state and concurrency/debt pressure.

Implementation:

- `phase-assessment.ts`
- `population-controller.ts`
- `population-runtime.ts`

## Layer 3: exact candidate convergence

Exploration can be nondeterministic; verification must agree on what is being
verified.

A candidate manifest binds:

- candidate digest
- source digest
- execution recipe digest
- policy digest
- manifest version

The canonical manifest yields a stable candidate identity that participates in
the prepared native launch and therefore in the existing replay fingerprint.

Changing candidate, source, recipe, or policy changes identity.

This is identity binding, not proof of correctness.

Implementation:

- `candidate-evidence.ts`
- candidate handling in `dynamics-spawn.ts`

## Layer 4: diagnostics and folding

The final layer projects operator diagnostics from the same host-owned snapshot
used by the search-only population decision. It does not create another
scheduler or another authority plane.

Dynamics tracking is owned by the parent run. A failed or aborted parent wait
releases advisory bookkeeping without cancelling still-live sibling collectors.

The folding regression checks the intended progression across heterogeneous
phases and exact-candidate identity.

Implementation:

- `dynamics-diagnostics.ts`
- `liquid-swarm.folding.test.ts`
- native lifecycle integration in `code-mode-swarm.runtime.ts`

## Entropy gradient

The architectural goal can be summarized as:

```text
H(search)  >>  H(selection)  >  H(candidate)  >  H(verification)  >  H(authority)
```

Search may branch, disagree, mutate, and arrive out of order.

As a result approaches effect:

- information boundaries narrow
- candidate identity becomes exact
- replay becomes deterministic
- verification becomes more independent
- authority remains with explicit existing owners

This asymmetry is deliberate: exploration freedom is wider than authority
freedom.

## What this experiment does not claim

It does not yet provide:

- authenticated measurement receipts
- verifier-independence attestations
- automatic phase-actuated scheduling
- learned controller policy
- persistent dynamics history
- effect-request authorization
- merge or deployment authority
- a proof that the phase thresholds are empirically optimal

Those are separate layers that need evidence and the correct enforcement owners.

## Evidence strategy

The strongest end-to-end demonstration is a real native campaign that shows:

1. heterogeneous profile-enabled collector launches
2. multiple local outcomes
3. host-owned phase/advisory projection
4. selection of one exact candidate manifest
5. sandbox-required verifier execution
6. rejection without an unsandboxed retry when sandboxing is unavailable
7. replay against the same candidate identity

That demonstration is stronger than adding more mocked helper tests because it
tests the complete native boundary while preserving the existing authority model.
