# TypeSafe AI for OpenClaw

Official external plugin for typed decisions with TypeSafe AI's Jev models.
It provides Choice, Score, and Boolean judgments through OpenClaw's shared
decision-model API, plus the optional `typesafe_evaluate` tool.

Requires OpenClaw and plugin API **2026.9.6 or later**. Released OpenClaw
2026.9.5 does not include the decision API.

```sh
openclaw plugins install @openclaw/typesafe
```

The ClawHub install spec is `clawhub:@openclaw/typesafe`. First publication is
pending a supporting release. Enable the plugin, configure a protected TypeSafe credential, and select
`typesafe/jev-latest` as your agent's `decisionModel`. Evaluations send the
supplied evidence to TypeSafe AI and incur its normal usage charges.

See the [TypeSafe AI setup guide](https://docs.openclaw.ai/plugins/typesafe) and
[decision-model documentation](https://docs.openclaw.ai/concepts/decision-models)
for configuration, rubrics, and API semantics.
