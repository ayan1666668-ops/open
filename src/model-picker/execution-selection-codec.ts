import { isDeepStrictEqual } from "node:util";
import type { AcpSessionRuntimeOptions, SessionAcpMeta } from "@openclaw/acp-core/types";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolvePersistedOverrideModelRef } from "../agents/model-selection-persisted.js";
import type { AgentPatchedSessionModelFallback } from "../config/sessions/session-model-fallback.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  isAcpExecutionSelection,
  type AcpExecutionSelection,
  type ExecutionSelection,
  type ModelExecutionSelection,
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
      executor?: ExecutionSelection["executor"];
      discardAutomaticAuth?: true;
    };

export function readAcpExecutionSelection(
  meta: SessionAcpMeta | undefined,
): AcpExecutionSelection | undefined {
  const backend = normalizeOptionalString(meta?.backend);
  const agent = normalizeOptionalString(meta?.agent);
  if (!meta || !backend || !agent) {
    return undefined;
  }
  const model = normalizeOptionalString(meta?.runtimeOptions?.model);
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
  const acpSelection = readAcpExecutionSelection(entry.acp);
  if (
    entry.acp &&
    !normalizeOptionalString(entry.modelOverride) &&
    entry.modelOverrideSource !== "default"
  ) {
    return acpSelection
      ? { kind: "initialized", selection: acpSelection }
      : { kind: "uninitialized" };
  }
  const runtime = normalizeOptionalString(entry.agentRuntimeOverride);
  const kind = runtime ? metadata.classifyExecutor(runtime) : undefined;
  const executor: ExecutionSelection["executor"] | undefined = entry.acp
    ? acpSelection?.executor
    : runtime && kind
      ? { kind, id: runtime }
      : undefined;
  const fallbackOriginProvider = normalizeOptionalString(entry.modelOverrideFallbackOriginProvider);
  const fallbackOriginModel = normalizeOptionalString(entry.modelOverrideFallbackOriginModel);
  const hasFallbackOrigin = Boolean(fallbackOriginProvider && fallbackOriginModel);
  const restoreFallbackOrigin =
    hasFallbackOrigin &&
    entry.modelOverrideSource !== "user" &&
    (fallbackOriginProvider !== normalizeOptionalString(entry.providerOverride) ||
      fallbackOriginModel !== normalizeOptionalString(entry.modelOverride));
  const provider = restoreFallbackOrigin
    ? fallbackOriginProvider
    : normalizeOptionalString(entry.providerOverride);
  const id = restoreFallbackOrigin
    ? fallbackOriginModel
    : normalizeOptionalString(entry.modelOverride);
  if (!id || entry.modelOverrideSource === "default") {
    return { kind: "uninitialized", ...(executor ? { executor } : {}) };
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
  const acceptedEncoding =
    entry.modelOverrideRouteResolution === "resolved" &&
    (entry.modelOverrideSource === "user" ||
      (entry.modelOverrideSource === "auto" && hasFallbackOrigin));
  if (
    acceptedEncoding &&
    !restoreFallbackOrigin &&
    executor &&
    executor.kind !== "acp" &&
    ref &&
    provider
  ) {
    return {
      kind: "initialized",
      selection: {
        model: { provider: ref.provider, id: ref.model },
        executor,
      },
    };
  }
  return {
    kind: "uninitialized",
    model,
    ...(executor ? { executor } : {}),
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

export type ExecutionSelectionCommitCause =
  | { kind: "initialize" | "reset" | "user" }
  | { kind: "inherit"; entry: Partial<SessionEntry> }
  | { kind: "rollback"; fallback: AgentPatchedSessionModelFallback };

function hasStrictModelSelection(entry: Partial<SessionEntry> | undefined): boolean {
  if (!normalizeOptionalString(entry?.modelOverride)) {
    return false;
  }
  if (entry.modelOverrideSource === "user") {
    return true;
  }
  if (entry.modelOverrideSource === "auto" || entry.modelOverrideSource === "default") {
    return false;
  }
  return !(
    normalizeOptionalString(entry.modelOverrideFallbackOriginProvider) &&
    normalizeOptionalString(entry.modelOverrideFallbackOriginModel)
  );
}

type FallbackAdmissionRejection = {
  status: "rejected";
  reason: "model-selection-locked" | "user-model-selection" | "not-authorized";
};

type FallbackAdmissionParams = {
  entry: Partial<SessionEntry> | undefined;
  metadata: ExecutionSelectionCodecMetadata;
  explicitModels?: readonly ModelExecutionSelection["model"][];
};

/** Ladder admission preserves the difference between configured and explicit selections. */
export function admitSessionExecutionFallbacks(
  params: FallbackAdmissionParams & { candidates: readonly ModelExecutionSelection[] },
):
  | { status: "admitted"; selections: readonly ModelExecutionSelection[] }
  | FallbackAdmissionRejection {
  const accepted = readSessionExecutionSelection(params.entry, params.metadata);
  if (params.entry?.modelSelectionLocked || (accepted && isAcpExecutionSelection(accepted))) {
    return { status: "rejected", reason: "model-selection-locked" };
  }
  if (params.explicitModels !== undefined) {
    return params.candidates.every((candidate) =>
      params.explicitModels?.some((model) => isDeepStrictEqual(model, candidate.model)),
    )
      ? { status: "admitted", selections: params.candidates }
      : { status: "rejected", reason: "not-authorized" };
  }
  return hasStrictModelSelection(params.entry)
    ? { status: "rejected", reason: "user-model-selection" }
    : { status: "admitted", selections: params.candidates };
}

/** The primary attempt remains runnable even when its session forbids a fallback ladder. */
export function admitSessionExecutionFallback(
  params: FallbackAdmissionParams & { candidate: ModelExecutionSelection },
): { status: "admitted"; selection: ModelExecutionSelection } | FallbackAdmissionRejection {
  const accepted = readSessionExecutionSelection(params.entry, params.metadata);
  if (isDeepStrictEqual(accepted, params.candidate)) {
    return { status: "admitted", selection: params.candidate };
  }
  const admission = admitSessionExecutionFallbacks({ ...params, candidates: [params.candidate] });
  return admission.status === "rejected"
    ? admission
    : { status: "admitted", selection: params.candidate };
}

/** Only the selection owner commits this encoding inside the session transaction. */
export function encodeSessionExecutionSelection(
  entry: Partial<SessionEntry>,
  selection: ExecutionSelection,
  cause: ExecutionSelectionCommitCause,
): void {
  const strict =
    cause.kind === "user" ||
    (cause.kind === "initialize" && hasStrictModelSelection(entry)) ||
    (cause.kind === "inherit" && hasStrictModelSelection(cause.entry)) ||
    (cause.kind === "rollback" &&
      hasStrictModelSelection({
        modelOverride: cause.fallback.prevModelOverride,
        modelOverrideSource: cause.fallback.prevModelOverrideSource,
        modelOverrideFallbackOriginProvider: cause.fallback.prevModelOverrideFallbackOriginProvider,
        modelOverrideFallbackOriginModel: cause.fallback.prevModelOverrideFallbackOriginModel,
      }));
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
  if (isAcpExecutionSelection(selection)) {
    delete entry.modelOverrideSource;
    delete entry.modelOverrideFallbackOriginProvider;
    delete entry.modelOverrideFallbackOriginModel;
  } else if (strict) {
    entry.modelOverrideSource = "user";
    delete entry.modelOverrideFallbackOriginProvider;
    delete entry.modelOverrideFallbackOriginModel;
  } else {
    entry.modelOverrideSource = "auto";
    entry.modelOverrideFallbackOriginProvider = selection.model.provider;
    entry.modelOverrideFallbackOriginModel = selection.model.id;
  }
}

const SESSION_EXECUTION_SELECTION_FIELDS = [
  "providerOverride",
  "modelOverride",
  "agentRuntimeOverride",
  "modelOverrideSource",
  "modelOverrideRouteResolution",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
] as const satisfies ReadonlyArray<keyof SessionEntry>;

export const SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS = [
  ...SESSION_EXECUTION_SELECTION_FIELDS,
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
] as const satisfies ReadonlyArray<keyof SessionEntry>;

/** Clear a legacy request only after its ACP pair committed and its captured input still matches. */
export function consumeLegacySessionExecutionSeed(
  entry: Partial<SessionEntry>,
  expected: Partial<SessionEntry>,
): boolean {
  if (
    entry.sessionId !== expected.sessionId ||
    entry.lifecycleRevision !== expected.lifecycleRevision ||
    executionSelectionTransactionChanged(entry, expected)
  ) {
    return false;
  }
  let changed = false;
  for (const field of SESSION_EXECUTION_SELECTION_FIELDS) {
    if (Object.hasOwn(entry, field)) {
      delete entry[field];
      changed = true;
    }
  }
  return changed;
}

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

/** Existing Gateway wire metadata; this projection does not grant execution authority. */
export function executionSelectionWireSourceProjection(entry: Partial<SessionEntry> | undefined): {
  modelOverrideSource: "auto" | "user" | null;
} {
  return {
    modelOverrideSource:
      !normalizeOptionalString(entry?.modelOverride) || entry.modelOverrideSource === "default"
        ? null
        : hasStrictModelSelection(entry)
          ? "user"
          : "auto",
  };
}

function clearLegacyFallbackOrigin(entry: SessionEntry): boolean {
  let updated = false;
  if (entry.modelOverrideFallbackOriginProvider !== undefined) {
    delete entry.modelOverrideFallbackOriginProvider;
    updated = true;
  }
  if (entry.modelOverrideFallbackOriginModel !== undefined) {
    delete entry.modelOverrideFallbackOriginModel;
    updated = true;
  }
  return updated;
}

/** Existing synchronous SDK encoding; only a later prepared turn can accept its executor. */
export function encodeLegacySessionModelSelection(params: {
  entry: SessionEntry;
  selection: { provider: string; model: string; isDefault?: boolean };
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
  preserveAuthProfileOverride?: boolean;
  selectionSource?: "auto" | "user";
  explicitDefaultSelection?: boolean;
  markLiveSwitchPending?: boolean;
}): { updated: boolean } {
  const { entry, selection, profileOverride } = params;
  const profileOverrideSource = params.profileOverrideSource ?? "user";
  const selectionSource = params.selectionSource ?? "user";
  let updated = false;
  let selectionUpdated = false;
  let profileUpdated = false;

  if (selection.isDefault) {
    if (params.explicitDefaultSelection && entry.modelOverrideSource !== "default") {
      entry.modelOverrideSource = "default";
      updated = true;
      selectionUpdated = true;
    } else if (!params.explicitDefaultSelection && entry.modelOverrideSource !== undefined) {
      delete entry.modelOverrideSource;
      updated = true;
      selectionUpdated = true;
    }
    if (entry.providerOverride) {
      delete entry.providerOverride;
      updated = true;
      selectionUpdated = true;
    }
    if (entry.modelOverride) {
      delete entry.modelOverride;
      updated = true;
      selectionUpdated = true;
    }
    if (entry.modelOverrideRouteResolution) {
      delete entry.modelOverrideRouteResolution;
      updated = true;
    }
    updated = clearLegacyFallbackOrigin(entry) || updated;
  } else {
    if (entry.providerOverride !== selection.provider) {
      entry.providerOverride = selection.provider;
      updated = true;
      selectionUpdated = true;
    }
    if (entry.modelOverride !== selection.model) {
      entry.modelOverride = selection.model;
      updated = true;
      selectionUpdated = true;
    }
    if (selectionSource === "auto") {
      if (entry.modelOverrideSource !== "auto") {
        entry.modelOverrideSource = "auto";
        updated = true;
      }
    } else if (entry.modelOverrideSource !== undefined) {
      // Absent source already means a user choice to released readers.
      delete entry.modelOverrideSource;
      updated = true;
    }
    if (entry.modelOverrideRouteResolution !== "resolved") {
      entry.modelOverrideRouteResolution = "resolved";
      updated = true;
    }
    updated = clearLegacyFallbackOrigin(entry) || updated;
  }

  // Model overrides supersede previously recorded runtime model identity.
  // If runtime fields are stale (or the override changed), clear them so status
  // surfaces reflect the selected model immediately.
  const runtimeModel = normalizeOptionalString(entry.model) ?? "";
  const runtimeProvider = normalizeOptionalString(entry.modelProvider) ?? "";
  const runtimePresent = runtimeModel.length > 0 || runtimeProvider.length > 0;
  const runtimeAligned =
    runtimeModel === selection.model &&
    (runtimeProvider.length === 0 || runtimeProvider === selection.provider);
  if (runtimePresent && (selectionUpdated || !runtimeAligned)) {
    if (entry.model !== undefined) {
      delete entry.model;
      updated = true;
    }
    if (entry.modelProvider !== undefined) {
      delete entry.modelProvider;
      updated = true;
    }
  }

  // When switching back to the default model without override fields to delete
  // (e.g. model comes from steering/fallback runtime fields), the isDefault
  // branch will not set selectionUpdated. Mark it here so that
  // liveModelSwitchPending can still be set below when runtime is misaligned.
  if (selection.isDefault && runtimePresent && !runtimeAligned) {
    selectionUpdated = true;
  }

  // contextTokens are derived from the active session model. When the selected
  // model changes (or runtime model is already stale), the cached window can
  // pin the session to an older/smaller limit until another run refreshes it.
  const shouldClearModelDerivedState = selectionUpdated || (runtimePresent && !runtimeAligned);
  if (shouldClearModelDerivedState) {
    if (entry.contextTokens !== undefined) {
      delete entry.contextTokens;
      updated = true;
    }
    if (entry.contextTokensSource !== undefined) {
      delete entry.contextTokensSource;
      updated = true;
    }
    if (entry.contextBudgetStatus !== undefined) {
      delete entry.contextBudgetStatus;
      updated = true;
    }
  }

  if (profileOverride) {
    if (entry.authProfileOverride !== profileOverride) {
      entry.authProfileOverride = profileOverride;
      updated = true;
      profileUpdated = true;
    }
    if (entry.authProfileOverrideSource !== profileOverrideSource) {
      entry.authProfileOverrideSource = profileOverrideSource;
      updated = true;
      profileUpdated = true;
    }
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      delete entry.authProfileOverrideCompactionCount;
      updated = true;
    }
  } else if (!params.preserveAuthProfileOverride) {
    if (entry.authProfileOverride) {
      delete entry.authProfileOverride;
      updated = true;
      profileUpdated = true;
    }
    if (entry.authProfileOverrideSource) {
      delete entry.authProfileOverrideSource;
      updated = true;
      profileUpdated = true;
    }
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      delete entry.authProfileOverrideCompactionCount;
      updated = true;
    }
  }

  // Clear stale fallback notice when the user explicitly switches models.
  if (updated) {
    if ((selectionUpdated || profileUpdated) && params.markLiveSwitchPending) {
      // Pending without modelOverride is the deliberate encoding for "switch
      // back to the agent default": the default branch above also clears the
      // runtime model fields so live-switch resolution lands on the default.
      entry.liveModelSwitchPending = true;
    }
    delete entry.fallbackNotice;
    entry.updatedAt = Date.now();
  }

  return { updated };
}

export function captureSessionModelFallback(params: {
  model: string;
  provider: string;
  entry: {
    modelOverride?: string;
    providerOverride?: string;
    modelOverrideSource?: "auto" | "user" | "default";
    modelOverrideRouteResolution?: "resolved";
    modelOverrideFallbackOriginProvider?: string;
    modelOverrideFallbackOriginModel?: string;
    authProfileOverride?: string;
    authProfileOverrideSource?: "auto" | "user" | "user-link";
    authProfileOverrideCompactionCount?: number;
    contextWindow?: string;
    thinkingLevel?: string;
  };
  ts: number;
}): AgentPatchedSessionModelFallback {
  const { entry } = params;
  return {
    prevModel: params.model,
    prevProvider: params.provider,
    ...(entry.modelOverride ? { prevModelOverride: entry.modelOverride } : {}),
    ...(entry.providerOverride ? { prevProviderOverride: entry.providerOverride } : {}),
    ...(entry.modelOverrideSource ? { prevModelOverrideSource: entry.modelOverrideSource } : {}),
    ...(entry.modelOverrideRouteResolution
      ? { prevModelOverrideRouteResolution: entry.modelOverrideRouteResolution }
      : {}),
    ...(entry.modelOverrideFallbackOriginProvider
      ? { prevModelOverrideFallbackOriginProvider: entry.modelOverrideFallbackOriginProvider }
      : {}),
    ...(entry.modelOverrideFallbackOriginModel
      ? { prevModelOverrideFallbackOriginModel: entry.modelOverrideFallbackOriginModel }
      : {}),
    ...(entry.authProfileOverride ? { prevAuthProfileOverride: entry.authProfileOverride } : {}),
    ...(entry.authProfileOverrideSource
      ? { prevAuthProfileOverrideSource: entry.authProfileOverrideSource }
      : {}),
    ...(entry.authProfileOverrideCompactionCount !== undefined
      ? { prevAuthProfileOverrideCompactionCount: entry.authProfileOverrideCompactionCount }
      : {}),
    ...(entry.contextWindow ? { prevContextWindow: entry.contextWindow } : {}),
    ...(entry.thinkingLevel ? { prevThinkingLevel: entry.thinkingLevel } : {}),
    ts: params.ts,
    source: "agent-patch",
  };
}

/** Raw model identity is exposed only to existing canonical repair planning. */
export function readSessionExecutionRepairModel(
  entry: Partial<SessionEntry>,
): { provider?: string; id: string } | undefined {
  const id = normalizeOptionalString(entry.modelOverride);
  const provider = normalizeOptionalString(entry.providerOverride);
  return id ? { id, ...(provider ? { provider } : {}) } : undefined;
}

/** Existing runtime pins outrank repair defaults; only declared alias migrations may rename them. */
export function resolveSessionExecutionRepairPair(params: {
  entry: Partial<SessionEntry>;
  model: ModelExecutionSelection["model"];
  executor?: ModelExecutionSelection["executor"];
  metadata: ExecutionSelectionCodecMetadata;
  runtimeMigration?: (id: string) => ModelExecutionSelection["executor"] | undefined;
}): ModelExecutionSelection | undefined {
  if (params.entry.acp) {
    return undefined;
  }
  const runtime = normalizeOptionalString(params.entry.agentRuntimeOverride);
  if (runtime && runtime !== "auto") {
    const migrated = params.runtimeMigration?.(runtime);
    const kind = params.metadata.classifyExecutor(runtime);
    const executor =
      migrated ??
      (kind
        ? { kind, id: runtime }
        : params.executor?.id === runtime
          ? params.executor
          : undefined);
    return executor ? { model: params.model, executor } : undefined;
  }
  return params.executor ? { model: params.model, executor: params.executor } : undefined;
}

export function readSessionExecutionRepairRef(entry: Partial<SessionEntry>): {
  provider?: string;
  model?: string;
  runtime?: string;
} {
  return {
    provider: normalizeOptionalString(entry.providerOverride),
    model: normalizeOptionalString(entry.modelOverride),
    runtime: normalizeOptionalString(entry.agentRuntimeOverride),
  };
}

/** Only the existing automatic, providerless legacy shape permits this canonical repair. */
export function admitAutomaticProviderlessModelRepair(
  entry: Partial<SessionEntry>,
): string | undefined {
  return entry.modelOverrideSource === "auto" && !normalizeOptionalString(entry.providerOverride)
    ? normalizeOptionalString(entry.modelOverride)
    : undefined;
}

function hasAcceptedExecutionEncoding(entry: Partial<SessionEntry>): boolean {
  const model = readSessionExecutionRepairModel(entry);
  return Boolean(
    model?.provider &&
    normalizeOptionalString(entry.agentRuntimeOverride) &&
    entry.modelOverrideRouteResolution === "resolved" &&
    (entry.modelOverrideSource === "user" ||
      (entry.modelOverrideSource === "auto" &&
        normalizeOptionalString(entry.modelOverrideFallbackOriginProvider) === model.provider &&
        normalizeOptionalString(entry.modelOverrideFallbackOriginModel) === model.id)),
  );
}

/** Existing plugin cleanup may remove legacy automatic state, never an accepted choice or pin. */
export function inspectLegacySessionRouteCleanup(params: {
  entry: Partial<SessionEntry>;
  providerIds: ReadonlySet<string>;
  runtimeIds: ReadonlySet<string>;
  configuredModels: readonly string[];
  routeAllowsOwner: boolean;
  routeAllowsRuntime: boolean;
  defaultProvider: string;
}):
  | { kind: "retain" | "history" }
  | { kind: "manual"; detail: string }
  | { kind: "reset-model"; model: { provider?: string; id: string } } {
  if (hasAcceptedExecutionEncoding(params.entry) || params.entry.acp) {
    return { kind: "retain" };
  }
  const model = readSessionExecutionRepairModel(params.entry);
  const ref = model
    ? resolvePersistedOverrideModelRef({
        defaultProvider: params.defaultProvider,
        overrideProvider: model.provider,
        overrideModel: model.id,
        routeResolution: params.entry.modelOverrideRouteResolution ?? "raw",
        allowPluginNormalization: false,
        allowManifestNormalization: false,
      })
    : null;
  const owned = ref && params.providerIds.has(ref.provider.toLowerCase());
  const key = ref ? `${ref.provider}/${ref.model}`.toLowerCase() : undefined;
  if (owned && params.entry.modelOverrideSource !== "auto") {
    return !params.routeAllowsOwner
      ? {
          kind: "manual",
          detail: `${key}, ${params.entry.modelOverrideSource === "user" ? "user" : "legacy"}`,
        }
      : { kind: "retain" };
  }
  if (
    owned &&
    model &&
    key &&
    !params.configuredModels.some((value) => value.toLowerCase() === key)
  ) {
    return { kind: "reset-model", model };
  }
  const runtime = normalizeOptionalString(params.entry.agentRuntimeOverride);
  if (runtime && params.runtimeIds.has(runtime.toLowerCase()) && !params.routeAllowsRuntime) {
    return { kind: "manual", detail: `${runtime}, runtime pin retained` };
  }
  return { kind: "history" };
}

/** Revalidate legacy source and identity after confirmation before applying the prepared reset. */
export function applyLegacySessionModelCleanup(params: {
  entry: Partial<SessionEntry>;
  expectedModel: { provider?: string; id: string };
  expectedRuntime?: string;
  selection: ModelExecutionSelection;
}): boolean {
  if (
    params.entry.modelSelectionLocked ||
    params.entry.acp ||
    hasAcceptedExecutionEncoding(params.entry) ||
    params.entry.modelOverrideSource !== "auto" ||
    normalizeOptionalString(params.entry.agentRuntimeOverride) !== params.expectedRuntime ||
    !isDeepStrictEqual(readSessionExecutionRepairModel(params.entry), params.expectedModel)
  ) {
    return false;
  }
  encodeSessionExecutionSelection(params.entry, params.selection, { kind: "reset" });
  delete params.entry.liveModelSwitchPending;
  return true;
}

export function hasLegacySessionSelectionFields(entry: Partial<SessionEntry>): boolean {
  return SESSION_EXECUTION_SELECTION_FIELDS.some((field) => entry[field] !== undefined);
}
