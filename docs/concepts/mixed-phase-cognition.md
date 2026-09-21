---
summary: "Why OpenClaw Swarm can use different cognitive regimes at the same time"
title: "Mixed-phase cognition"
status: experimental
---

# Mixed-phase cognition

A Swarm group does not need one global cognitive phase.

The useful mental model is a material with local phases rather than a meeting
where every agent is told to "think harder" in the same way.

Different replicas can simultaneously occupy different observed regimes:

- **gas** — broad, weakly coordinated exploration
- **liquid** — productive mobility with rising coherence
- **critical** — disagreement or sensitivity that should trigger measurement
- **crystal** — a local candidate stable enough to freeze for verification
- **glass** — low mobility and low progress without enough evidence
- **jammed** — resource, context, or cleanup pressure dominates
- **unknown** — telemetry is insufficient to classify safely

The important word is **local**. A crystal in one lane does not require the
whole Swarm to stop. A jammed lane should not be averaged away by nine healthy
ones. A critical disagreement should not be mislabeled as generic failure.

## The Liquid Software Factory invariant

The system intentionally changes character as work moves from search to effect:

```text
high entropy                                      low ambiguity
     |                                                 |
     v                                                 v
gas -> liquid -> critical -> local crystal -> verification -> effect owner
 ^         ^           ^             ^             ^              ^
 |         |           |             |             |              |
diverse   combine     measure       freeze       exact identity   existing
search    useful      disagreement  candidate    + replay         authority
```

Exploration may be nondeterministic.

Convergence should become progressively more deterministic.

Authority should remain deterministic and external to the search controller.

This gives the architecture its central split:

> Search can be stochastic. Promotion cannot be accidental.

## Recipes are policy, not permissions

Liquid orchestration may use caller-side labels such as explorer, builder, critic,
independent verifier, or glass breaker to describe intentionally different search
trajectories. Those names are recipes outside the native API.

Core owns only mechanics that require a trusted host boundary: bounded handoff
filtering, explicit information boundaries, stricter existing admission
requirements, and replay identity.

A caller-side verification recipe can therefore request an artifact-only handoff
and a required sandbox without turning the recipe name into a principal,
permission, or attestation.

## Search-only controller

The controller may recommend bounded actions such as spawn, measure, freeze,
perturb, drain, or hold.

Those are advisories only.

Existing OpenClaw admission, policy, cancellation, sandbox, and approval owners
still decide what can actually execute.

A phase is descriptive telemetry. A control action is a recommendation. Neither
is authority.

## Related

- [Liquid Software Factory](/concepts/liquid-software-factory) for the end-to-end search-to-convergence architecture.
