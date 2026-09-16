// Resolves persisted per-session model choices across child and parent sessions.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ModelFallbackRouteResolution } from "../agents/model-fallback.types.js";
import type { ModelManifestNormalizationContext } from "../agents/model-ref-shared.js";
import {
  normalizeStoredOverrideModel,
  resolvePersistedOverrideModelRef,
} from "../agents/model-selection-persisted.js";
import { resolveSessionParentSessionKey } from "../channels/plugins/session-conversation.js";
import type { PublicSessionEntry } from "../model-picker/execution-selection-projection.js";
import { getSessionExecutionSelection } from "../model-picker/execution-selection.js";
import { isModelExecutionSelection } from "../model-picker/execution-selection.js";

function legacyViewMetadata(entry: PublicSessionEntry | undefined) {
  const originProvider = normalizeOptionalString(entry?.modelOverrideFallbackOriginProvider);
  const originModel = normalizeOptionalString(entry?.modelOverrideFallbackOriginModel);
  const provider = normalizeOptionalString(entry?.providerOverride);
  const model = normalizeOptionalString(entry?.modelOverride);
  const hasOrigin = Boolean((provider || model) && originProvider && originModel);
  return {
    routeResolution:
      entry?.modelOverrideRouteResolution ?? (hasOrigin ? ("resolved" as const) : ("raw" as const)),
    activeFallback:
      hasOrigin &&
      (entry?.modelOverrideSource === undefined || entry.modelOverrideSource === "auto") &&
      ((provider ?? originProvider) !== originProvider || (model ?? originModel) !== originModel),
  };
}
import type { SessionEntry } from "../config/sessions/types.js";

/** Model override loaded from the current session or its parent session. */
export type StoredModelOverride = {
  provider?: string;
  model: string;
  source: "session" | "parent";
  routeResolution: ModelFallbackRouteResolution;
};

function resolveStoredOverrideFromEntry(
  params: {
    entry?: PublicSessionEntry;
    defaultProvider: string;
    source: StoredModelOverride["source"];
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): StoredModelOverride | null {
  if (params.entry?.modelOverrideSource === "default") {
    return null;
  }
  const routeResolution = legacyViewMetadata(params.entry).routeResolution;
  const normalized = normalizeStoredOverrideModel({
    providerOverride: params.entry?.providerOverride,
    modelOverride: params.entry?.modelOverride,
    routeResolution,
  });
  const ref = resolvePersistedOverrideModelRef({
    defaultProvider: params.defaultProvider,
    overrideProvider: normalized.providerOverride,
    overrideModel: normalized.modelOverride,
    routeResolution,
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
  });
  return ref
    ? {
        ...ref,
        source: params.source,
        routeResolution,
      }
    : null;
}

/** Resolves only the current session's persisted model override. */
export function resolveDirectStoredModelOverride(
  params: {
    sessionEntry?: PublicSessionEntry;
    defaultProvider: string;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): StoredModelOverride | null {
  return resolveStoredOverrideFromEntry({
    entry: params.sessionEntry,
    defaultProvider: params.defaultProvider,
    source: "session",
    allowPluginNormalization: params.allowPluginNormalization,
    manifestPlugins: params.manifestPlugins,
  });
}

function resolveParentSessionKeyCandidate(params: {
  sessionKey?: string;
  parentSessionKey?: string;
}): string | null {
  const explicit = normalizeOptionalString(params.parentSessionKey);
  if (explicit && explicit !== params.sessionKey) {
    return explicit;
  }
  const derived = resolveSessionParentSessionKey(params.sessionKey);
  if (derived && derived !== params.sessionKey) {
    return derived;
  }
  return null;
}

/** Released SDK-only reader for public legacy views; core uses the canonical reader below. */
export function resolveStoredModelOverride(params: {
  loadSessionEntry?: (sessionKey: string) => PublicSessionEntry | undefined;
  sessionEntry?: PublicSessionEntry;
  sessionStore?: Record<string, PublicSessionEntry>;
  sessionKey?: string;
  parentSessionKey?: string;
  defaultProvider: string;
  allowPluginNormalization?: boolean;
}): StoredModelOverride | null {
  if (params.sessionEntry?.modelOverrideSource === "default") return null;
  const direct = resolveDirectStoredModelOverride(params);
  if (direct) return direct;
  const parentKey = resolveParentSessionKeyCandidate(params);
  if (!parentKey) return null;
  const entry = params.loadSessionEntry?.(parentKey) ?? params.sessionStore?.[parentKey];
  if (legacyViewMetadata(entry).activeFallback) return null;
  return resolveStoredOverrideFromEntry({ ...params, entry, source: "parent" });
}

/** Canonical session intent for core views; observed output never supplies selection. */
export function resolveStoredModelOverrideCore(params: {
  loadSessionEntry?: (sessionKey: string) => SessionEntry | undefined;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  parentSessionKey?: string;
  defaultProvider: string;
}): StoredModelOverride | null {
  const project = (
    entry: SessionEntry | undefined,
    source: StoredModelOverride["source"],
  ): StoredModelOverride | null => {
    const stored = entry?.executionSelection;
    const selected = getSessionExecutionSelection(entry);
    const model =
      selected && isModelExecutionSelection(selected)
        ? selected.model
        : stored?.state === "deferred" && stored.request.model !== "native-managed"
          ? stored.request.model
          : undefined;
    return model
      ? {
          provider: model.provider ?? params.defaultProvider,
          model: model.id,
          source,
          routeResolution: "resolved",
        }
      : null;
  };
  if (params.sessionEntry?.executionSelection) return project(params.sessionEntry, "session");
  const parentKey = resolveParentSessionKeyCandidate(params);
  return parentKey
    ? project(params.loadSessionEntry?.(parentKey) ?? params.sessionStore?.[parentKey], "parent")
    : null;
}
