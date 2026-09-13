# Mobile browser handoff dogfood report

PR #143015. Validation date: 2026-09-11. Code candidate: `1fb3574551b02243d6fea0a08c308908e476c960`.

## Behavior under test

The phone viewer gives the remote browser more space and moves task details out of the main interaction area. One-finger swipes scroll, including swipes that begin in blank viewer space. Scrolling sends pixel wheel input to the bound browser tab, so a focused text field does not receive navigation keys. Pinch gestures zoom the viewer without producing a trailing tap.

The handoff remains bound to one browser tab and its current control authority. It does not restrict that tab to one website or prevent in-page navigation. Scoped handoff credentials are separate from normal Gateway authentication.

## Automated proof

- 102 Browser tests and 39 UI tests passed. Browser coverage includes normalized wheel coordinates and deltas, handoff target binding, authority revocation before movement and after awaited movement, and real Chromium scrolling while a text field remains focused. The alternate tab stays unchanged.
- Browser/UI production and changed-test typechecks passed. UI typed lint, styles, formatting, static guards, and the keyless i18n baseline passed.
- Browser typed lint did not reach lint execution: SDK declaration preparation exceeded its 300-second deadline twice. No rules or declaration-boundary checks were weakened. This remains an incomplete check.
- The full native package build and package tarball integrity/import-graph checks passed. No full repository suite or aggregate changed-check pass is claimed.

The backend integration uses real Chromium, browser dispatch, HTTP/coordinator handling, and SQLite plugin state. Scheduler admission remains a test double; this does not prove actual Telegram continuation or a full Gateway process restart.

## Mobile presentation and gestures

The built viewer passed a smoke test using mocked scoped HTTP responses and screencast frames. Real Chromium touch events were driven through CDP emulation.

| Emulated viewport | Viewer height     | Result                                                                                |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------- |
| 390 × 844         | 709.47 CSS pixels | Blank-area swipe, pinch zoom, no trailing tap, text-field hint, and completion passed |
| 360 × 800         | 665.47 CSS pixels | Compact mobile layout captured and inspected                                          |

Six inspected synthetic captures cover browser control at both widths, task details, text entry guidance, completion, and an expired link. All six images are ready in the operator-requested Screenote review. No credentials or live account data appear in the captures.

These captures prove presentation and gesture routing against a mocked backend. They do not prove live screencast authority or native Android keyboard behavior.

## Installation

The existing installation now runs code `1fb3574551b02243d6fea0a08c308908e476c960`, build `2026.9.3-1fb3574551b0-2026-09-10T23-59-35.299Z`. The native backup was verified before installation and the previous package was retained. The same-version candidate was installed through the existing npm owner, followed by the native doctor and service start.

All 10,410 archive entries matched the installed package, apart from the expected consumed lifecycle marker. Artifact SHA-256: `58af73b769c587bc00fc42ac2e7eeecfb08f7b1766c9cb2d36323c3fad8a4902`. The served UI build identity and entry-script bytes match the installed package. Gateway health passed and Telegram is configured and running.

Shutdown reached the normal 315-second active-work drain limit with three tasks still active, then completed server shutdown cleanly. This is not proof that those tasks finished or that handoff continuation survived restart.

A fresh browser context opened a missing-credential handoff URL directly to the invalid-link message. Navigating to the Gateway root still required its normal token. No credentials were entered.

## Remaining verification

The operator will record the actual Telegram/Android flow. Valid cross-device redemption, native keyboard activation, human completion, and continuation in the original chat remain pending that recording. Telegram Test Server E2E remains unavailable without its required leased credentials and tooling.

Security-owner review of first-redeemer bearer links remains separate from this proof. Browser typed lint, live Gateway restart recovery, and real screencast revocation also remain outstanding. This report does not declare the PR merge-ready.

## Follow-up: viewport fitting and completion

Candidate `be78a14431cfdf949430ff5a50a9fec5fa35ec6f` resizes the bound browser tab to the available viewer workspace before streaming. This changes the page's real viewport so responsive content fills the available area without stretching or cropping. Opening the phone keyboard does not resize the remote page. Task details show only the handoff reason, and errors use a centered, themed presentation.

The viewer attempts to close only after a confirmed `resumed` response, which means continuation was admitted to the queue. Pending or failed admission keeps the viewer open. If closing is blocked, one brief status remains without another button.

125 focused tests passed: 80 backend and 45 UI. Real Chromium proof covers viewport changes, responsive media queries, other-tab isolation, invalid dimensions, and revoked resize authority. Browser/UI production and changed-test types, styles, formatting, static guards, and i18n checks passed; scoped independent autoreview was clean.

UI typed lint completed with one new-test Promise-executor return finding. The finding was repaired and a focused syntax-rule check passed; a repeated full typed-lint pass is not claimed. Browser typed lint again stopped before lint execution because SDK declaration preparation exceeded its 300-second deadline. No rules, declaration boundary, or timeout were weakened.

The built-viewer smoke passed with mocked HTTP/WebSocket handling and a real browser fixture resized to the requested dimensions:

| Phone viewport | Remote fixture viewport |
| -------------- | ----------------------- |
| 390 × 844      | 376 × 707 CSS pixels    |
| 360 × 800      | 346 × 663 CSS pixels    |

At 390 pixels, emulated swiping, pinch zoom without a trailing tap, mapped text-field focus, completion, and a simulated blocked `window.close` passed. Six synthetic captures were inspected, including both viewport sizes, task details, text-entry guidance, completion, and an expired link. This proves the built presentation and gesture mapping; the mocked transport does not prove live Gateway screencast authority or actual browser close permission.

The full package build and tarball integrity/import-graph checks passed. Package SHA-256: `7ee978acad0e5fe5fc19f983843684cfb4a94d66d33374b26f680cdc6c54ff4a`.

The later installation runs code `be78a14431cfdf949430ff5a50a9fec5fa35ec6f`, build `2026.9.3-be78a14431cf-2026-09-11T09-07-03.288Z`. All 10,411 package entries matched, apart from the expected consumed lifecycle marker. The served UI identity and entry-script bytes matched the installed package. Native Doctor exited successfully and normalized the cron store. Final Gateway health passed, with Telegram configured and running. The initial health probe ran before the listener opened and received a connection refusal; subsequent readiness verification passed.

A native backup was verified on the third attempt; two earlier attempts exceeded a five-second lease budget under host I/O pressure. During this installation, the previous Gateway reached its 315-second drain limit with three tasks still active, followed by a 10-second cleanup timeout. Systemd ultimately reported SIGKILL and a signal result. This was not a clean shutdown and does not prove those tasks drained or survived restart.

A fresh browser context again showed invalid-link guidance for a missing-credential handoff URL without opening a Gateway WebSocket. The Gateway root still required its normal token. Six inspected captures are ready in Screenote snapshot 35.

Native Android keyboard and closing behavior, the actual Telegram task-to-continuation recording, Telegram Test Server E2E, and the previously documented bearer-ownership and lifecycle proof gaps remain outstanding. This addendum does not declare the PR merge-ready.

## Controller claim isolation follow-up

Candidate: `7f666163`. Each control claim now has a distinct identity. Delayed input, release, renewal, or completion from an earlier claim cannot affect its replacement, even when the old request supplies the current generation. Reconnecting may require waiting for the previous controller lease to expire.

- **51 focused tests passed:** 41 Browser tests across four files and 10 UI tests in one file. Coverage includes stale input/leave/renew/complete rejection, claim namespace isolation, and retries.
- An external regression harness reproduced the defect and passed after repair using the actual UI HTTP client through the real HTTP handler, coordinator, and SQLite store. Durable HTTP regression proof changed a distinct competing claim from HTTP 200 before repair to HTTP 403 afterward. Browser dispatch and scheduler admission were test doubles. This proves the claim boundary, not real browser I/O or chat continuation.
- Releasing the old claim aborts its stream authority signal. Actual WebSocket I/O revocation remains unproven. The separate real-Chromium sibling proof passed.
- UI and Browser production typechecks, changed-test typechecks, UI type-aware lint, Browser syntax lint, six doctor guard tests, static guards, i18n, docs checks, and formatting passed. Browser type-aware lint was blocked when SDK declaration preparation exceeded 300 seconds. The aggregate changed check was interrupted while processing unrelated core dependency graphs; it did not pass. Task-owned workers and the stale task-owned lock were verified before cleanup.
- Fresh independent autoreview reported no findings at P2 or higher. A fresh native state backup completed with `verified: true`; service configuration and the previous installed package identity are retained for recovery.

**Package verification:** the full build and tarball integrity/import-graph checks passed. Artifact SHA-256: `8cfa8d23bdbb30588854e3bef0f80ee0eac8f844b869f8dca1c2fe7a05cc9f1d`. Packaged build: `2026.9.3-7f666163ac82-2026-09-11T13-49-21.465Z`.

**Installation and post-update health:** Installed and verified on September 13. A fresh native state backup passed verification (3,098,534,621 bytes) after the Gateway was stopped; two earlier attempts while it was running failed with the legacy audit migration lease timeout. The stop reached systemd’s timeout after last reporting three active tasks and was not a clean drain. npm installation and `openclaw doctor --fix --non-interactive --no-workspace-suggestions` both exited successfully. All 10,410 packaged files matched the installation, apart from the expected consumed lifecycle marker. The installed build is `2026.9.3-7f666163ac82-2026-09-11T13-49-21.465Z`. The served HTML carries the installed UI build identity, and the served entry-script bytes match the installed package. Final HTTP and CLI health checks passed; the Gateway is active and Telegram is configured and running. In a fresh browser, a missing-credential handoff shows the invalid-link state without a Gateway WebSocket, and opening the Gateway root in that same context still requires its normal token with an empty token field. These checks do not establish native Android behavior or end-to-end chat continuation.

Appearance is unchanged, so this follow-up does not add screenshots. Existing Android, Telegram continuation, full Gateway restart, and security-owner review gaps remain as recorded above.
