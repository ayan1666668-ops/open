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
- generic spawn requirements: sandbox mode, candidate identity, and artifact presence

The five built-in names are presets over that contract, not five new security
principals:

- `explorer`
- `builder`
- `critic`
- `independent-verifier`
- `glass-breaker`

The first layer binds the resolved preset and bounded explicit handoff into the
existing native collector launch path. Enforcement is derived from the resolved
generic requirements, never from a privileged profile-name branch. The verifier
preset currently resolves to required sandbox, candidate digest, and artifact
references; rejection is not retried unsandboxed.

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

Dynamics tracking is owned by the parent run. Parent catalog/run disposal or
abort releases advisory bookkeeping without cancelling still-live sibling collectors.

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

## Scientific model: analogy, observables, and limits

The phase language is an engineering model, not a claim that agent populations
obey equilibrium thermodynamics.

The useful correspondence is:

| Physical idea | Search interpretation | Current observable |
| --- | --- | --- |
| temperature | willingness to mutate or leave a local basin | profile `effectiveTemperature`, guidance only |
| entropy | diversity/uncertainty of candidate state | `candidateEntropy`, caller-supplied when trusted |
| mobility | ability to continue making distinct progress | `mobility` |
| coherence | convergence around compatible structure | `coherence` |
| criticality | small changes/disagreement deserve measurement | entropy transition band or verifier disagreement |
| crystallization | a local candidate is stable enough to stop mutating | low entropy + high coherence/evidence |
| glass | search is stuck without enough evidence | low mobility + low progress + incomplete evidence |
| jamming | resources/context/debt dominate useful search | max resource/context/debt pressure |

Unknown measurements remain `null`. The system does not turn absence of
measurement into zero, confidence, or success.

The present phase boundaries are explicit heuristics. They are intentionally
inspectable and regression-tested, but they are not statistically calibrated
phase-transition estimates.

## Control loop

The intended closed loop is:

```text
observe host facts / trusted measurements
                 |
                 v
        classify local phases
                 |
                 v
       build population snapshot
                 |
                 v
     propose search-only action
                 |
                 v
   existing execution owner decides
                 |
                 v
        execute / reject / queue
                 |
                 v
          record new facts
                 |
                 +-----------> observe again
```

The controller never closes the authority loop by itself. It proposes; the
existing owner admits or rejects.

This separation makes the control system composable with OpenClaw's current
sandbox, policy, cancellation, and approval machinery.

## Engineering invariants

The implementation is built around several invariants that matter more than the
phase names themselves.

### 1. Search authority is not effect authority

Every population decision is `authority: "search-only"`.

A search recommendation cannot mint credentials, widen tools, bypass a sandbox,
approve an operation, merge, publish, or deploy.

### 2. Identity becomes stricter toward convergence

A free-form hypothesis may mutate during search. A frozen candidate may not
silently change underneath verification.

Candidate, source, recipe, and policy digests therefore participate in one stable
candidate identity and in the native launch fingerprint.

### 3. Unknown stays unknown

Missing semantic telemetry is represented as unknown rather than fabricated from
model confidence or terminal success.

This prevents an observation gap from becoming false evidence.

### 4. Local failures are not averaged away

Resource, context, and debt pressure use conservative maxima. One saturated lane
can force a drain recommendation even when the population average looks healthy.

Likewise, a local crystal can freeze without forcing unrelated exploratory lanes
to stop.

### 5. Critical disagreement triggers measurement

Verifier disagreement is treated as information demand, not merely another
failure score. The preferred response is to measure before widening search.

### 6. Replay is idempotent and identity-bound

The existing idempotency key and request fingerprint remain the execution
boundary. A replay with different prepared bytes is rejected instead of silently
reusing a prior collector.

### 7. Lifetime has an owner

Advisory tracking belongs to the parent run. Parent catalog/run disposal or abort
releases that bookkeeping without mutating live sibling collectors. Recoverable
wait errors do not destroy the observer.

Search may be highly parallel; ownership and cleanup may not be ambiguous.

### 8. Fail closed at independence boundaries

The resolved profile requirements ask the existing sandbox owner for
`sandbox: "require"` where required. A failure is surfaced; there is no
unsandboxed retry.

The preset name itself is not an authority hook or proof of independence.

## Time-scale separation

The design intentionally has different control speeds:

```text
fast:     individual replica exploration / mutation
medium:   population observation and search advisories
slow:     candidate freeze, verification, promotion/effect
```

A slow authority boundary should not oscillate simply because fast exploratory
state is noisy.

The current experiment uses explicit thresholds rather than hysteresis windows.
If automatic actuation is added later, hysteresis or dwell-time requirements
should be considered before allowing phase transitions to drive execution.

## Diversity, correlation, and effective population

Raw agent count is not the same as independent search capacity.

The model already carries `meanCorrelation` and replica lineage fields so future
instrumentation can distinguish ten genuinely different trajectories from ten
copies of the same assumption.

A useful research heuristic for a roughly exchangeable population is:

```text
N_effective ~= N / (1 + (N - 1) * rho)
```

where `rho` is mean trajectory correlation.

This equation is **not** currently used by the controller. It states the deeper
design goal: spend compute on independent information, not merely more replicas.

Similarly, `branchingRatio` exists as an observation field but is not yet an
actuation rule. A future calibrated controller could test whether productive
search tends to live near a branching regime around one:

```text
branching < 1   -> exploration dies out
branching >> 1  -> combinatorial explosion / jam
branching ~= 1  -> candidate critical regime to measure
```

That remains a hypothesis to validate from traces, not a current guarantee.

## Causal lineage and epistemic provenance

`CognitiveReplica` includes `parentReplicaId`, which is the beginning of a
causal search graph:

```text
root
 +-- explorer A
 |    +-- candidate A1
 |    +-- candidate A2
 +-- explorer B
      +-- candidate B1
              |
              v
        frozen candidate
              |
              v
           verifier
```

The current native integration does not yet persist a full lineage DAG.

The deeper goal is to distinguish:

- independent rediscovery from shared ancestry
- true verifier independence from inherited assumptions
- novel branches from duplicated work
- reusable evidence from candidate-specific evidence

This is epistemic provenance, not just process provenance.

## Selection should eventually be multi-objective

A mature factory should not reduce every candidate to one scalar confidence.

Useful selection dimensions include:

- correctness evidence
- novelty / decorrelation
- reproducibility
- cost
- latency
- risk
- unresolved obligations

A Pareto frontier or explicitly governed selection policy is a better long-term
fit than a single hidden model score.

The current implementation stops before that layer. It freezes eligible local
crystals and binds exact candidate identity; it does not implement a global
winner-selection algorithm.

## Candidate capsule direction

The current `CandidateManifest` is deliberately small:

```text
candidate digest
source digest
recipe digest
policy digest
```

A future reproducible candidate capsule could additionally bind environment
snapshot, inputs, execution trace, logs, measurements, and lineage.

That would turn:

```text
"verify candidate A"
```

into:

```text
"verify this exact reproducible computation"
```

The current manifest should be understood as the minimal identity kernel for
that direction, not as complete provenance.

## Information flow and trust flow are different

The complete architecture has two simultaneous flows:

```text
INFORMATION FLOW

many hypotheses -> local measurements -> candidate -> verifier evidence
       high entropy                              low ambiguity


TRUST / AUTHORITY FLOW

search-only ------------------------------------> existing effect owner
   no new authority is accumulated along the way
```

This is the central engineering claim of Liquid Software Factory:

> computation may accumulate evidence without accumulating permission.

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

The repository now includes an in-process native-boundary test that reaches the
real `spawnSubagentDirect` admission path, proves prepared verifier/candidate
guidance reaches native dispatch when sandbox admission succeeds, and proves a
required sandbox rejects before dispatch with no downgrade. A model-backed
collector transcript remains the strongest final proof.

That demonstration is stronger than adding more mocked helper tests because it
tests the complete native boundary while preserving the existing authority model.

## Related

- [Liquid Software Factory PR stack](/concepts/liquid-software-factory-stack) for the four-layer review topology.
