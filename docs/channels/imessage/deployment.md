---
summary: "Dedicated bot macOS user, remote Mac over Tailscale, multi-account, and DM history patterns"
read_when:
  - Choosing where to run the Gateway and imsg
  - Isolating bot traffic from a personal iMessage identity
  - Running more than one iMessage account
title: "iMessage deployment patterns"
sidebarTitle: "Deployment patterns"
---

Topologies for running `imsg` next to a signed-in Messages account, and the config each one needs.

## Deployment patterns

<AccordionGroup>
  <Accordion title="Dedicated bot macOS user (separate iMessage identity)">
    Use a dedicated Apple ID and macOS user so bot traffic is isolated from your personal Messages profile.

    Typical flow:

    1. Create/sign in a dedicated macOS user.
    2. Sign into Messages with the bot Apple ID in that user.
    3. Install `imsg` in that user.
    4. Create an SSH wrapper so OpenClaw can run `imsg` in that user context.
    5. Point `channels.imessage.accounts.<id>.cliPath` and `.dbPath` to that user profile.

    First run may require GUI approvals (Automation + Full Disk Access) in that bot user session.

  </Accordion>

  <Accordion title="No spare phone number? Scope one Mac to an email alias">
    Apple only issues a new Apple Account against a phone number that is not already on one, so a dedicated bot Apple ID is not available to everyone. This pattern reaches the same isolation from the Apple Account you already have: the bot Mac stays registered for one email alias and nothing else.

    1. At [appleid.apple.com](https://appleid.apple.com), add an extra email address under **Reachable At** and verify it.
    2. On the bot Mac, open **Messages > Settings > iMessage**. Under **You can be reached for messages at**, uncheck the phone number and every other address so only the new alias stays checked. That list is per device, so your iPhone keeps receiving everything.
    3. On the same Mac, turn off **Enable Messages in iCloud**. Those checkboxes control delivery only; iCloud sync ignores them and pulls your whole message history down anyway.
    4. If that Mac already synced history, turning sync off does not remove the local copy. Sign out of Messages, quit it, delete `~/Library/Messages/`, then sign back in. Otherwise `chat.db` still holds your personal threads, and `chat.db` is the file the bot reads.

    Message the alias from your phone to open the bot thread. Messages you send to your own phone number never register on that Mac, so they never reach its `chat.db`. The isolation comes from device registration rather than from a separate account.

    An iPhone does not let you deselect its own phone number, so this pattern works on a Mac only.

  </Accordion>

  <Accordion title="Remote Mac over Tailscale (example)">
    Common topology:

    - gateway runs on Linux/VM
    - iMessage + `imsg` runs on a Mac in your tailnet
    - `cliPath` wrapper uses SSH to run `imsg`
    - `remoteHost` enables inbound fetches and owner-only outbound staging over SSH/SCP

    Example:

    ```json5
    {
      channels: {
        imessage: {
          enabled: true,
          cliPath: "/home/openclaw/.openclaw/scripts/imsg-ssh",
          remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
          includeAttachments: true,
          dbPath: "/Users/bot/Library/Messages/chat.db",
        },
      },
    }
    ```

    ```bash
    #!/usr/bin/env bash
    exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
    ```

    `cliPath` is an absolute, Gateway-local wrapper path. `remoteHost` and `dbPath` refer to the Messages Mac; do not rewrite the remote database path using the Gateway user's home directory.

    Use SSH keys so both SSH and SCP are non-interactive.
    Ensure the host key is trusted first (for example `ssh bot@mac-mini.tailnet-1234.ts.net`) so `known_hosts` is populated.

  </Accordion>

  <Accordion title="Multi-account pattern">
    iMessage supports per-account config under `channels.imessage.accounts`.

    Each account can override fields such as `cliPath`, `dbPath`, `allowFrom`, `dmPolicy`, `groupPolicy`, `mediaMaxMb`, history settings, and attachment root allowlists. Omitted account policies inherit the channel root; explicit account policies win. If neither scope sets them, DMs use `pairing` and groups use `allowlist`.

  </Accordion>

  <Accordion title="Direct-message history">
    Set `channels.imessage.dmHistoryLimit` to seed new direct-message sessions with recent decoded `imsg` history for that conversation. Use `channels.imessage.dms["<sender>"].historyLimit` for per-sender overrides, including `0` to disable history for a sender.

    iMessage DM history is fetched on demand from `imsg`. Leaving `dmHistoryLimit` unset disables global DM history seeding, but a positive per-sender `channels.imessage.dms["<sender>"].historyLimit` still enables seeding for that sender.

  </Accordion>
</AccordionGroup>
