## Unreleased

### Fixes

- Codex: restore background memory narratives and isolated text completions on agent-scoped local runtimes with administrator-managed hooks, preserving managed hooks and existing native-account/proxy routing while keeping ordinary hooks and model tools isolated. (#151658)

### Changes

- StepFun: add `step-5-preview` (1M context, multimodal input, `low`/`medium`/`high` reasoning effort) to the `stepfun` and `stepfun-plan` catalogs and make it the default model for both surfaces. Existing configurations that pin a model keep it; new onboarding runs select `step-5-preview`.
- Messaging: allow cross-provider sends and other guarded message actions by default, including WebChat-to-Discord notifications. Existing configurations that omit `tools.message.crossContext.allowAcrossProviders` adopt the new default on upgrade; explicit `false` remains enforced globally and per agent. Set `allowAcrossProviders: false` to retain provider isolation, or both it and `allowWithinProvider: false` to restrict guarded actions to the current bound conversation. See [security guidance](https://docs.openclaw.ai/gateway/security/tool-permissions#cross-provider-messaging). (#149875)
