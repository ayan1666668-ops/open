// Resolves persisted per-session model choices across child and parent sessions.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ModelFallbackRouteResolution } from "../agents/model-fallback.types.js";
import {
  normalizeStoredOverrideModel,
  resolvePersistedOverrideModelRef,
} from "../agents/model-selection-persisted.js";
import { resolveSessionParentSessionKey } from "../channels/plugins/session-conversation.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { PublicSessionEntry } from "../model-picker/execution-selection-projection.js";
import {
  getSessionExecutionSelection,
  isModelExecutionSelection,
} from "../model-picker/execution-selection.js";

type SessionModelView = PublicSessionEntry & Pick<SessionEntry, "executionSelection">;

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
/** Model override loaded from the current session or its parent session. */
export type StoredModelOverride = {
  provider?: string;
  model: string;
  source: "session" | "parent";
  routeResolution: ModelFallbackRouteResolution;
};

function resolveStoredOverrideFromEntry(params: {
  entry?: SessionModelView;
  defaultProvider: string;
  source: StoredModelOverride["source"];
  allowPluginNormalization?: boolean;
}): StoredModelOverride | null {
  if (params.entry?.executionSelection) {
    const resolved = resolveStoredModelOverrideCore({
      sessionEntry: { executionSelection: params.entry.executionSelection },
      defaultProvider: params.defaultProvider,
    });
    return resolved ? { ...resolved, source: params.source } : null;
  }
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
  });
  return ref
    ? {
        ...ref,
        source: params.source,
        routeResolution,
      }
    : null;
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
  loadSessionEntry?: (sessionKey: string) => SessionModelView | undefined;
  sessionEntry?: SessionModelView;
  sessionStore?: Record<string, SessionModelView>;
  sessionKey?: string;
  parentSessionKey?: string;
  defaultProvider: string;
  allowPluginNormalization?: boolean;
}): StoredModelOverride | null {
  if (params.sessionEntry?.modelOverrideSource === "default") {
    return null;
  }
  const direct = resolveStoredOverrideFromEntry({
    ...params,
    entry: params.sessionEntry,
    source: "session",
  });
  const stored = params.sessionEntry?.executionSelection;
  if (
    direct ||
    (stored && !(stored.state === "deferred" && stored.request.defaultSelection === "inherit"))
  ) {
    return direct;
  }
  const parentKey = resolveParentSessionKeyCandidate(params);
  if (!parentKey) {
    return null;
  }
  const entry = params.loadSessionEntry?.(parentKey) ?? params.sessionStore?.[parentKey];
  if (legacyViewMetadata(entry).activeFallback) {
    return null;
  }
  return resolveStoredOverrideFromEntry({ ...params, entry, source: "parent" });
}

/** Canonical session intent for core views; observed output never supplies selection. */
export function resolveStoredModelOverrideCore(params: {
  loadSessionEntry?: (sessionKey: string) => SessionEntry | undefined;
  sessionEntry?: Pick<SessionEntry, "executionSelection">;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  parentSessionKey?: string;
  defaultProvider: string;
}): StoredModelOverride | null {
  const project = (
    entry: Pick<SessionEntry, "executionSelection"> | undefined,
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
  const stored = params.sessionEntry?.executionSelection;
  if (stored && !(stored.state === "deferred" && stored.request.defaultSelection === "inherit")) {
    return project(params.sessionEntry, "session");
  }
  const parentKey = resolveParentSessionKeyCandidate(params);
  return parentKey
    ? project(params.loadSessionEntry?.(parentKey) ?? params.sessionStore?.[parentKey], "parent")
    : null;
}
