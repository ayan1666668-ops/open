---
name: typesafe-evaluate
description: Make explicit provider-neutral decisions with the decision_evaluate tool.
---

# TypeSafe evaluations

Use `decision_evaluate` for semantic decisions over explicit supplied state. It
returns typed decisions, not generated explanations or permission to act. If the
tool is unavailable, report that; do not substitute shell/HTTP calls or ask for a
credential in chat. Hosted calls send the supplied data to TypeSafe and may incur
charges. With a configured local System One origin, calls go to that server
without a hosted credential.

Supply `{state, questions}`; see [mixed request example](references/request-example.json).
State and descriptions accept text, JSON objects/arrays, or null. Each question
sees the same state and is independent: it cannot read another answer in the batch.
Put meaning in instructions and criteria, not just the question ID.

- **Choice:** choose one of 2–255 named alternatives. Include a no-match alternative
  if appropriate. Preserve the selected label, full distribution, and confidence.
- **Score:** rate against 2–10 ordered descriptions. The answer is the fractional
  probability-weighted zero-based position, not a normalized score or integer.
- **Boolean:** probability of true, from 0 to 1, with optional `criteria.true` and
  `criteria.false` descriptions. This is not intensity and has no confidence field.

Only send necessary evidence authorized for sharing. Never include credentials.
Do not silently truncate evidence or split competing Choice options to fit a
request. The plugin bounds JSON to 4 MiB, 262144 nodes, and depth 64; provider token
limits are separate. The calling agent's configured `decisionModel` selects the
provider and model; do not add a per-call model override.

Reported probabilities may be rounded and need not sum exactly to one. Preserve the
vendor-selected label and score; normalization or selecting the largest reported
probability is an explicit consumer policy, not an adapter repair.

Batch independent questions. Use a later call when its state or options depend on
an earlier result. Validate judgment quality on representative cases before using
probabilities as thresholds; confidence is not the probability that a whole
workflow is correct. Preserve uncertainty and verify deterministic rules, current
evidence, and authorization separately. A service/validation error is not a
negative judgment; do not retry automatically or fabricate an answer.

The optional tool is distinct from the background decision-provider API. Enabling
the plugin/tool does not itself select a decision model or schedule consumer work.
The calling agent's global or per-agent `decisionModel` role selects the provider.
The legacy `typesafe_evaluate` tool remains available for migration and keeps its
TypeSafe-specific `noul` and per-call model semantics.
