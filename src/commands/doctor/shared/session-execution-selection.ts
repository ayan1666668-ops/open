import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
} from "../../../agents/agent-runtime-id.js";
import {
  normalizeStoredOverrideModel,
  resolvePersistedOverrideModelRef,
} from "../../../agents/model-selection-persisted.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import {
  commitStoredSessionExecutionSelection,
  resolveLegacyExecutionFallbackPermission,
} from "../../../model-picker/apply-session-model-selection.js";
import type {
  LegacyExecutionRequest,
  SessionExecutionSelection,
} from "../../../model-picker/execution-selection.js";
import { sessionExecutionSelectionSchema } from "../../../model-picker/execution-selection.schema.js";
import { resolveSessionPinnedHarnessId } from "../../../sessions/agent-harness-session-key.js";

const RETIRED_SELECTION_FIELDS = [
  "providerOverride",
  "modelOverride",
  "agentRuntimeOverride",
  "modelOverrideSource",
  "modelOverrideRouteResolution",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
] as const;
const RETIRED_FALLBACK_FIELDS = [
  "prevModelOverride",
  "prevProviderOverride",
  "prevModelOverrideSource",
  "prevModelOverrideRouteResolution",
  "prevModelOverrideFallbackOriginProvider",
  "prevModelOverrideFallbackOriginModel",
] as const;

export type LegacyAcpExecutionSelection = {
  backend: string;
  agent: string;
  model?: string;
};

/** Doctor alone interprets the retired selection family. No observed output supplies intent. */
export function migrateSessionExecutionSelection(params: {
  entry: Record<string, unknown>;
  acp?: LegacyAcpExecutionSelection;
  classifyExecutor: (id: string) => "harness" | "cli" | undefined;
  defaultProvider?: string;
}): { entry: Record<string, unknown>; changed: boolean } {
  const entry = { ...params.entry };
  const legacyAcp = isRecord(entry.acp) ? entry.acp : undefined;
  const legacyOptions = isRecord(legacyAcp?.runtimeOptions) ? legacyAcp.runtimeOptions : undefined;
  const acp =
    params.acp ??
    (typeof legacyAcp?.backend === "string" && typeof legacyAcp.agent === "string"
      ? {
          backend: legacyAcp.backend,
          agent: legacyAcp.agent,
          model: normalizeOptionalString(legacyOptions?.model),
        }
      : undefined);
  let selection: SessionExecutionSelection;
  const model = normalizeOptionalString(entry.modelOverride);
  const provider = normalizeOptionalString(entry.providerOverride);
  const normalizedRuntime = normalizeOptionalAgentRuntimeId(entry.agentRuntimeOverride);
  const nativeBindingOwner = resolveSessionPinnedHarnessId(entry);
  const runtime = isDefaultAgentRuntimeId(normalizedRuntime)
    ? nativeBindingOwner
    : normalizedRuntime;
  const originProvider = normalizeOptionalString(entry.modelOverrideFallbackOriginProvider);
  const originModel = normalizeOptionalString(entry.modelOverrideFallbackOriginModel);
  const automatic =
    entry.modelOverrideSource === "auto" ||
    entry.modelOverrideSource === "default" ||
    (entry.modelOverrideSource !== "user" && Boolean(originProvider && originModel));
  const fallbackPermission = resolveLegacyExecutionFallbackPermission({
    model,
    provider,
    source: entry.modelOverrideSource,
    originProvider,
    originModel,
  });
  const request =
    automatic && originProvider && originModel
      ? { provider: originProvider, id: originModel }
      : model && entry.modelOverrideSource !== "default"
        ? { ...(provider ? { provider } : {}), id: model }
        : undefined;
  const routeResolution =
    (automatic && originProvider && originModel) ||
    entry.modelOverrideRouteResolution === "resolved"
      ? "resolved"
      : "raw";
  const normalized = normalizeStoredOverrideModel({
    providerOverride: request?.provider,
    modelOverride: request?.id,
    routeResolution,
  });
  const ref =
    request && (request.provider || params.defaultProvider)
      ? resolvePersistedOverrideModelRef({
          defaultProvider: params.defaultProvider,
          overrideProvider: normalized.providerOverride,
          overrideModel: normalized.modelOverride,
          routeResolution,
        })
      : undefined;
  const requestedModel = ref ? { provider: ref.provider, id: ref.model } : request;
  const legacyRequest: LegacyExecutionRequest | undefined =
    provider && !model && !requestedModel
      ? {
          provider,
          ...(entry.modelOverrideSource === "auto" ||
          entry.modelOverrideSource === "user" ||
          entry.modelOverrideSource === "default"
            ? { source: entry.modelOverrideSource }
            : {}),
        }
      : undefined;
  if (entry.executionSelection !== undefined) {
    // An interrupted retry must not replace a pair committed by the selection owner.
    selection = sessionExecutionSelectionSchema.parse(entry.executionSelection);
  } else {
    if (acp) {
      const previous = {
        model: acp.model ? { id: acp.model } : "native-managed",
        executor: { kind: "acp", backend: acp.backend, agent: acp.agent },
      } as const;
      selection =
        requestedModel || entry.modelOverrideSource === "default"
          ? {
              state: "deferred",
              previous,
              request: { executor: previous.executor, model: requestedModel ?? "native-managed" },
              fallbackPermission,
            }
          : { state: "accepted", selection: previous, fallbackPermission };
    } else {
      const kind = runtime ? params.classifyExecutor(runtime) : undefined;
      selection =
        runtime && kind && requestedModel?.provider && !nativeBindingOwner
          ? {
              state: "accepted",
              selection: {
                model: { provider: requestedModel.provider, id: requestedModel.id },
                executor: { kind, id: runtime },
              },
              fallbackPermission,
            }
          : {
              state: "deferred",
              request: {
                ...(requestedModel ? { model: requestedModel } : {}),
                ...(runtime ? { runtime } : {}),
              },
              fallbackPermission,
            };
    }
    if (legacyRequest) selection = { ...selection, legacyRequest };
  }
  let fallbackChanged = false;
  if (isRecord(entry.modelFallback)) {
    const fallback = { ...entry.modelFallback };
    if (fallback.previous === undefined) {
      const previous = migrateSessionExecutionSelection({
        entry: {
          modelOverride: fallback.prevModelOverride,
          providerOverride: fallback.prevProviderOverride,
          modelOverrideSource: fallback.prevModelOverrideSource,
          modelOverrideRouteResolution: fallback.prevModelOverrideRouteResolution,
          modelOverrideFallbackOriginProvider: fallback.prevModelOverrideFallbackOriginProvider,
          modelOverrideFallbackOriginModel: fallback.prevModelOverrideFallbackOriginModel,
        },
        classifyExecutor: params.classifyExecutor,
        defaultProvider: params.defaultProvider,
      });
      fallback.previous = previous.entry.executionSelection;
      fallbackChanged = true;
    } else {
      sessionExecutionSelectionSchema.parse(fallback.previous);
    }
    for (const field of RETIRED_FALLBACK_FIELDS) {
      fallbackChanged ||= Object.hasOwn(fallback, field);
      delete fallback[field];
    }
    entry.modelFallback = fallback;
  }
  const changed =
    fallbackChanged ||
    params.entry.executionSelection === undefined ||
    RETIRED_SELECTION_FIELDS.some((field) => Object.hasOwn(entry, field)) ||
    Boolean(
      legacyAcp &&
      (Object.hasOwn(legacyAcp, "backend") ||
        Object.hasOwn(legacyAcp, "agent") ||
        (legacyOptions && Object.hasOwn(legacyOptions, "model"))),
    );
  for (const field of RETIRED_SELECTION_FIELDS) delete entry[field];
  if (legacyAcp) {
    const lifecycle = { ...legacyAcp };
    delete lifecycle.backend;
    delete lifecycle.agent;
    if (legacyOptions) {
      const options = { ...legacyOptions };
      delete options.model;
      lifecycle.runtimeOptions = options;
    }
    entry.acp = lifecycle;
  }
  if (
    automatic &&
    originProvider &&
    originModel &&
    (originProvider !== provider || originModel !== model) &&
    entry.authProfileOverrideSource === "auto"
  ) {
    delete entry.authProfileOverride;
    delete entry.authProfileOverrideSource;
    delete entry.authProfileOverrideCompactionCount;
  }
  const canonical: Pick<SessionEntry, "executionSelection"> = {};
  commitStoredSessionExecutionSelection(
    canonical,
    sessionExecutionSelectionSchema.parse(selection),
  );
  return { entry: { ...entry, ...canonical }, changed };
}
