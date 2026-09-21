---
summary: "Search-only mixed-phase diagnostics for native Swarm collectors"
title: "Swarm dynamics consolidation"
status: experimental
---

# Swarm dynamics consolidation

This layer turns host-owned collector facts into one operator-facing diagnostic
projection. It does not add a second scheduler and it does not grant authority.

The runtime projects facts OpenClaw already owns:

- collector identity
- terminal completion state
- current group concurrency pressure
- failure/debt pressure
- completion/progress state

Semantic properties that the host cannot currently attest remain unknown rather
than being guessed from model confidence.

## One production path

The production entrypoint is `diagnoseHostCollectorPopulation`. It builds one
snapshot, derives one search-only decision, and derives diagnostics from that
same snapshot.

There is deliberately no parallel test-only assessment API.

```text
native collector records
        |
        v
host-owned snapshot
        |
        +--> search-only advisory
        |
        +--> operator diagnostic
```

The diagnostic cannot approve a tool, widen permissions, bypass sandboxing,
publish, merge, deploy, or mutate live policy.

## Lifecycle ownership

Dynamics tracking belongs to the parent Code Mode run that created the group.
When the parent wait is aborted or fails, advisory state is released immediately.
That cleanup removes only diagnostic bookkeeping; it does not cancel or mutate
still-running sibling collectors.

This is important for the Liquid model: exploration may fan out aggressively,
but abandoned observation state must not accumulate forever in the long-lived
Gateway process.

## What this layer intentionally does not claim

This implementation does not contain:

- persistent memory crystallization
- shadow-policy adoption
- self-modifying controller policy
- trusted verification receipts
- effect authorization
- a second scheduler
- a separate persistence engine

Those are future design areas, not hidden capabilities of this PR.

## Philosophy

Liquid Swarm separates two kinds of freedom:

1. **Search freedom** — multiple temperatures, roles, hypotheses, and local
   regimes can coexist.
2. **Authority freedom** — none. Existing OpenClaw owners remain the only
   components that may admit execution or authorize effects.

That asymmetry is deliberate. Exploration should be rich; authority should be
narrow.

## Related

- [Liquid Software Factory](/concepts/liquid-software-factory) for the end-to-end search-to-convergence architecture.
