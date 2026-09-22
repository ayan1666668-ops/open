---
summary: "Search-only diagnostics for adaptive Swarm compute"
title: "Swarm dynamics diagnostics"
status: experimental
---

# Swarm dynamics diagnostics

The runtime turns OpenClaw-owned collector facts into one operator-facing
diagnostic projection. It does not add a second scheduler and it does not grant
authority.

## What the host actually observes

The native collector path currently owns:

- collector identity
- terminal completion state
- current group concurrency pressure
- failure/debt pressure
- terminal progress

Those values are recorded as typed measurements with `source: "host"`.

Semantic quantities such as candidate entropy, coherence, mobility, acceptance
progress, verifier disagreement, branching ratio, and trajectory correlation are
not inferred from a successful child. They remain unknown unless a separate
producer supplies them. Such values are recorded as `source: "external"`, which
is provenance only, not an authenticated receipt.

## One production path

`diagnoseHostCollectorPopulation` builds one snapshot, derives one search-only
decision, and derives diagnostics from that same snapshot.

```text
native collector records
        |
        v
typed host measurements
        |
        v
population snapshot
        |
        +--> search-only advisory
        |
        +--> operator diagnostic
```

Diagnostics can expose raw replica count, known correlation source, effective
independent replica estimate, regime mixture, pressure, acceptance progress,
measurement-source counts, and unresolved conditions.

## Lifecycle ownership

Dynamics tracking belongs to the parent run that created the group. Parent
catalog disposal or abort releases observer bookkeeping without cancelling
still-running sibling collectors. Recoverable wait errors do not tear down the
observer.

## Advisory, not actuator

The controller may recommend `spawn`, `measure`, `deepen`, `freeze`,
`perturb`, `drain`, or `hold`. A `deepen` recommendation includes
`suggestedThinking: "high"` so callers can map the advisory onto OpenClaw's
existing per-run thinking option.

The runtime does not automatically execute those actions. Existing admission,
sandbox, policy, cancellation, and approval owners remain authoritative.

## Intentionally deferred

- native semantic trajectory-overlap estimator
- authenticated measurement receipts
- automatic action executor
- hysteresis/dwell-time control for automatic actuation
- persistent dynamics history
- effect authorization
