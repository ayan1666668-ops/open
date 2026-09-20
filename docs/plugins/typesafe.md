---
summary: "Use TypeSafe AI's Jev model for optional typed decisions"
title: "TypeSafe AI"
read_when:
  - Configuring a typed decision model
  - Using the TypeSafe evaluation tool
---

# TypeSafe AI

The official external `typesafe` plugin connects OpenClaw's optional decision
model role to TypeSafe AI's Jev models. Its models appear in the separate
**Decision** picker, never in the conversational model picker.

The adapter and decision model role were added after released OpenClaw
`2026.9.5`. Packaged installs require a host and plugin API of at least
`2026.9.6`; the installer rejects older hosts before loading the plugin.

See [Decision models](/concepts/decision-models) for the model role, available
backends, rubric examples, and provider-neutral plugin API.

The plugin is disabled by default. Installing or enabling it does not select a
decision model or schedule background work.

## Install

TypeSafe AI is packaged separately from core for publication to npm and
ClawHub. Its first publication is pending a supporting release. Once published,
install it from npm on a compatible host:

```sh
openclaw plugins install @openclaw/typesafe
```

To select ClawHub explicitly:

```sh
openclaw plugins install clawhub:@openclaw/typesafe
```

Until a supporting release is available, use a source checkout containing the
decision-provider API and `extensions/typesafe`. Build it with
`pnpm install --frozen-lockfile` and `pnpm build`, then apply the configuration
below. Source-checkout plugins use the host's co-versioned development API;
that does not make the packaged plugin compatible with OpenClaw `2026.9.5`.

## Enable and configure

Create a protected credential in Settings → Secrets, then reference it from the
plugin configuration. Merge this example into your existing configuration; keep
any other entries in `plugins.allow`.

```json5
{
  plugins: {
    allow: ["typesafe"],
    entries: {
      typesafe: {
        enabled: true,
        config: {
          apiKey: { source: "store", provider: "default", id: "TYPESAFE_API_KEY" },
        },
      },
    },
  },
  agents: {
    ownership: "explicit",
    defaults: { decisionModel: "typesafe/jev-latest" },
    entries: {
      research: { decisionModel: "typesafe/jev-1.13.0" },
    },
  },
}
```

`typesafe/jev-latest` appears as **Jev**; the pinned
`typesafe/jev-1.13.0` appears as **Jev 1.13.0**. An unset agent override inherits
`agents.defaults.decisionModel`; an empty override disables decisions for that
agent. An unset or empty global role leaves decisions off by default.

The plugin reads the host's prepared SecretRef value for each request. It does
not independently read environment credentials or cache a previous credential.
A missing or unavailable credential makes decisions unavailable. Use the normal
[secret refresh flow](/gateway/secrets) after changing a credential.

Selecting a decision model authorizes supported, otherwise-enabled consumers to
send their selected evidence to TypeSafe and incur its normal usage charges.
Consumer scheduling and publication permissions remain unchanged. Clearing the
role or explicitly disabling the plugin prevents its use by those consumers.

## Decision contract

Consumers call the provider-neutral
[decision runtime](/plugins/sdk-overview/capabilities#decision-models-contract-version-1).
The host supplies the model selected for the owning agent. The adapter translates
the supported question types:

| OpenClaw | TypeSafe | Result                                                       |
| -------- | -------- | ------------------------------------------------------------ |
| Choice   | Choice   | Reported label and probability estimates                     |
| Score    | Score    | Reported fractional zero-based rubric position and estimates |
| Boolean  | Noul     | Probability of true, preserved from 0 to 1                   |

Choice supports 2–255 alternatives; Score supports 2–10 rubric levels.
Unsupported input is rejected before transmission; the adapter does not truncate
or split a consumer's rubric. Responses must match the complete question batch,
its labels, types, and rubric bounds.

Reported probabilities can be rounded, so they may not sum exactly to one. A
reported label or Score can also differ from a calculation over those estimates.
OpenClaw preserves the returned values. Normalizing estimates or choosing their
largest value is an explicit consumer policy. Probabilities and confidence are
not demonstrated accuracy guarantees or permission to act.

The host owns concurrency, circuit health, deadlines, cancellation, and provider
lifecycle. Native decisions have a ten-second maximum; shorter consumer or
plugin timeouts still apply. The adapter shares transport and response validation
with the tool below. Requests use the fixed TypeSafe HTTPS endpoint, reject
redirects, and do not retry automatically. Consumers decide what to do with
unavailable decisions; caller cancellation must not start fallback work.

## Optional evaluation tool

The same plugin registers the optional `typesafe_evaluate` tool. Enable it through
your normal [tool policy](/tools) when an agent should make explicit evaluations.
It accepts shared `state`, a map of `questions`, and an optional vendor `model`
override. Its TypeSafe-facing question names are `choice`, `score`, and `noul`.

For this tool only, `plugins.entries.typesafe.config.model` supplies the default
vendor model, initially `jev-latest`. It does not override the native
`decisionModel` role or select a provider. Pin a model version for reproducible
tool evaluations. `timeoutMs` limits tool requests and caps native requests at
the shorter of this setting and the host's remaining deadline.

Tool availability and the decision model role are separate: an explicitly
enabled tool does not select a background model, and selecting a decision model
does not grant agents the tool. Typed answers supply evidence, not authority to
publish, send messages, or change durable state.

## Existing external installation

The official package keeps the `typesafe` plugin ID used by the prototype and
earlier development checkouts. Preserve `plugins.entries.typesafe`, its
protected credential, and agent `decisionModel` selections when switching.
Use the supported [plugin management flow](/plugins/manage-plugins) to replace
the old installation, and remove an explicit prototype path from
`plugins.load.paths` if it would override the installed package. Do not configure
two copies as independent providers. Installing the package does not delete
prototype files or credentials.
