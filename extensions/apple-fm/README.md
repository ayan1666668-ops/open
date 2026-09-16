# Apple Foundation Models provider

Bundled on-device Apple Intelligence inference for OpenClaw setup and short tasks.
Choose **Apple Foundation Models** during `openclaw onboard` on a Mac. No API key
or third-party model server is required.

Requires macOS 27 on Apple silicon, Apple Intelligence enabled with its model
downloaded, and installed Apple Swift tools with the macOS 27 SDK. Explicit setup
compiles the plugin's native helper locally and checks the actual system model.
Setup requires at least 8,192 context tokens; older 4K variants are not eligible.

The model reference is `apple-fm/system`. Its name and context window come from
Apple's native Foundation Models API. Use a larger model for full agent sessions.

See the [provider guide](https://docs.openclaw.ai/plugins/apple-fm).
