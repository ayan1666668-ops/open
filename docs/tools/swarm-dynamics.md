---
summary: "Experimental opt-in cognitive profiles for native Swarm collectors"
title: "Swarm cognitive dynamics"
status: experimental
---

# Swarm cognitive dynamics

OpenClaw Code Mode can prepare a native collector with a versioned cognitive profile:

```javascript
const result = await agents.run("Explore alternate explanations for this failure.", {
  dynamics: { profile: "explorer" },
});
```

This uses the existing `agents.run` to `sessions_spawn` bridge. It does not
install a controller service, add a scheduler, change tool permissions, or add
dependencies. Calls without `dynamics` keep their existing behavior.

## Profiles

- `explorer`: broad search with an isolated handoff.
- `builder`: moderate exploration with summary-only handoff coordination.
- `critic`: evidence-oriented challenge.
- `independent-verifier`: artifact-only explicit handoff and a required sandbox.
- `glass-breaker`: a fresh trajectory intended for stalled search.

Effective temperature and mutation budget are search guidance, not model sampling
parameters or enforced filesystem permissions. Model and thinking overrides retain
their existing meanings.

Profiles are execution trajectories, not security principals. The native value is
that OpenClaw can bind the trajectory into the launch, constrain explicit handoff,
and enforce generic resolved requirements without making a preset name an authority
hook. The verifier preset currently resolves to required sandbox, candidate digest,
and artifact references.

## Verifier handoff

```javascript
const review = await agents.run("Check this candidate against the stated acceptance criteria.", {
  dynamics: {
    profile: "independent-verifier",
    handoff: {
      candidateDigest: "the-candidate-digest",
      artifactRefs: ["the-available-artifact-reference"],
    },
  },
});
```

The bridge filters the explicit handoff, uses `context: "isolated"`, and derives
sandbox/evidence enforcement from the resolved profile requirements. For the
verifier preset those requirements pass `sandbox: "require"` to the existing
native spawn owner and require candidate/artifact handoff. Missing sandbox support
is an error; it never silently retries without a sandbox.

References are caller-provided data, not fetched automatically or treated as
authority. Each reference is limited to 512 characters, each reference array to
32 entries, and a supplied summary to 4096 characters.

The resolved profile, handoff, exact candidate manifest when supplied, and
host-derived run identities are serialized before the existing launch fingerprint
is computed. Changing profile or bound candidate identity therefore changes the
launch identity.

## Liquid search, deterministic convergence

The intended progression is:

```text
explore broadly -> coordinate -> challenge -> freeze exact candidate -> verify
```

Different lanes may occupy different phases at the same time. Diagnostics remain
search-only. Existing admission, tool policy, sandbox, cancellation, approval,
publication, merge, and deployment owners retain authority.

## Lifecycle

Dynamics diagnostic bookkeeping is owned by the parent run through OpenClaw's
existing catalog/run disposal lifetime. Parent disposal or abort releases that
bookkeeping. Recoverable wait errors leave it intact. Cleanup does not cancel live
sibling collectors; it only prevents abandoned advisory state from accumulating
in the Gateway process.

## Limits and trust

Handoff filtering is not a complete independence guarantee. It does not sanitize
the caller's original task, disable shared memory, mount candidate artifacts
read-only, or prove that another permitted tool cannot reach sibling data.

The verifier profile name describes its intended role, not an attestation. The
runtime and operator's existing policies must establish any stronger isolation.

The current implementation does not attest measurement receipts, approve effects,
adopt policy, or automatically execute advisory population actions.

## Validation

Repository tests cover profile resolution, generic requirement enforcement,
handoff filtering, exact candidate binding, replay identity, host-owned population
diagnostics, local mixed-phase regressions, and refusal to downgrade a
sandbox-required verifier. The native-boundary regression reaches the real
`spawnSubagentDirect` admission path rather than mocking it.

A live model-backed native collector transcript remains useful end-to-end evidence
for the experiment and should be captured before claiming production readiness.

## Related

- [Liquid Software Factory](/concepts/liquid-software-factory) for the end-to-end search-to-convergence architecture.
