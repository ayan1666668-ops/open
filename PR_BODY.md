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
