# Temporary audio input ownership proof

This payload is temporary PR evidence, not a supported product command. Run it
only through the `Audio input CFString ownership proof` step in the existing
`macos-swift (tests)` GitHub-hosted job. Environment markers prevent accidental
local invocation; they are not an OS sandbox. Do not run this on an operator Mac.

The baseline is the complete original `AudioInputDeviceObserver.swift`, Git blob
`486655f758e3401e77fbd4632131401cc6badb70`. The candidate comes from the actual
checkout owner, with SHA-256
`c0e32e40a235aedcfae21d453094a81d608c748aeb021cf243d0f59bb59593d9`.
Both compile with the same driver and C boundary. No helper-only source is used.
The worker's installed SDK must document caller release for both property
selectors in `AudioHardwareBase.h`; the proof records those clauses and its hash.
No compiler, SDK, provider, or credential is installed by this payload.

Before executing, all five AudioObject/AudioUnit symbols must be undefined in
the complete owner object, defined by the stub and executable, and absent from
the executable's undefined symbols. The link map must assign them to the stub.
The stub also checks runtime symbol identity and same-executable ownership before
the first property call. Unknown selectors, enumeration, listeners, and writes
fail without HAL fallthrough.

Each selector has its own CFAllocator ledger. Identically constructed retained
and unretained controls establish the oracle; results are measured after their
Swift scopes and autoreleasepools end. Error/nil fixtures allocate no CFString.
The returned CFString is bound to its unique containing allocation, not assumed
to equal that allocation's base address. Reallocation of that block is rejected;
deallocation clears both object and block identity before freeing memory.
Cleanup consumes any leaked fixture ownership only after recording the oracle.

Each executable emits ten cases: four controls and six production-getter cases.
The baseline must exit 1 with exactly the two successful-property ownership
failures. The candidate must exit 0 with none. Ineligible controls, binding
failure, missing rows, signals, timeouts, or unjoined work are not a passing RED.
This exercises default-device getter entrypoints, not enumeration, audio
capture, observer lifecycle, permission behavior, or the full app.

The entrypoint reuses the repository's managed child supervisor: 120 seconds
per compile/link, 20 seconds per executable, five seconds to drain, disk above
3.5 GiB at launch and stop below 2 GiB. Aggregate retained evidence is capped
at 64 MiB and 96 files. Only a fresh run-specific directory inside `RUNNER_TEMP`
is used. Compiler caches and binaries are removed only after owned children join;
only the bounded evidence subdirectory is uploaded, with seven-day retention.
The receipt binds the workflow definition SHA/blob, actual checkout and PR head,
full source bytes, tools, SDK, symbols, outputs, and actual command exits.

After the archived proof is inspected and hash-bound, remove only this payload
and its two workflow steps. Preserve the proven production owner byte-for-byte.
The final head still needs the ordinary exact-head macOS CI and native landing
gates. A temporary proof run does not replace final-head CI.
