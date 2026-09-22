Closes #152409

## What Problem This Solves

Fixes: a protected secret stored mid-session (the masked `openclaw__secrets` entry flow) never reaches later `openclaw__gateway_exec` calls in the same session. The child process receives an empty variable where the secret should be, and the downstream API reports an invalid or inactive token. This is the failure in #152409: a Meta token validated in Graph API Explorer returns error 2500 from exec, in both the query-parameter and `Authorization: Bearer` forms.

## User Impact

The store-then-retry sequence works: the agent requests a secret, the user supplies it through the masked flow, and the next exec call in the same session sees it. No duplicate plaintext `env` entry, no session restart.

Exec calls that run before any store change keep the cached snapshot unchanged, so the common path does no extra store reads.

## Why This Change Was Made

The exec tool instance cached the store environment snapshot (`readSecretStoreExecEnvironment`) for its whole lifetime. The previous comment assumed new runs construct new instances and therefore observe later store mutations, but the reported flow stores the secret and retries within one run. The cached snapshot predated the write, so `$META_ADS_ACCESS_TOKEN` expanded to an empty string. Meta returns code 2500 for an empty token, which reads as an inactive token and sent the original reporter debugging the wrong layer.

The fix adds a monotonic mutations counter to the secret store (`getSecretStoreMutationsVersion`, bumped by write, rollback write, allowed-hosts update, and delete) and keys the exec snapshot cache on it. The snapshot re-reads only when the store changed since the cache was taken.

Substitution itself was not the defect: a manual reproduction with a fixture token through the real proxy showed correct sentinel substitution in both query strings and Bearer headers once the sentinel reached the proxy. The stale snapshot was the broken link.

## Evidence

- New regression test `src/agents/bash-tools.exec.secret-store-cache.test.ts`, built from the issue's reproduction: exec before the store write produces an empty variable; after the write (version bump), the same tool instance expands the sentinel. The test fails on unpatched main and passes with the fix (verified by stashing the source change).
- New unit tests `src/secrets/store/secret-store.version.test.ts` cover the counter: write, allowed-hosts update, rollback write, and delete each bump it; reads do not.
- Focused Vitest: 66 tests across the two new files, the existing egress proxy suite, and the exec security-floor suite, all passing.
- No configuration, schema, or dependency changes. Feature-off behavior is unchanged.

## Review Fixes (2026-09-21, head d7b14403 and later)

Addressing the ClawSweeper review of `37a71795`:

**[P1] Ordinary environment snapshots stay run-stable.** `resolveStoreEnv` now splits into two layers: ordinary `kind: "env"` rows are read once per tool instance and never refreshed; only the protected-credential layer (sentinels + egress bindings) is keyed on the store mutations version. Ordinary env values no longer change mid-run, including with secret egress disabled.

**[P2] Successful rollbacks advance the mutation version.** A compensated write invalidates cached snapshots, so later commands return to the pre-write state instead of retaining the staged credential.

**[security] Egress grants re-validate on store divergence.** Process grants record the store mutations version at registration. When substitution happens after the version advanced, the grant re-checks the row against the live store (new `lookupSecretStoreBinding`) and refuses if the credential was rolled back/removed or the host binding changed. Lookup failures fail closed (refusal), never fall back to the stale grant.

## Real-path proof (synthetic fixtures, redacted)

Run against the real secret store (SQLite via the real state-db lifecycle) and the real exec-environment read path; all values are fixtures, nothing real:

```text
[1] before write: META sentinel = (absent)
[2] after write: version 0 -> 1; sentinel present = true; allowedHosts = ["graph.facebook.com"]
[3] rollback ok = true; version 2 -> 3 (advanced = true)
[3] refreshed snapshot contains PROVIDER_TOKEN = (absent - correct)
[4] META token still valid after unrelated rollback = true
```

Reproduction: `node --import ./scripts/tsx.mjs proof_store_refresh.mts` (committed at the repo root of the branch).

The proxy forwarding chain (CONNECT -> substitution -> upstream) is covered by the real-socket egress suite: 38 proxy-server tests including the new `re-validates a registered grant when the store mutations version advances`, which registers a grant against a staged row, rolls it back, and asserts the next substitution is refused (`destination-not-allowed`) with no new origin request. Full affected-suite result: 150 tests across 9 files (secret store, egress proxy, exec cache) all passing; the two pre-existing `bash-tools.exec.approval-id.test.ts` follow-up failures reproduce on pristine `37a71795` without these changes and are unrelated (network-dependent follow-up routing).

## Snapshot-scope decision

Per the review recommendation: refresh is narrowed to protected credentials only. Ordinary env rows and host-policy snapshots keep the documented run-stable lifetime; already-running process grants keep their documented lifetime, with the one addition that a store divergence re-validates the grant's bindings at substitution time so compensated credentials cannot be used by commands launched after rollback.
