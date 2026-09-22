---
summary: "Phenomenological mixed-regime search for heterogeneous Swarm workers"
title: "Mixed-regime Swarm search"
status: experimental
---

# Mixed-regime Swarm search

A Swarm group does not need one global reasoning mode.

Different replicas can use different models, thinking levels, contexts, and
strategies at the same time. The regime taxonomy is a compact operator vocabulary
for what those lanes appear to be doing; it is **not literal thermodynamics**.

| Regime   | Engineering meaning                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------- |
| gas      | high candidate diversity with low coherence                                                              |
| liquid   | productive motion with moderate coherence                                                                |
| critical | umbrella label for a lane that needs discrimination before amplification                                 |
| crystal  | frozen-candidate heuristic: low entropy, strong coherence/evidence, no contradictory acceptance progress |
| glass    | low mobility + low progress while evidence is still incomplete                                           |
| jammed   | resource/context/debt pressure dominates useful search                                                   |
| unknown  | insufficient measured telemetry                                                                          |

`critical` has an explicit typed trigger:

- `verifier-conflict` — independent checks disagree
- `entropy-ambiguity` — candidate entropy lies in the declared ambiguity band

The controller therefore does not pretend those two situations are the same
physical phenomenon even though they share the same high-level action family.

## Different compute levels in one group

A useful orchestration pattern is:

```javascript
const cheap = prompts.map((prompt) =>
  agents.run(prompt, {
    thinking: "low",
    fastMode: true,
    dynamics: { boundary: "isolated" },
  }),
);

// A selected unresolved lane can later be relaunched by the caller with:
const deep = agents.run("Discriminate the two surviving hypotheses.", {
  thinking: "high",
  dynamics: { boundary: "evidence-only" },
});
```

The population controller's `deepen` action recommends `thinking: "high"` only for
selected critical lanes. It does not automatically relaunch them.

## Measurement before amplification

The important rule is not "critical physics." It is:

> When trajectories disagree, obtain a discriminating observable before buying more copies of the disagreement.

Typed measurements can update the population snapshot with provenance:

- `host` — derived from state OpenClaw directly owns
- `external` — supplied by another trusted integration or caller

`external` is provenance, not authentication. Authenticated measurement receipts
remain future work.

## Search-only control

The controller may return `spawn`, `measure`, `deepen`, `freeze`, `perturb`,
`drain`, or `hold`. Every decision remains `authority: "search-only"`.

A regime is diagnostic state. An action is an advisory. Neither is permission.
