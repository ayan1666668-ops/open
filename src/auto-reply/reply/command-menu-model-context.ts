import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveStoredModelOverride } from "../../sessions/stored-model-overrides.js";

/** Project argument-menu model/runtime choices from caller-owned session reads. */
export function resolveNativeCommandMenuModelContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  defaultModel: { provider: string; model: string };
  sessionEntry?: SessionEntry;
  loadSessionEntry: (sessionKey: string) => SessionEntry | undefined;
}) {
  const { sessionEntry: entry, defaultModel } = params;
  let provider: string | undefined;
  let model: string | undefined;
  if (entry?.modelOverrideSource === "auto" && normalizeOptionalString(entry.modelOverride)) {
    provider = defaultModel.provider;
    model = defaultModel.model;
  } else {
    const override = resolveStoredModelOverride({
      sessionEntry: entry,
      loadSessionEntry: params.loadSessionEntry,
      sessionKey: params.sessionKey,
      defaultProvider: defaultModel.provider,
    });
    provider = override?.model
      ? override.provider || defaultModel.provider
      : (normalizeOptionalString(entry?.providerOverride) ??
        normalizeOptionalString(entry?.modelProvider));
    model = override?.model
      ? override.model
      : (normalizeOptionalString(entry?.modelOverride) ?? normalizeOptionalString(entry?.model));
  }
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    agentRuntime: resolveEffectiveAgentRuntime({
      cfg: params.cfg,
      provider: provider ?? defaultModel.provider,
      modelId: model ?? defaultModel.model,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionEntry: entry,
    }),
  };
}
