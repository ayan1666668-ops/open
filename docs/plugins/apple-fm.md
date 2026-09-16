---
summary: "Use on-device Apple Foundation Models for lightweight OpenClaw setup on a Mac"
read_when:
  - You want to set up OpenClaw on a Mac without an API key
  - You want to use Apple Intelligence for short local tasks
title: "Apple Foundation Models"
---

The bundled Apple Foundation Models plugin runs Apple's on-device model through
the native Foundation Models framework. It is a free local option for lightweight
setup and short tasks. For full agent sessions with large instructions, many
tools, or long conversations, choose a model with a larger context window.

## Requirements

These requirements apply to the Mac running the Gateway. A Mac app connected to
a Linux or Windows Gateway does not provide this local inference route.

- A Mac with Apple silicon running macOS 27 or later.
- Apple Intelligence enabled in System Settings, with its model downloaded.
- Installed Apple Swift developer tools with the macOS 27 SDK.
- An available system model with at least 8,192 context tokens.

The plugin queries the actual model name, availability, and context window.
AFM 3 Core Advanced has been tested with an 8,192-token window. Older on-device
variants with a 4K window do not qualify for this setup option; having a Mac does
not imply that the larger variant is available.

## Set up

Run:

```bash
openclaw onboard
```

Choose **Apple Foundation Models** from the model provider list. The choice is
offered on macOS. Setup reports missing prerequisites before activation.

When selected, setup compiles the plugin's bundled Swift helper with your installed
Apple tools, then checks the native model. It does not install developer tools,
download a third-party executable, or accept license terms for you. If the tools
are missing, install Xcode or the appropriate Apple Command Line Tools and retry.
The tools must include a macOS 27 SDK.

OpenClaw's setup flow tests the selected inference route before making it active.
The model reference is `apple-fm/system`; setup records the detected model name and
context limit. No API key or provider auth profile is created.

Once the helper has been prepared, app-guided setup can discover the available
model without compiling or changing anything. To reuse it from a script:

```bash
openclaw onboard --non-interactive --auth-choice apple-fm --accept-risk
```

## Runtime behavior

Model inference runs on the Gateway's Mac; proposed tool calls go through
OpenClaw's normal execution and approval flow. The helper is started for model
requests; no HTTP server, launch agent, or separate model daemon is installed.
OpenClaw retains ownership of tool execution and its normal approval checks.

The model shares its context window across instructions, tool definitions,
conversation, tool results, and output. The provider defaults to a maximum of
1,024 output tokens per reply. A large workspace or a full agent prompt can exceed
the window even before useful conversation history accumulates.

## Troubleshooting

If Apple Intelligence is unavailable, enable it in System Settings and wait for
the model download to finish. Retry setup after changing its availability.

If the reported context window is below 8,192 tokens, choose another local or
cloud model. OpenClaw does not inflate the model's advertised limit.

If the native helper is missing after an update, rerun Apple Foundation Models
setup to compile the helper matching the installed plugin. Ordinary inference and
read-only discovery never compile code or install dependencies.

See [Model providers](/concepts/model-providers) for other inference options.
