# OpenClaw docs L10N guide

Source of truth for translation is English (`docs/*.md`). Translated trees live at
`docs/<lang>/` (currently `zh-CN`, `ja-JP`), produced by `scripts/docs-i18n`.

This file documents the _register/tone_ decisions baked into the per-language
prompts in `scripts/docs-i18n/prompt.go`, so they're reviewable without reading
Go string literals. If you change a rule here, change it in `prompt.go` too —
this file is documentation, `prompt.go` is what actually runs.

## zh-CN (Simplified Chinese)

- Register: neutral technical-doc tone. Use **你/你的**, never **您/您的**.
- Product names stay in English: OpenClaw, Pi, WhatsApp, Telegram, Discord,
  iMessage, Slack, Microsoft Teams, Google Chat, Signal.
- "Gateway" → always "Gateway 网关" (not a bare transliteration).
- Keep in English: Skills, local loopback, Tailscale.
- Insert a space between Latin and CJK characters (W3C CLREQ): "Gateway 网关",
  "Skills 配置".
- Use Chinese quotes " " for prose; keep ASCII quotes inside code/CLI/keys.
- Glossary: `docs/.i18n/glossary.zh-CN.json` — preferred-term hints fed to the
  model, not deterministic find/replace.

## ja-JP (Japanese)

- Register: neutral technical-doc tone, avoid heavy honorifics (e.g. avoid
  "〜でございます").
- Same product-name and Skills/local loopback/Tailscale exceptions as zh-CN.
- Use Japanese quotes 「」 for prose.
- Do not add/remove Latin/Japanese spacing beyond what Japanese grammar
  requires (unlike zh-CN, no forced spacing rule).
- Glossary: `docs/.i18n/glossary.ja-JP.json`.

## Adding a new target language

1. Add a `prettyLanguageLabel` case in `scripts/docs-i18n/prompt.go`.
2. Add a dedicated `<lang>PromptTemplate` if the language needs specific
   register/quoting/spacing rules (don't rely on the generic template for a
   language you actually ship — the generic template has no tone guidance).
3. Document the rules here.
4. Create `docs/.i18n/glossary.<lang>.json` (copy the zh-CN file as a
   starting shape, translate `target` values).
5. Run `scripts/docs-i18n-lint <lang>` (see below) after the first full
   translation pass and after any bulk re-translation.

## Quality gate

`scripts/docs-i18n-lint` greps `docs/<lang>/**/*.md` for register violations
the prompt is supposed to prevent (e.g. "您" leaking into zh-CN output). It is
a cheap regex safety net, not a substitute for prompt quality — real drift
(wrong tone, mistranslated terms, awkward phrasing) still needs human spot
review, ideally against 2-3 docs per language per release.
