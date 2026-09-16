import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
} from "../../../agents/agent-runtime-id.js";
import { resolvePersistedOverrideModelRef } from "../../../agents/model-selection-persisted.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { commitStoredSessionExecutionSelection } from "../../../model-picker/apply-session-model-selection.js";
import type {
  ExecutionFallbackPermission,
  SessionExecutionSelection,
} from "../../../model-picker/execution-selection.js";
import { parseSessionExecutionSelection } from "../../../model-picker/execution-selection.schema.js";

const RETIRED_SELECTION_FIELDS = [
  "providerOverride",
  "modelOverride",
  "agentRuntimeOverride",
  "modelOverrideSource",
  "modelOverrideRouteResolution",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
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
  const runtime = isDefaultAgentRuntimeId(normalizedRuntime) ? undefined : normalizedRuntime;
  const originProvider = normalizeOptionalString(entry.modelOverrideFallbackOriginProvider);
  const originModel = normalizeOptionalString(entry.modelOverrideFallbackOriginModel);
  const automatic =
    entry.modelOverrideSource === "auto" ||
    entry.modelOverrideSource === "default" ||
    (entry.modelOverrideSource !== "user" && Boolean(originProvider && originModel));
  const fallbackPermission: ExecutionFallbackPermission =
    model && !automatic ? "explicit" : "configured";
  const request =
    automatic && originProvider && originModel
      ? { provider: originProvider, id: originModel }
      : model && entry.modelOverrideSource !== "default"
        ? { ...(provider ? { provider } : {}), id: model }
        : undefined;
  const ref =
    request && (request.provider || params.defaultProvider)
      ? resolvePersistedOverrideModelRef({
          defaultProvider: params.defaultProvider,
          overrideProvider: request.provider,
          overrideModel: request.id,
          routeResolution:
            (automatic && originProvider && originModel) ||
            entry.modelOverrideRouteResolution === "resolved"
              ? "resolved"
              : "raw",
        })
      : undefined;
  const requestedModel = ref ? { provider: ref.provider, id: ref.model } : request;
  if (entry.executionSelection !== undefined) {
    // An interrupted retry must not replace a pair committed by the selection owner.
    selection = parseSessionExecutionSelection(entry.executionSelection);
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
        runtime && kind && requestedModel?.provider
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
  }
  const changed =
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
  commitStoredSessionExecutionSelection(canonical, parseSessionExecutionSelection(selection));
  return { entry: { ...entry, ...canonical }, changed };
}
