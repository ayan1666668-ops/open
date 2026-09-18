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
import { LEGACY_SELECTION_VIEW_FIELDS } from "../../../model-picker/execution-selection-projection.js";
import type {
  LegacyExecutionRequest,
  SessionExecutionSelection,
} from "../../../model-picker/execution-selection.js";
import {
  resolveLegacyExecutionIntent,
  sessionExecutionSelectionSchema,
} from "../../../model-picker/execution-selection.schema.js";
import { resolveSessionPinnedHarnessId } from "../../../sessions/agent-harness-session-key.js";

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
  entry: unknown;
  acp?: LegacyAcpExecutionSelection;
  classifyExecutor: (id: string) => "harness" | "cli" | undefined;
  defaultProvider?: string;
  cliRuntimeProviders?: ReadonlyMap<string, string>;
}): { entry: Record<string, unknown>; changed: boolean } {
  if (!isRecord(params.entry)) {
    throw new Error("Session entry is not an object; original selection retained.");
  }
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
  const originProvider = normalizeOptionalString(entry.modelOverrideFallbackOriginProvider);
  const originModel = normalizeOptionalString(entry.modelOverrideFallbackOriginModel);
  const {
    model: request,
    automatic,
    fallbackPermission,
  } = resolveLegacyExecutionIntent({
    model,
    provider,
    source: entry.modelOverrideSource,
    originProvider,
    originModel,
  });
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
    request && (request.provider || (routeResolution === "raw" && request.id.includes("/")))
      ? resolvePersistedOverrideModelRef({
          defaultProvider: params.defaultProvider,
          overrideProvider: normalized.providerOverride,
          overrideModel: normalized.modelOverride,
          routeResolution,
        })
      : undefined;
  let requestedModel = ref ? { provider: ref.provider, id: ref.model } : request;
  const bindings = isRecord(entry.cliSessionBindings) ? entry.cliSessionBindings : undefined;
  const cliRuntime =
    requestedModel?.provider && bindings?.[requestedModel.provider] !== undefined
      ? requestedModel.provider
      : undefined;
  const canonicalProvider = cliRuntime ? params.cliRuntimeProviders?.get(cliRuntime) : undefined;
  if (requestedModel && canonicalProvider) {
    requestedModel = { provider: canonicalProvider, id: requestedModel.id };
  }
  const runtime = isDefaultAgentRuntimeId(normalizedRuntime)
    ? (nativeBindingOwner ?? (canonicalProvider ? cliRuntime : undefined))
    : normalizedRuntime;
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
                ...(requestedModel
                  ? { model: requestedModel }
                  : {
                      defaultSelection:
                        entry.modelOverrideSource === "default"
                          ? ("configured" as const)
                          : ("inherit" as const),
                    }),
                ...(runtime ? { runtime } : {}),
              },
              fallbackPermission,
            };
    }
    if (legacyRequest) {
      selection = { ...selection, legacyRequest };
    }
  }
  let fallbackChanged = false;
  if (isRecord(entry.modelFallback)) {
    const fallback = { ...entry.modelFallback };
    if (fallback.previous === undefined) {
      const previous = migrateSessionExecutionSelection({
        entry: {
          cliSessionBindings: entry.cliSessionBindings,
          modelOverride: fallback.prevModelOverride,
          providerOverride: fallback.prevProviderOverride,
          modelOverrideSource: fallback.prevModelOverrideSource,
          modelOverrideRouteResolution: fallback.prevModelOverrideRouteResolution,
          modelOverrideFallbackOriginProvider: fallback.prevModelOverrideFallbackOriginProvider,
          modelOverrideFallbackOriginModel: fallback.prevModelOverrideFallbackOriginModel,
        },
        classifyExecutor: params.classifyExecutor,
        defaultProvider: params.defaultProvider,
        cliRuntimeProviders: params.cliRuntimeProviders,
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
    LEGACY_SELECTION_VIEW_FIELDS.some((field) => Object.hasOwn(entry, field)) ||
    Boolean(
      legacyAcp &&
      (Object.hasOwn(legacyAcp, "backend") ||
        Object.hasOwn(legacyAcp, "agent") ||
        (legacyOptions && Object.hasOwn(legacyOptions, "model"))),
    );
  for (const field of LEGACY_SELECTION_VIEW_FIELDS) {
    delete entry[field];
  }
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
  entry.executionSelection = sessionExecutionSelectionSchema.parse(selection);
  return { entry, changed };
}
