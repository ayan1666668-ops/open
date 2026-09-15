# @openclaw/growth-attribution

Growth-marketing link and image attribution tooling. Every tracking link or
image a growth team member issues carries a signed "stamp" (grower name,
platform, timestamp) so incoming traffic/engagement can be matched back to
the person and channel that drove it.

## Setup

Set a signing secret (never commit it):

```bash
export GROWTH_ATTRIBUTION_SECRET="<random-long-string>"
```

Or set `secret` in the plugin's config block.

## CLI

```bash
# Generate a signed tracking link
openclaw growth link https://koracn.com/guides/shanghai \
  --by daniel --platform reddit --campaign autumn-launch

# Verify a link's signature (e.g. before trusting it in a backtest join)
openclaw growth verify "<url>"

# Stamp an image with name/platform/timestamp watermark
openclaw growth stamp ./post.png --by daniel --platform reddit --campaign autumn-launch

# List issued links/images for QC
openclaw growth list --by daniel --platform reddit
```

Every `link`/`stamp` call also appends a JSONL entry to the local ledger
(`<state-dir>/growth-attribution/ledger.jsonl`) so growth ops can cross-check
what was issued, by whom, and when.

## Chat command

`/growlink <name> <platform> <url> [campaign]` — same link generation, usable
from any connected channel (e.g. Telegram).

## Library

`src/attribution.ts` exports `buildTrackingLink` / `verifyTrackingLink` as
plain functions if another project (e.g. the koracn website backend) wants to
verify links itself instead of shelling out.
