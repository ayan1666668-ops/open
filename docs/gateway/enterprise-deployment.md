---
summary: "Optional notices, setup recommendations, update traffic, and diagnostics controls for managed Gateways"
read_when:
  - Deploying OpenClaw for employees or customers
  - Running multiple Gateways with a consistent quiet configuration
  - Looking for community, telemetry, update, or onboarding opt-outs
title: "Enterprise deployment controls"
---

If you operate OpenClaw Gateways for employees or customers, use this page to
choose which optional notices, recommendations, and background requests to turn
off. There is no single enterprise or quiet-mode switch: each control below has
its own scope.

Apply Gateway settings to each instance's `openclaw.json`. For separate
configurations, state directories, and ports, see [Multiple gateways](/gateway/multiple-gateways).
For different customer trust domains, see [Multi-tenant hosting](/gateway/multi-tenant-hosting).
These presentation and traffic controls do not replace authentication, tool
policy, or tenant isolation.

## Start with a quiet profile

For deployments whose operators schedule updates centrally, merge this into
the existing configuration:

```json5
{
  gateway: {
    controlUi: { communityInvite: false },
  },
  wizard: { appRecommendations: false },
  update: {
    checkOnStart: false,
    auto: { enabled: false },
  },
  telemetry: { enabled: false },
  models: {
    catalogRefresh: { enabled: false },
  },
}
```

This hides the sidebar community invitation, skips installed-app recommendations,
and stops automatic update checks and hosted model-catalog refreshes. Operators
must arrange updates themselves; model metadata and pricing stay at the values
shipped with the installed release or configured locally. Normal logs, auditing,
and diagnostics remain available.

The profile does not make OpenClaw offline. Configured providers, channels,
plugins, tools, and explicitly requested updates can still use the network.
It also leaves the menu links listed under [Not configurable today](/gateway/enterprise-deployment#not-configurable-today)
visible.

## Community, setup, and updates

Defaults below describe unset configuration. Existing deployments can have
different saved values.

| Control                             | Configuration key                              | Default | Effect when disabled                                                                                                       | Scope                                   |
| ----------------------------------- | ---------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Sidebar community invitation        | `gateway.controlUi.communityInvite`            | `true`  | Hides the Discord invitation card, including in new browser profiles.                                                      | Gateway **serving the UI**              |
| Installed-app recommendations       | `wizard.appRecommendations`                    | `true`  | Skips the macOS setup scan and recommendations; also blocks Gateway `device.apps` access. Does not hide Get the apps.      | Setup and Gateway node-command policy   |
| Automatic update checks and notices | `update.checkOnStart`                          | `true`  | Stops automatic update requests, their feature statistics, and update notices, even if automatic installation was enabled. | Gateway and automatic CLI update checks |
| Automatic installation              | `update.auto.enabled`                          | `false` | Prevents background update campaigns. Checks and available-update notices remain if `checkOnStart` is on.                  | Gateway                                 |
| Anonymous feature statistics        | `telemetry.enabled`                            | `false` | Omits optional feature statistics from update requests. The update-only request still runs if checks are enabled.          | Gateway and CLI                         |
| Hosted model-catalog refresh        | `models.catalogRefresh.enabled`                | `true`  | Stops remote model-catalog requests; uses shipped or locally configured metadata and pricing.                              | Gateway/model catalog                   |
| Link favicons                       | `gateway.controlUi.automaticallyFetchFavicons` | `true`  | Stops automatic public-site favicon fetching for Control UI links.                                                         | Gateway serving the UI                  |

The invitation setting belongs to the Gateway serving the browser assets, even
when that UI connects to a different remote Gateway. After the setting applies,
reload the page or reconnect. A browser's previous dismissal still applies if
you later re-enable invitations. See [Community invitation](/web/control-ui/settings#community-invitation).

To record a decision about feature statistics and avoid the one-time consent
question in later interactive setup, run:

```bash
openclaw telemetry off
```

This writes `telemetry.enabled: false` and `telemetry.consentedAt`, an ISO
timestamp that is unset by default. Setting only `enabled: false` does not record
a prompt response. Non-interactive setup does not ask; guided Quick Start skips
the prompt. See [Usage telemetry and update checks](/gateway/telemetry) and
[CLI setup automation](/start/wizard-cli-automation).

For detailed update behavior, including managed services and native app updates,
see [Automatic updates](/install/updating/automatic-updates). For catalog behavior
and setup recommendations, see [Runtime configuration](/gateway/config-runtime).

## Diagnostics and telemetry export

Anonymous feature statistics and operator-configured OpenTelemetry export are
separate. Disabling `telemetry.enabled` does not disable your collector.

Keep operational diagnostics enabled unless your deployment has a specific
reason to remove them. To stop OpenClaw's export pipeline while retaining local
diagnostics, set `diagnostics.otel.enabled: false` or disable the
`diagnostics-otel` plugin.

| Control                    | Configuration key                 | Default                      | Effect when disabled                                                                                                   | Scope                               |
| -------------------------- | --------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Diagnostic instrumentation | `diagnostics.enabled`             | `true`                       | Stops diagnostic sampling and recovery listeners, including the OpenClaw OTel service. Does not disable ordinary logs. | Process using this config           |
| OpenTelemetry pipeline     | `diagnostics.otel.enabled`        | `false`                      | Stops the `diagnostics-otel` service's export/listener pipeline.                                                       | Gateway or supported local CLI runs |
| OTel traces                | `diagnostics.otel.traces`         | `true` when pipeline enabled | Disables OpenClaw trace export/listeners.                                                                              | OTel service                        |
| OTel metrics               | `diagnostics.otel.metrics`        | `true` when pipeline enabled | Disables OpenClaw metric export/listeners.                                                                             | OTel service                        |
| OTel logs                  | `diagnostics.otel.logs`           | `false`                      | Disables OTel log export, including its configured stdout sink.                                                        | OTel service                        |
| OTel content capture       | `diagnostics.otel.captureContent` | `false`                      | Excludes opt-in message/tool content and log bodies from OTel output. Metadata can still be exported.                  | OTel service                        |
| Prompt-cache traces        | `diagnostics.cacheTrace.enabled`  | `false`                      | Stops optional local cache-trace artifacts, unless overridden by the environment.                                      | Embedded runs                       |
| Targeted debug flags       | `diagnostics.flags`               | `[]`                         | An empty list enables no config-selected debug flags; environment flags remain separate.                               | Process using this config           |

A preloaded OpenTelemetry SDK belongs to its host: OpenClaw's switches do not
shut down or reconfigure that SDK's providers or transport. See
[Set up OpenTelemetry export](/gateway/opentelemetry/setup),
[Observability configuration](/gateway/config-observability), and
[Diagnostics flags](/diagnostics/flags).

## Process environment controls

Set these in the actual CLI, service, or container environment. Unset variables
add no override.

| Environment setting                     | Effect                                                                                                    | Limit                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `DO_NOT_TRACK=1` or `DO_NOT_TRACK=true` | Forces anonymous feature statistics off.                                                                  | Does **not** stop update checks or OTel export.                   |
| `OPENCLAW_NO_AUTO_UPDATE=1`             | Stops automatic update checks and automatic installation.                                                 | Explicit update commands remain available.                        |
| `OTEL_SDK_DISABLED=true`                | Disables plugin-owned exporters, listeners, health routes, and stdout sinks when the plugin owns the SDK. | Does not take ownership of an externally preloaded SDK.           |
| `OPENCLAW_CACHE_TRACE=0`                | Disables cache-trace artifacts even if enabled in config.                                                 | Does not delete existing artifacts.                               |
| `OPENCLAW_DIAGNOSTICS=0`                | Disables targeted diagnostic flags from config and environment.                                           | Does not disable ordinary logs or all diagnostic instrumentation. |
| `OPENCLAW_HIDE_BANNER=1`                | Hides the normal CLI startup banner.                                                                      | Does not suppress command output, warnings, or setup prompts.     |

`OPENCLAW_TELEMETRY_ENDPOINT` selects a different update/telemetry service; it is
not an opt-out. For automated environments and request previews, see
[Usage telemetry and update checks](/gateway/telemetry).

If a deployment system owns configuration, separately consider
[`OPENCLAW_CONFIG_READONLY=1`](/cli/config#externally-managed-config). It blocks
config-writing setup, repairs, plugin changes, and mutating update flows while
runtime state remains writable. Set it in both the Gateway and CLI environments
after provisioning; it cannot be enabled through `openclaw.json` `env.vars`.
It is a configuration-ownership choice, not a way to hide UI controls.

## Browser-local choices

These preferences do not enforce a policy across Gateways or browser profiles:

| Surface                         | Control                                    | Default and scope                                                                                                   |
| ------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Community invitation            | Close the card.                            | Shown unless dismissed or disabled by the serving Gateway; dismissal is per browser origin.                         |
| Composer visitors               | **Settings → Appearance → Lobster visits** | On by default; turning it off stays in this browser.                                                                |
| Visitor sounds                  | **Settings → Appearance → Lobster sounds** | Off by default; preference stays in this browser.                                                                   |
| Available-update attention card | Dismiss the card when offered.             | Per browser and Gateway; a restart or a new target re-arms it. Warning/danger notices cannot be dismissed this way. |

See [The Lobster](/web/lobster) for visitor behavior and dismissal options.

## Not configurable today

The following surfaces have no dedicated deployment-wide hide switch while
keeping the rest of the Control UI available:

| Surface                                              | Current limit                                                                                                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Help menu and its Discord, Docs, and Changelog links | `communityInvite: false` hides the invitation card, not these menu entries or links elsewhere in the UI.                                                               |
| Get the apps and the Apps page                       | `wizard.appRecommendations: false` controls installed-app discovery, not these download and community links.                                                           |
| Product branding                                     | Agent identity, themes, accents, and environment labels are configurable; there is no complete white-label switch for OpenClaw branding and links.                     |
| Lobster preferences for every user                   | Visits and sounds have browser-local controls, not a Gateway-enforced policy.                                                                                          |
| First-run setup and welcome suggestions              | No general deployment switch hides these surfaces. Configure the model before handing the Gateway to users; welcome suggestions remain part of the new-session view.   |
| Automatic notification permission prompt             | No Gateway-wide suppression switch. The prompt depends on browser/native permission state and records its one-time attempt in that browser origin.                     |
| Update note text independently of update checks      | There is no separate switch for the operator-facing note attached to an update notice. Use `update.checkOnStart: false` to stop automatic checks and notices together. |

If a deployment does not need a dashboard at all,
`gateway.controlUi.enabled: false` disables serving the entire Control UI
(default: `true`). That is broader than hiding individual menu items; see
[Gateway configuration](/gateway/config-gateway).

## Verify each deployment

Use the same profile and process environment as the intended Gateway:

```bash
openclaw config file
openclaw config validate
openclaw config get gateway.controlUi.communityInvite
openclaw config get update.checkOnStart
openclaw config get models.catalogRefresh.enabled
openclaw telemetry show --json
```

With automatic update checks disabled, the telemetry preview reports
`"request": null`. It previews the current CLI process; it is not a history of
requests from the running Gateway or proof that all network traffic has stopped.
For a named instance, use `openclaw --profile <name> ...` consistently.

Apply changes through your normal [configuration reload](/gateway/configuration/hot-reload)
or service restart procedure, then reload the Control UI and confirm the
invitation is absent in a fresh browser profile. Environment changes require
starting a new process with the updated environment. Schedule explicit
[updates](/install/updating) as part of fleet maintenance when automatic checks
are off.
