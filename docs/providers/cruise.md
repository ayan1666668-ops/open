---
summary: "BytesBrains Cruise — one OpenAI-compatible endpoint with budgets and live model discovery"
title: "BytesBrains Cruise"
read_when:
  - You want OpenClaw to talk to BytesBrains Cruise
  - You need budgets, lanes, and a cost ledger in front of many model providers
---

[BytesBrains Cruise](https://bytesbrains.com/cruise) is an OpenAI-compatible gateway in front of
many model providers. OpenClaw holds only a `cru_` key; provider credentials, project budgets, and
the cost ledger stay on Cruise.

| Property        | Value                                                              |
| --------------- | ------------------------------------------------------------------ |
| Provider id     | `cruise`                                                           |
| Plugin          | community package (`@bytesbrains/openclaw-cruise-provider`)        |
| Source / recipe | [bytesbrains/openclaw-cruise](https://github.com/bytesbrains/openclaw-cruise) |
| Auth env var    | `CRUISE_API_KEY`                                                   |
| Onboarding flag | `--auth-choice cruise-api-key`                                     |
| Direct CLI flag | `--cruise-api-key <key>`                                           |
| API             | OpenAI-compatible (`openai-completions`)                           |
| Base URL        | `https://cruise.bytesbrains.net/v1` (demo: `https://cruise-demo.bytesbrains.net/v1`) |
| Default model   | `cruise/bb/agentic-coding` (a Cruise **lane**)                     |

## Install plugin

```bash
openclaw plugins install npm:@bytesbrains/openclaw-cruise-provider
# or: openclaw plugins install clawhub:@bytesbrains/openclaw-cruise-provider
# or from a git checkout: openclaw plugins install /path/to/openclaw-cruise
```

Installation applies to a running Gateway automatically; otherwise it takes effect
on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

## Getting started

1. Get a `cru_demo_` or `cru_live_` key from [bytesbrains.com/cruise](https://bytesbrains.com/cruise)
   (or your BytesBrains operator). **Never** commit the key.
2. Export it and restart:

```bash
export CRUISE_API_KEY=cru_demo_…
openclaw onboard --auth-choice cruise-api-key
# or: openclaw onboard --cruise-api-key "$CRUISE_API_KEY"
openclaw gateway restart
openclaw models list --provider cruise
```

With usable auth, the plugin requests Cruise `GET /v1/models` and projects chat models and lanes
from each row’s `x-cruise` metadata (costs, windows). Without auth it stays offline on a small
seed catalog.

For the demo host, set `models.providers.cruise.baseUrl` to
`https://cruise-demo.bytesbrains.net/v1` (HTTPS under `*.bytesbrains.net` only).

## Model ids

Use **Cruise** ids from `GET /v1/models` for your key — not upstream provider ids. Prefer a lane
(`bb/agentic-coding`, `bb/chat-assistant`, …) unless you need a pinned model.

```json5
{
  agents: {
    defaults: {
      model: { primary: "cruise/bb/agentic-coding" },
    },
  },
}
```

## Refusals

Cruise spending refusals often look like OpenAI `insufficient_quota` / HTTP 429. Branch on
`error.code` (`budget_exhausted`, `wallet_exhausted`, `measurement_stale`, …), not status alone.
See the [client README](https://github.com/bytesbrains/openclaw-cruise#when-cruise-refuses).

## Manual recipe (no plugin)

A verified OpenClaw `models.providers.cruise` fragment lives in
[`examples/openclaw.json5`](https://github.com/bytesbrains/openclaw-cruise/blob/main/examples/openclaw.json5)
in the same repository.
