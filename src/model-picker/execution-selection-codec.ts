import { isDeepStrictEqual } from "node:util";
import type { AcpSessionRuntimeOptions, SessionAcpMeta } from "@openclaw/acp-core/types";
import { resolvePersistedOverrideModelRef } from "../agents/model-selection-persisted.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  isAcpExecutionSelection,
  type AcpExecutionSelection,
  type ExecutionSelection,
} from "./execution-selection.js";

export type ExecutionSelectionCodecMetadata = {
  /** Registered identity, independent of credentials or executable availability. */
  classifyExecutor: (id: string) => "harness" | "cli" | undefined;
  defaultProvider?: string;
};

export type DecodedExecutionSelection =
  | { kind: "initialized"; selection: ExecutionSelection }
  | {
      kind: "uninitialized";
      model?: { provider?: string; id: string };
      discardAutomaticAuth?: true;
    };

export function readAcpExecutionSelection(
  meta: SessionAcpMeta | undefined,
): AcpExecutionSelection | undefined {
  if (!meta?.backend.trim() || !meta.agent.trim()) {
    return undefined;
  }
  const model = meta.runtimeOptions?.model?.trim();
  return {
    executor: { kind: "acp", backend: meta.backend, agent: meta.agent },
    model: model ? { id: model } : null,
  };
}

export function readAcpRuntimeOptions(meta: SessionAcpMeta): AcpSessionRuntimeOptions | undefined {
  const selection = readAcpExecutionSelection(meta);
  if (!meta.runtimeOptions && !selection?.model) {
    return undefined;
  }
  return { ...meta.runtimeOptions, model: selection?.model?.id };
}

export function decodeAcpExecutionSelectionStorage(
  row: { backend: string; agent: string },
  runtimeOptions: AcpSessionRuntimeOptions | undefined,
): Pick<SessionAcpMeta, "backend" | "agent" | "runtimeOptions"> {
  return { backend: row.backend, agent: row.agent, runtimeOptions };
}

export function encodeAcpExecutionSelectionStorage(meta: SessionAcpMeta): {
  backend: string;
  agent: string;
  runtime_options_json: string | null;
} {
  return {
    backend: meta.backend,
    agent: meta.agent,
    runtime_options_json: meta.runtimeOptions ? JSON.stringify(meta.runtimeOptions) : null,
  };
}

export function encodeAcpExecutionSelection(
  meta: Omit<SessionAcpMeta, "backend" | "agent">,
  selection: AcpExecutionSelection,
): SessionAcpMeta {
  const runtimeOptions = { ...meta.runtimeOptions };
  if (selection.model) {
    runtimeOptions.model = selection.model.id;
  } else {
    delete runtimeOptions.model;
  }
  return {
    ...meta,
    backend: selection.executor.backend,
    agent: selection.executor.agent,
    runtimeOptions: Object.keys(runtimeOptions).length ? runtimeOptions : undefined,
  };
}

/** Decode storage once; execution history never supplies a missing selection. */
export function decodeSessionExecutionSelection(
  entry: Partial<SessionEntry> | undefined,
  metadata: ExecutionSelectionCodecMetadata,
): DecodedExecutionSelection {
  if (!entry) {
    return { kind: "uninitialized" };
  }
  if (entry.acp) {
    const selection = readAcpExecutionSelection(entry.acp);
    return selection ? { kind: "initialized", selection } : { kind: "uninitialized" };
  }
  const fallbackOriginProvider = entry.modelOverrideFallbackOriginProvider?.trim();
  const fallbackOriginModel = entry.modelOverrideFallbackOriginModel?.trim();
  const hasFallbackOrigin = Boolean(fallbackOriginProvider && fallbackOriginModel);
  const restoreFallbackOrigin = hasFallbackOrigin && entry.modelOverrideSource !== "user";
  const provider = restoreFallbackOrigin ? fallbackOriginProvider : entry.providerOverride?.trim();
  const id = restoreFallbackOrigin ? fallbackOriginModel : entry.modelOverride?.trim();
  if (!id || entry.modelOverrideSource === "default") {
    return { kind: "uninitialized" };
  }
  const resolved = restoreFallbackOrigin || entry.modelOverrideRouteResolution === "resolved";
  const ref =
    provider || metadata.defaultProvider
      ? resolvePersistedOverrideModelRef({
          defaultProvider: metadata.defaultProvider,
          overrideProvider: provider,
          overrideModel: id,
          routeResolution: resolved ? "resolved" : "raw",
        })
      : null;
  const model = ref ? { provider: ref.provider, id: ref.model } : { id };
  const runtime = entry.agentRuntimeOverride?.trim();
  const kind = runtime ? metadata.classifyExecutor(runtime) : undefined;
  if (!restoreFallbackOrigin && runtime && kind && ref && provider) {
    return {
      kind: "initialized",
      selection: {
        model: { provider: ref.provider, id: ref.model },
        executor: { kind, id: runtime },
      },
    };
  }
  return {
    kind: "uninitialized",
    model,
    ...(restoreFallbackOrigin ? { discardAutomaticAuth: true as const } : {}),
  };
}

export function readSessionExecutionSelection(
  entry: Partial<SessionEntry> | undefined,
  metadata: ExecutionSelectionCodecMetadata,
): ExecutionSelection | undefined {
  const decoded = decodeSessionExecutionSelection(entry, metadata);
  return decoded.kind === "initialized" ? decoded.selection : undefined;
}

/** Only the selection owner commits this encoding inside the session transaction. */
export function encodeSessionExecutionSelection(
  entry: Partial<SessionEntry>,
  selection: ExecutionSelection,
): void {
  if (isAcpExecutionSelection(selection)) {
    if (!entry.acp) {
      throw new Error("ACP lifecycle metadata must exist before committing its selection");
    }
    entry.acp = encodeAcpExecutionSelection(entry.acp, selection);
    delete entry.providerOverride;
    delete entry.modelOverride;
    delete entry.agentRuntimeOverride;
    delete entry.modelOverrideRouteResolution;
  } else {
    if (entry.acp) {
      throw new Error("ACP lifecycle must settle before committing another executor");
    }
    entry.providerOverride = selection.model.provider;
    entry.modelOverride = selection.model.id;
    entry.agentRuntimeOverride = selection.executor.id;
    // Older readers otherwise normalize an already accepted canonical model again.
    entry.modelOverrideRouteResolution = "resolved";
  }
  delete entry.modelOverrideSource;
  delete entry.modelOverrideFallbackOriginProvider;
  delete entry.modelOverrideFallbackOriginModel;
}

export const SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS = [
  "providerOverride",
  "modelOverride",
  "agentRuntimeOverride",
  "modelOverrideSource",
  "modelOverrideRouteResolution",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
] as const satisfies ReadonlyArray<keyof SessionEntry>;

const EXECUTION_SELECTION_ROUTE_FIELDS = [
  "providerOverride",
  "modelOverride",
  "agentRuntimeOverride",
] as const;

export function executionSelectionRouteChanged(
  before: Partial<SessionEntry>,
  after: Partial<SessionEntry>,
): boolean {
  return EXECUTION_SELECTION_ROUTE_FIELDS.some(
    (field) => !isDeepStrictEqual(before[field], after[field]),
  );
}

export function copyExecutionSelectionTransaction(
  next: Partial<SessionEntry>,
  patch: Partial<SessionEntry>,
): void {
  const destination: Partial<
    Record<(typeof SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS)[number], unknown>
  > = patch;
  for (const field of SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS) {
    destination[field] = Object.hasOwn(next, field) ? next[field] : undefined;
  }
}

/** Existing command JSON projection; the accepted pair is never published as a new wire field. */
export function executionSelectionModelOverrideProjection(
  selection: ExecutionSelection | undefined,
): {
  providerOverride?: string;
  modelOverride?: string;
} {
  return selection && !isAcpExecutionSelection(selection)
    ? { providerOverride: selection.model.provider, modelOverride: selection.model.id }
    : {};
}

export function executionSelectionTransactionChanged(
  before: Partial<SessionEntry>,
  after: Partial<SessionEntry>,
): boolean {
  return SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS.some(
    (field) => !isDeepStrictEqual(before[field], after[field]),
  );
}
