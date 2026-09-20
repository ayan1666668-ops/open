---
summary: "Experimental OpenClaw-native mixed-phase Swarm dynamics"
title: "Swarm cognitive dynamics"
status: experimental
---

# Swarm cognitive dynamics

This experimental surface models heterogeneous Swarm collector runs as **cognitive replicas**.

A configured OpenClaw agent remains the identity and permission boundary. A replica is one bounded
execution trajectory. Dynamics never grant tools, credentials, approvals, or publication authority.

The first version intentionally uses a small host-owned profile catalog:

- `explorer`: high exploration freedom, isolated context.
- `builder`: moderate exploration with summary-only coordination.
- `critic`: evidence-oriented challenge lane.
- `independent-verifier`: artifact-only input, no candidate mutation.
- `glass-breaker`: bounded fresh trajectory for stalled search.

`effectiveTemperature` is a policy-level description of exploration freedom. It is **not** a direct
LLM sampling-temperature control.

## Information boundaries

Replica handoffs use one of:

- `isolated`
- `artifact-only`
- `evidence-only`
- `summary-only`
- `fork`

These boundaries describe what may be handed from one replica to another. Later integration must
enforce them against session visibility, workspace access, memory, and tools before claiming strict
independence.

## Authority invariant

Cognitive dynamics are search-only. Existing OpenClaw admission, tool policy, sandbox, approval,
cancellation, and execution owners remain authoritative.
