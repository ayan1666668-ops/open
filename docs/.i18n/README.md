# OpenClaw docs i18n assets

This folder stores **generated** and **config** files for documentation translations.

## Files

- `glossary.<lang>.json` — preferred term mappings (used in prompt guidance).
- `<lang>.tm.jsonl` — translation memory (cache) keyed by workflow + model + text hash.

## Glossary format

`glossary.<lang>.json` is an array of entries:

```json
{
  "source": "troubleshooting",
  "target": "故障排除",
  "ignore_case": true,
  "whole_word": false
}
```

Fields:

- `source`: English (or source) phrase to prefer.
- `target`: preferred translation output.

## Notes

- Glossary entries are passed to the model as **prompt guidance** (no deterministic rewrites).
- The translation memory is updated by `scripts/docs-i18n`.
- Per-language tone/register rules (formality, quoting, spacing, product-name
  exceptions) are documented in [`L10N_GUIDE.md`](./L10N_GUIDE.md) — read it
  before adding a new target language or auditing an existing one.
- After a translation run, sanity-check register drift with
  `scripts/docs-i18n-lint <lang>` (e.g. `scripts/docs-i18n-lint zh-CN`).
