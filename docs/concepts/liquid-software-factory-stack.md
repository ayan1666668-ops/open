---
summary: "Adaptive test-time compute architecture for heterogeneous Swarm search"
title: "Adaptive test-time compute architecture"
status: experimental
---

# Adaptive test-time compute architecture

OpenClaw Swarm already supports heterogeneous workers: each `agents.run` can choose
its own model, thinking level, fast mode, prompt, and tools. This experiment adds a
small **advisory control plane** around that existing execution model.

> Spend compute on uncertainty, not uniformly on agents.

The core progression is:

```text
many cheap heterogeneous trajectories
              |
              v
host facts + typed external measurements
              |
      +-------+--------+
      |                |
      v                v
decorrelate         measure conflict
redundant lanes     then selectively deepen
      |                |
      +-------+--------+
              v
       freeze exact candidate
              |
              v
 sandbox-required verification
              |
              v
 deterministic existing authority
```

This is not a second scheduler and not a new permission plane. Population decisions
are `authority: "search-only"`. Existing OpenClaw admission, sandbox, tool-policy,
cancellation, approval, merge, publish, and deployment owners remain authoritative.

## Heterogeneous levels are the point

A single group may intentionally contain:

- many low-thinking / fast exploratory replicas,
- medium-thinking coordinating or implementation replicas,
- high-thinking discriminators for a small set of unresolved conflicts,
- sandbox-required verifiers for frozen candidates.

The controller does not force every replica onto one global reasoning level.
A `deepen` advisory merely recommends `thinking: "high"` for selected lanes; the
existing caller/execution owner decides whether and how to launch that work.

## Four internal responsibilities

1. **Generic launch mechanics**
   - bounded handoff
   - explicit information boundaries
   - monotone sandbox/candidate/artifact requirements
   - exact prepared launch bytes participate in replay identity

2. **Population assessment**
   - local gas/liquid/critical/crystal/glass/jammed/unknown regime labels
   - explicit trigger distinguishes verifier conflict from entropy ambiguity
   - max pressure prevents a saturated minority lane from being averaged away
   - typed measurements retain `host` versus `external` provenance
   - an independent acceptance-progress coordinate stays separate from entropy

3. **Adaptive compute policy**
   - conflict creates measurement demand before more breadth
   - only a bounded sublinear subset earns deep reasoning
   - measured correlation can suppress redundant fan-out
   - glass-like arrest requests one bounded decorrelating perturbation
   - frozen local candidates stop mutating while unrelated exploration continues

4. **Deterministic convergence**
   - candidate + source + recipe + policy form one exact identity
   - required verifier sandboxing fails closed
   - replay is idempotent and identity-bound
   - diagnostics/lifecycle state has an explicit parent owner

## Invariants

- unknown stays unknown
- measurement provenance is retained
- external measurement is not an authenticated receipt
- correlation is never invented by the host
- identity is not correctness
- phase labels are heuristics, not calibrated physics
- advisories are not actuators
- evidence may accumulate without permission accumulating

## Mental model

The Liquid name is useful only as a picture of mixed local regimes and progressive
loss of search entropy. The implementation is better described as a driven,
non-equilibrium population with explicit observables and a search-only controller.

The architecture does **not** claim a partition function, free energy, equilibrium
temperature, or statistically calibrated phase transition.
