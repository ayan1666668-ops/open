---
summary: "Adaptive test-time compute: heterogeneous search with deterministic convergence"
title: "Liquid Software Factory"
status: experimental
---

# Liquid Software Factory

"Liquid" is the project name and a useful mental model. The implementation is an
**adaptive test-time compute control plane for Swarm**, not a thermodynamics claim.

> Spend compute on uncertainty, not uniformly on agents.

OpenClaw already has the execution primitives needed for heterogeneous cognition:
each `agents.run` may choose its own model, `thinking` level, fast mode, prompt,
schema, and tool context. This experiment adds the missing population-level
mechanics:

1. preserve diversity early,
2. observe only signals with known provenance,
3. detect pressure, redundancy, conflict, ambiguity, or arrest,
4. recommend bounded changes in compute,
5. freeze one exact candidate without stopping unrelated search,
6. verify that candidate under stricter information/sandbox boundaries,
7. converge through existing deterministic authority owners.

```text
cheap low-thinking exploration
     |       |       |
     +-------+-------+
             |
             v
 host facts + external typed measurements
             |
      +------+------+
      |             |
      v             v
 decorrelate      measure conflict
 redundancy       then deepen a few
      |             |
      +------+------+
             v
      frozen exact candidate
             |
             v
   sandbox-required verifier
             |
             v
 deterministic replay / existing authority
```

## The asymmetry

The central design is an entropy gradient, not a phase name:

```text
H(search) >> H(selection) > H(candidate) > H(verification) > H(authority)
```

Exploration can be stochastic, heterogeneous, redundant, adversarial, and out of
order. Candidate identity, verifier admission, replay, and external effects become
progressively stricter.

> Search can be stochastic. Promotion cannot be accidental.

## Different agents can work at different levels

There is deliberately no global "Swarm thinking level."

A group can contain, simultaneously:

- dozens of low-thinking, fast, isolated explorers,
- medium-thinking coordinators or implementers,
- high-thinking lanes only for conflicts that earn extra compute,
- high-thinking sandbox-required verifiers for frozen candidates.

The existing `agents.run({ model, thinking, fastMode })` options remain the
execution primitive. The new controller's `deepen` action is only an advisory and
suggests `thinking: "high"` for selected lanes.

This is the practical meaning of:

> Exploration should be broad and cheap. Deep reasoning should be scarce and earned.

## Generic launch mechanics

The dynamics contract owns only mechanics that require a trusted native boundary:

- explicit information boundary
- bounded handoff
- monotone sandbox/candidate/artifact requirements
- exact candidate manifest
- source/target replica identity
- launch-byte binding into existing replay identity

Explorer, builder, critic, verifier, and glass-breaker remain caller-side recipes.
They are not principals or permissions.

> The mechanics are core; the personalities are recipes.

## Observable provenance

The population model separates values from their provenance.

Typed measurement sources are:

- `host`: facts OpenClaw directly owns
- `external`: measurements supplied by another integration

Today the native collector path can honestly derive:

- concurrency/resource pressure
- terminal success/failure debt
- terminal progress

It deliberately leaves semantic quantities unknown unless another producer supplies
them:

- candidate entropy
- coherence
- mobility
- acceptance progress
- verifier disagreement
- branching ratio
- trajectory correlation

`external` means "supplied from outside this host projector." It does **not** mean
cryptographically authenticated.

Unknown remains `null`. Successful completion does not fabricate semantic evidence.

## Phenomenological regime taxonomy

The regime names are an operator vocabulary, not calibrated physics.

| Regime   | Current heuristic meaning                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| gas      | high candidate entropy + low coherence                                                                         |
| liquid   | productive mobility + moderate coherence                                                                       |
| critical | umbrella for verifier conflict or mid-entropy ambiguity                                                        |
| crystal  | frozen-candidate heuristic with low entropy + high coherence/evidence and no contradictory acceptance progress |
| glass    | low mobility/progress with incomplete evidence                                                                 |
| jammed   | resource/context/debt pressure dominates                                                                       |
| unknown  | insufficient telemetry                                                                                         |

Each assessment carries a `trigger` so overloaded `critical` is disambiguated:

- `verifier-conflict`
- `entropy-ambiguity`

The assessment also carries a heuristic `score`, not a field named confidence.

All thresholds live in named constants and are documented as experimental policy,
not statistically calibrated transitions.

## A reaction coordinate separate from entropy

`acceptanceProgress` is a separate normalized coordinate for distance to the
acceptance boundary: for example, fraction of required checks green or an
equivalent trusted acceptance metric.

This matters because a low-entropy population may have converged on the same wrong
answer. Low entropy alone is never enough to prove success.

If acceptance progress is known and low, the candidate does not enter the frozen
candidate regime even when entropy/coherence/evidence otherwise look good.

## Conflict: measure, then selectively deepen

When enough lanes are critical, the controller first returns `measure`.

It then ranks critical observations by verifier disagreement / ambiguity signal and
selects only:

```text
min(8, ceil(sqrt(number_of_critical_lanes)))
```

for `deepen`, with `suggestedThinking: "high"`.

For 25 critical lanes, only 5 earn high-thinking depth. For a much larger swarm,
the advisory is capped at 8.

This is intentionally not "make every agent think harder."

## Effective independent search

Raw agent count is not independent search capacity.

If a trusted producer supplies mean trajectory correlation `rho`, the controller
uses the explicit heuristic:

```text
N_effective ~= N / (1 + (N - 1) * rho)
```

If correlation is unknown, `N_effective` is unknown.

The snapshot records whether mean correlation came from `host` or `external`.
The current native host does not estimate semantic trajectory correlation.

When measured effective population falls to <= 50% of raw population, the
controller:

- requests one bounded decorrelating perturbation
- suppresses additional gas-phase fan-out

The one-number correlation model is deliberately simple. Pairwise-overlap
distributions or lineage-aware estimators are future calibration work.

## Local arrest, pressure, and coexistence

Resource/context/debt pressure use conservative maxima so one saturated lane cannot
disappear inside a healthy average.

A glass-like lane requests one bounded decorrelating perturbation instead of
unbounded respawn.

A frozen candidate is local: unrelated exploratory lanes may continue.

Automatic actuation is intentionally absent. Because the controller is advisory,
hysteresis/dwell-time machinery is not yet required for safety. It should be added
before phase changes are allowed to execute resource actions automatically.

## Exact candidate convergence

A candidate manifest binds:

```text
candidate digest
source digest
recipe digest
policy digest
manifest version
```

Canonical serialization produces a stable candidate identity. The manifest and
identity are included in prepared launch bytes before the existing request
fingerprint is computed.

Changing candidate, source, recipe, or policy changes identity.

Identity is not correctness, evidence, or authorization.

## Independent verification boundary

A verification recipe can use:

- `boundary: "artifact-only"`
- required candidate identity
- required artifact refs
- `sandbox: "require"`
- its own high thinking level

If the existing sandbox owner cannot satisfy the requirement, launch fails closed.
There is no unsandboxed retry.

Handoff filtering narrows explicit information flow; it does not by itself prove
that two workers are epistemically independent.

## Search-only authority

Every population decision is `authority: "search-only"`.

The controller can recommend:

- `spawn`
- `measure`
- `deepen`
- `freeze`
- `perturb`
- `drain`
- `hold`

It cannot grant tools, credentials, sandbox exemptions, approval, publication,
merge, or deployment authority.

> Computation may accumulate evidence without accumulating permission.

## Lifecycle ownership

Population advisory state belongs to the parent run. Parent disposal or abort
releases the observer state. Recoverable wait failures do not destroy it.
Observer cleanup does not cancel unrelated live children.

## What is implemented versus deferred

Implemented:

- generic bounded dynamics launch contract
- fail-closed sandbox requirement
- per-run heterogeneous `thinking`/model/fast-mode compatibility
- typed measurement provenance
- separate acceptance-progress coordinate
- explicit conflict-vs-ambiguity triggers
- named heuristic policy constants
- mixed local regime assessment
- max-pressure jamming
- selective high-thinking deepen advisory
- effective-population correlation heuristic
- correlation-aware decorrelation/fan-out suppression
- local freeze
- exact candidate/source/recipe/policy identity
- replay mismatch rejection
- lifecycle diagnostics and cleanup
- folding regression through exact verifier preparation

Deferred:

- native semantic entropy/coherence/correlation estimator
- authenticated measurement receipts
- pairwise overlap distribution / lineage-aware correlation
- autonomous action executor
- hysteresis/dwell-time controller for automatic actuation
- verifier-independence attestation
- persistent dynamics history/UI
- learned policy
- effect authorization

## Evidence strategy

The repository evidence intentionally has layers:

1. pure unit/regression coverage for policy invariants,
2. typed measurement/provenance coverage,
3. full folding regression from heterogeneous search to exact verifier preparation,
4. real native `spawnSubagentDirect` admission coverage proving required sandboxing
   fails closed,
5. real registry/replay/wait/lifecycle owners with final provider/model execution
   substituted.

A redacted live model-backed native campaign would still be stronger evidence than
another mocked helper test. This experiment does not claim that proof yet.
