import { isDeepStrictEqual } from "node:util";
/**
 * Runtime SDK subpath for model overrides and agent concurrency session helpers.
 */
import { expectDefined } from "@openclaw/normalization-core";
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
} from "../agents/agent-runtime-id.js";
import type { AgentModelPrimaryWriteTarget } from "../agents/agent-scope.js";
import { resolveModelProviderAuthConfig } from "../agents/model-auth-provider-route.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { ModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import { resolveAcceptedSessionRuntimeId } from "../agents/session-runtime-compat.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  stageSessionExecutionSelection,
  type ApplySessionExecutionSelectionResult as OwnerSelectionResult,
} from "../model-picker/apply-session-model-selection.js";
import {
  isAcpExecutionSelection,
  isModelExecutionSelection,
  getCommittedSessionExecutionSelection,
} from "../model-picker/execution-selection.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveSessionPinnedHarnessId } from "../sessions/agent-harness-session-key.js";
import { shouldPreserveSessionAuthProfileOverride } from "../sessions/auth-profile-preservation.js";
import { assertModelSelectionUnlocked } from "../sessions/model-overrides.js";
import type { SessionEntry as PublicSelectionEntry } from "./session-store-runtime-internal.js";
type ModelOverrideSelection = {
  provider: string;
  model: string;
  isDefault?: boolean;
};

export type SessionModelSelectionRequest = {
  provider: string;
  model: string;
  isDefault: boolean;
  alias?: string;
  profileOverride?: string;
  runtime: { kind: "unchanged" } | { kind: "clear" } | { kind: "set"; runtime: string };
};

export type ApplySessionModelSelectionParams = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  storePath?: string;
  sessionEntry: PublicSelectionEntry;
  sessionStore: Record<string, PublicSelectionEntry>;
  allowCreate?: boolean;
  defaultProvider: string;
  defaultModel: string;
  currentProvider: string;
  currentModel: string;
  modelPolicy?: ModelVisibilityPolicy;
  modelCatalog: readonly ModelCatalogEntry[];
  thinkingCatalog?: readonly ModelCatalogEntry[];
  canPersistStickyModelSelection?: boolean;
  stickyModelSelectionTarget?: AgentModelPrimaryWriteTarget;
  validateAuthProfileSelection?: () => string | undefined;
  request: SessionModelSelectionRequest;
  /** Raw directive text used only by the existing session patch hook. */
  patchModel?: string;
  markLiveSwitchPending: true;
};

export type ApplySessionModelSelectionResult =
  | {
      status: "applied";
      provider: string;
      model: string;
      effectiveModelRef: string;
      agentRuntime: string;
      changed: boolean;
      contextTokens: number;
      /** Optional so released hosts and result literals remain compatible. */
      message?: string;
      configuredDefaultUpdate?: Extract<
        OwnerSelectionResult,
        { status: "applied" }
      >["configuredDefaultUpdate"];
      runtimeChange?: { kind: "clear" } | { kind: "set"; runtime: string };
      thinkingRemap?: Extract<OwnerSelectionResult, { status: "applied" }>["thinkingRemap"];
    }
  | {
      status: "rejected";
      reason: "locked" | "not-allowed" | "invalid-runtime" | "unknown-provider";
      message: string;
    }
  | Extract<OwnerSelectionResult, { status: "conflict" }>;

/** Preserve the shipped flat response while the session owner accepts and commits one pair. */
export async function applySessionModelSelection(
  params: ApplySessionModelSelectionParams,
): Promise<ApplySessionModelSelectionResult> {
  const hadStoreEntry = Object.hasOwn(params.sessionStore, params.sessionKey);
  const startingStoreEntry = params.sessionStore[params.sessionKey];
  const original = startingStoreEntry ?? params.sessionEntry;
  const initial = structuredClone(original);
  const { loadSessionEntryReadOnly } = await import("../config/sessions/session-accessor.js");
  const { projectPluginSessionEntry, projectPluginSessionEntryPatch } =
    await import("./session-store-runtime-internal.js");
  const current = params.storePath
    ? loadSessionEntryReadOnly({
        storePath: params.storePath,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
      })
    : undefined;
  if (
    current &&
    (current.sessionId !== original.sessionId ||
      current.lifecycleRevision !== original.lifecycleRevision)
  ) {
    return { status: "conflict", message: "The session changed. Retry the model selection." };
  }
  const canonical = current ?? {
    ...projectPluginSessionEntryPatch(original),
    sessionId: original.sessionId,
    updatedAt: original.updatedAt,
  };
  const sessionStore = { [params.sessionKey]: canonical };
  const acpInstruction =
    "Use the owning app's model controls for app-managed models; this API requires a concrete provider/model route.";
  const selection = getCommittedSessionExecutionSelection(canonical);
  if (
    (selection && isAcpExecutionSelection(selection)) ||
    (canonical.executionSelection?.state === "deferred" &&
      canonical.executionSelection.request.executor?.kind === "acp")
  ) {
    return { status: "rejected", reason: "invalid-runtime", message: acpInstruction };
  }
  const owner = await import("../model-picker/apply-session-model-selection.js");
  const request = params.request;
  const executorKind =
    request.runtime.kind === "set"
      ? owner.resolveExecutionSelectionExecutorKind(params.cfg, request.runtime.runtime)
      : undefined;
  if (request.runtime.kind === "set" && !executorKind) {
    return {
      status: "rejected",
      reason: "invalid-runtime",
      message: "Could not confirm support for the selected app. Your selection is unchanged.",
    };
  }
  const result = await owner.applySessionExecutionSelection({
    ...params,
    sessionEntry: canonical,
    sessionStore,
    request:
      request.runtime.kind === "clear"
        ? { kind: "reset", model: { provider: request.provider, id: request.model } }
        : {
            kind: "model",
            model: { provider: request.provider, id: request.model },
            ...(request.runtime.kind === "set" && executorKind
              ? { executor: { kind: executorKind, id: request.runtime.runtime } }
              : {}),
          },
    fallbackPermission: request.isDefault ? "configured" : "explicit",
    profileOverride: request.profileOverride,
    validateCommit: () =>
      params.validateAuthProfileSelection?.() ??
      (!isDeepStrictEqual(original, initial) ||
      Object.hasOwn(params.sessionStore, params.sessionKey) !== hadStoreEntry ||
      params.sessionStore[params.sessionKey] !== startingStoreEntry
        ? "The session changed. Retry the model selection."
        : undefined),
  });
  if (result.status === "conflict") {
    return result;
  }
  if (result.status === "rejected") {
    const reason =
      result.reason === "locked" || result.reason === "not-allowed"
        ? result.reason
        : "invalid-runtime";
    return { ...result, reason };
  }
  if (!isModelExecutionSelection(result.selection)) {
    throw new Error("Concrete model request returned an app-managed selection.");
  }
  const projected = projectPluginSessionEntry(
    expectDefined(sessionStore[params.sessionKey], "Applied selection lost its session entry"),
  );
  for (const key of Object.keys(params.sessionEntry)) {
    if (!Object.hasOwn(projected, key)) {
      Reflect.deleteProperty(params.sessionEntry, key);
    }
  }
  Object.assign(params.sessionEntry, projected);
  params.sessionStore[params.sessionKey] = projected;
  const { provider, id: model } = result.selection.model;
  return {
    status: "applied",
    changed: result.changed,
    message: result.message,
    ...(result.configuredDefaultUpdate
      ? { configuredDefaultUpdate: result.configuredDefaultUpdate }
      : {}),
    ...(result.thinkingRemap ? { thinkingRemap: result.thinkingRemap } : {}),
    provider,
    model,
    effectiveModelRef: `${provider}/${model}`,
    agentRuntime: result.selection.executor.id,
    contextTokens: expectDefined(
      result.contextTokens,
      "Accepted model selection has no context budget.",
    ),
    ...(params.request.runtime.kind === "clear"
      ? { runtimeChange: { kind: "clear" as const } }
      : params.request.runtime.kind === "set"
        ? { runtimeChange: { kind: "set" as const, runtime: result.selection.executor.id } }
        : {}),
  };
}

export { resolveChannelModelOverride } from "../channels/model-overrides.js";
export { resolveAgentMaxConcurrent } from "../config/agent-limits.js";
/** Released read contract for legacy plugin inputs; core reads only the accepted executor. */
export function resolvePersistedSessionRuntimeId(
  entry?: Partial<
    Pick<
      PublicSelectionEntry,
      | "executionSelection"
      | "agentRuntimeOverride"
      | "agentHarnessId"
      | "modelSelectionLocked"
      | "pluginOwnerId"
    >
  >,
): string | undefined {
  if (entry?.executionSelection?.state === "accepted") {
    return resolveAcceptedSessionRuntimeId(entry);
  }
  if (entry?.executionSelection?.state === "deferred") {
    const { executor, runtime } = entry.executionSelection.request;
    const requested = executor?.kind === "acp" ? undefined : (executor?.id ?? runtime);
    return requested && !isDefaultAgentRuntimeId(requested) ? requested : undefined;
  }
  const pinned = resolveSessionPinnedHarnessId(entry);
  if (pinned && !isDefaultAgentRuntimeId(pinned)) {
    return pinned;
  }
  const runtime = normalizeOptionalAgentRuntimeId(entry?.agentRuntimeOverride);
  return runtime && !isDefaultAgentRuntimeId(runtime)
    ? runtime
    : normalizeOptionalAgentRuntimeId(entry?.agentHarnessId);
}
export { resolveSessionModelRef } from "../agents/session-model-ref.js";
export {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
  ModelSelectionLockedError,
} from "../sessions/model-overrides.js";
/** Released synchronous SDK intake; preparation validates the deferred request before execution. */
export function applyModelOverrideToSessionEntry(params: {
  entry: Parameters<typeof stageSessionExecutionSelection>[0]["entry"];
  selection: ModelOverrideSelection;
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
  preserveAuthProfileOverride?: boolean;
  selectionSource?: "auto" | "user";
  explicitDefaultSelection?: boolean;
  markLiveSwitchPending?: boolean;
}): { updated: boolean } {
  return stageSessionExecutionSelection(params);
}
/** Released synchronous SDK intake that preserves provider-scoped account intent. */
export function applyModelOverrideWithAuthProfileCompatibility(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  entry: Parameters<typeof stageSessionExecutionSelection>[0]["entry"];
  currentProvider: string;
  selection: ModelOverrideSelection;
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
  selectionSource?: "auto" | "user";
  explicitDefaultSelection?: boolean;
  markLiveSwitchPending?: boolean;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
}): { updated: boolean } {
  assertModelSelectionUnlocked(params.entry);
  return stageSessionExecutionSelection({
    entry: params.entry,
    selection: params.selection,
    ...(params.profileOverride ? { profileOverride: params.profileOverride } : {}),
    ...(params.profileOverrideSource
      ? { profileOverrideSource: params.profileOverrideSource }
      : {}),
    ...(params.selectionSource ? { selectionSource: params.selectionSource } : {}),
    ...(params.explicitDefaultSelection
      ? { explicitDefaultSelection: params.explicitDefaultSelection }
      : {}),
    ...(params.markLiveSwitchPending !== undefined
      ? { markLiveSwitchPending: params.markLiveSwitchPending }
      : {}),
    preserveAuthProfileOverride:
      !params.profileOverride &&
      shouldPreserveSessionAuthProfileOverride({
        cfg: resolveModelProviderAuthConfig({
          config: params.cfg,
          provider: params.selection.provider,
          modelId: params.selection.model,
          metadataSnapshot: params.metadataSnapshot,
        }),
        agentDir: params.agentDir,
        entry: params.entry,
        currentProvider: params.currentProvider,
        provider: params.selection.provider,
        ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
      }),
  });
}
