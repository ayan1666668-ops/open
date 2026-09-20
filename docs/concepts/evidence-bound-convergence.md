---
summary: "Exact candidate identity and verification contracts for Swarm convergence"
title: "Evidence-bound convergence"
status: experimental
---

# Evidence-bound convergence

Mixed-phase search must converge on exact candidates rather than agent confidence.

A candidate manifest binds:

- candidate content
- source state
- execution recipe
- governing policy

Verification uses a frozen contract with mandatory measurement requirements. A candidate is verified
only when every mandatory requirement has enough independent passing evidence and no bound failure is
present.

Independence is represented by host-controlled keys and must not be inferred from two agents saying
that they are independent.

A verified candidate may produce an **effect request**. The request remains `request-only`; existing
OpenClaw permission, sandbox, tool-policy, approval, and effect owners remain authoritative.

Changing candidate bytes, relevant source/recipe identity, policy, or the verification contract
invalidates the prior result.
