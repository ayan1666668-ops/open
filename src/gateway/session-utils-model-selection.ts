import { readSessionRuntimeOwnership } from "../agents/harness/session-runtime-ownership.js";
import type { ModelManifestNormalizationContext } from "../agents/model-ref-shared.js";
import { resolveSessionModelRefCore } from "../agents/session-model-ref.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getCommittedSessionExecutionSelection,
  isAcpExecutionSelection,
} from "../model-picker/execution-selection.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  resolveStoredModelOverrideCore,
  type StoredModelOverride,
} from "../sessions/stored-model-overrides.js";
import type {
  GatewaySessionModelSource,
  SessionListRowContext,
} from "./session-utils-contracts.js";

export function resolveSessionSelectedModelRef(
  params: {
    cfg: OpenClawConfig;
    source: GatewaySessionModelSource;
    agentId: string;
    sessionKey?: string;
    rowContext?: Pick<SessionListRowContext, "selectedModelByOverrideRef">;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): {
  provider?: string;
  model?: string;
  storedOverrideSource: StoredModelOverride["source"] | null;
} {
  const accepted = getCommittedSessionExecutionSelection(params.source.entry);
  if (accepted && isAcpExecutionSelection(accepted)) {
    return {
      model: accepted.model === "native-managed" ? undefined : accepted.model.id,
      storedOverrideSource: "session",
    };
  }
  // Ownership is session-specific; never reuse the ordinary override cache for native tuples.
  const ownership = readSessionRuntimeOwnership({
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionEntry: params.source.entry,
  });
  if (ownership?.modelRef) {
    return { ...ownership.modelRef, storedOverrideSource: null };
  }
  const cachePrefix = `${normalizeAgentId(params.agentId)}\0${params.allowPluginNormalization !== false}\0`;
  const defaultKey = `${cachePrefix}\0\0`;
  let configuredDefault = params.rowContext?.selectedModelByOverrideRef.get(defaultKey);
  if (!configuredDefault) {
    configuredDefault = resolveSessionModelRefCore(params.cfg, undefined, params.agentId, {
      allowPluginNormalization: params.allowPluginNormalization,
      manifestPlugins: params.manifestPlugins,
    });
    params.rowContext?.selectedModelByOverrideRef.set(defaultKey, configuredDefault);
  }
  const storedOverride = resolveStoredModelOverrideCore({
    // A prepared miss is authoritative; the presentation store can contain another owner's alias.
    loadSessionEntry: params.source.loadSessionEntry,
    sessionEntry: params.source.entry,
    sessionKey: params.sessionKey,
    parentSessionKey: params.source.entry?.parentSessionKey,
    defaultProvider: configuredDefault.provider,
  });
  if (!storedOverride) {
    return { ...configuredDefault, storedOverrideSource: null };
  }
  const key = `${cachePrefix}${[storedOverride.provider ?? configuredDefault.provider, storedOverride.model].join("\0")}`;
  const cached = params.rowContext?.selectedModelByOverrideRef.get(key);
  if (cached) {
    return { ...cached, storedOverrideSource: storedOverride.source };
  }
  const selected = {
    provider: storedOverride.provider ?? configuredDefault.provider,
    model: storedOverride.model,
  };
  params.rowContext?.selectedModelByOverrideRef.set(key, selected);
  return { ...selected, storedOverrideSource: storedOverride.source };
}
