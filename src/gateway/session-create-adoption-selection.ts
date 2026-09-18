import { type FastMode, normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir } from "../agents/agent-scope.js";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { ModelRef } from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getSessionExecutionSelection,
  isModelExecutionSelection,
} from "../model-picker/execution-selection.js";
import { shouldPreserveSessionAuthProfileOverride } from "../sessions/auth-profile-preservation.js";
import { resolveSessionPatchModelSelection } from "./server-methods/sessions-patch-model-selection.js";

export type ExistingSelectionCheck =
  | { changes: true }
  | { changes: false; model?: { ref: ModelRef; profile?: string; catalog: ModelCatalogSnapshot } };

export async function existingSessionSelectionWouldChange(params: {
  agentId: string;
  cfg: OpenClawConfig;
  catalogModel?: string;
  defaultModel: string;
  defaultProvider: string;
  existingEntry: SessionEntry;
  loadGatewayModelCatalogSnapshot?: () => Promise<ModelCatalogSnapshot>;
  requestedModel?: string;
  requestedAgentRuntime?: string;
  requestedContextWindow?: string;
  requestedFastMode?: FastMode;
  requestedThinkingLevel?: string;
  subagentModelHint?: string;
}): Promise<ExistingSelectionCheck> {
  if (params.catalogModel) {
    // Public catalog creates cannot include a key, and the service rejects
    // catalog targets for existing rows. If a trusted caller reaches this,
    // keep catalog-owned model/runtime adoption fail-closed.
    return { changes: true };
  }
  const stored = params.existingEntry.executionSelection;
  const accepted = getSessionExecutionSelection(params.existingEntry);
  const deferred = stored?.state === "deferred" ? stored.request : undefined;
  const executor = accepted?.executor ?? deferred?.executor;
  const recordedRuntime =
    executor?.kind === "acp" ? undefined : (executor?.id ?? deferred?.runtime);
  if (
    params.requestedAgentRuntime !== undefined &&
    (executor?.kind === "acp" || params.requestedAgentRuntime !== recordedRuntime)
  ) {
    return { changes: true };
  }
  const requestedThinkingLevel = normalizeOptionalString(params.requestedThinkingLevel);
  const requestedContextWindow = normalizeOptionalString(params.requestedContextWindow);
  if (
    params.requestedFastMode !== undefined &&
    params.requestedFastMode !== params.existingEntry.fastMode
  ) {
    return { changes: true };
  }
  if (
    requestedContextWindow &&
    requestedContextWindow !== normalizeOptionalString(params.existingEntry.contextWindow)
  ) {
    return { changes: true };
  }
  if (
    requestedThinkingLevel &&
    requestedThinkingLevel !== normalizeOptionalString(params.existingEntry.thinkingLevel)
  ) {
    return { changes: true };
  }
  const requestedModel = normalizeOptionalString(params.requestedModel);
  if (!requestedModel) {
    return { changes: false };
  }
  if (!params.loadGatewayModelCatalogSnapshot) {
    // Public/TUI model selection paths provide the catalog loader used by the
    // patch resolver. Without it, an existing-row model request cannot prove
    // it is a no-op, so non-admin callers must not reach the mutation path.
    return { changes: true };
  }
  const catalog = await params.loadGatewayModelCatalogSnapshot();
  const resolved = resolveSessionPatchModelSelection({
    cfg: params.cfg,
    agentId: params.agentId,
    catalog: catalog.entries,
    raw: requestedModel,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    subagentModelHint: params.subagentModelHint,
  });
  if (!resolved.ok) {
    // Admin callers still receive the precise model error from sessions.patch.
    // Non-admin existing-row creates fail closed before that mutation path.
    return { changes: true };
  }
  let reference: ModelRef;
  if (accepted) {
    if (!isModelExecutionSelection(accepted)) {
      return { changes: true };
    }
    reference = { provider: accepted.model.provider, model: accepted.model.id };
  } else if (!stored?.legacyRequest && deferred?.model) {
    if (deferred.model === "native-managed") {
      return { changes: true };
    }
    reference = {
      provider: deferred.model.provider ?? params.defaultProvider,
      model: deferred.model.id,
    };
  } else {
    reference = { provider: params.defaultProvider, model: params.defaultModel };
    if (params.subagentModelHint) {
      const configured = resolveSessionPatchModelSelection({
        cfg: params.cfg,
        agentId: params.agentId,
        catalog: catalog.entries,
        raw: params.subagentModelHint,
        defaultProvider: params.defaultProvider,
        defaultModel: params.defaultModel,
      });
      if (!configured.ok) {
        return { changes: true };
      }
      reference = { provider: configured.provider, model: configured.model };
    }
    // This completes an explicit request for authorization only; it is never runnable intent.
    if (stored?.legacyRequest) {
      reference.provider = stored.legacyRequest.provider;
    }
  }
  const existingProfile = normalizeOptionalString(params.existingEntry.authProfileOverride);
  const requestedProfile = normalizeOptionalString(resolved.profile);
  const profileWouldChange =
    requestedProfile !== undefined
      ? requestedProfile !== existingProfile
      : existingProfile !== undefined &&
        !shouldPreserveSessionAuthProfileOverride({
          cfg: params.cfg,
          agentDir: resolveAgentDir(params.cfg, params.agentId),
          currentProvider: reference.provider,
          entry: params.existingEntry,
          provider: resolved.provider,
        });
  return resolved.provider !== reference.provider ||
    resolved.model !== reference.model ||
    profileWouldChange
    ? { changes: true }
    : { changes: false, model: { ref: reference, profile: existingProfile, catalog } };
}
