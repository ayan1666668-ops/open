/**
 * Single-authority pure disposition owner for the configured default-model
 * auth-profile binding. Mirrors the effective selection decision that the
 * embedded execution path derives in `resolveEmbeddedModelSelection` (explicit
 * override -> stored override with repair -> alias -> resolveSelection fallback)
 * WITHOUT any side effects: no `persistAgentSession`, no channel overrides (they
 * need run context), and no auth-profile validation. It exists so the standalone
 * prepare entry can decide, with the same fallback outcomes as execution,
 * whether the run resolves to the configured default model (and thus whether the
 * configured default model's bound auth profile must be materialized).
 *
 * Execution keeps its own side-effecting repair/persist and auth checks; this
 * owner only supplies the pure disposition both sides consume, avoiding the
 * previous competing implementation in `model-selection-gate.ts` (one-owner
 * cutover, root AGENTS.md line 12/33).
 */
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { isModelSelectionLocked } from "../../sessions/model-overrides.js";
import { resolveStoredModelOverride } from "../../sessions/stored-model-overrides.js";
import {
  hasLegacyAutoFallbackWithoutOrigin,
  resolveAgentEffectiveModelPrimary,
  resolveAutoFallbackPrimaryProbe,
} from "../agent-scope.js";
import { splitTrailingAuthProfile } from "../model-ref-profile.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import { resolveDefaultModelForAgent } from "../model-selection-config.js";
import { resolveModelAliasFromPair } from "../model-selection-shared.js";
import { modelKey } from "../model-selection.js";
import {
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "../model-visibility-policy.js";
import { normalizeExplicitOverrideInput } from "./model-override-input.js";
import {
  normalizeAgentCommandDefaultModelRef,
  normalizeAgentCommandModelRef,
  parseAgentCommandModelRef,
} from "./model-ref.js";

export type EffectiveDefaultDisposition = {
  /** True when the effective selection resolves to the configured default provider/model. */
  effectiveIsDefault: boolean;
  /** Auth-profile suffix bound to the configured default model ref, when present. */
  configuredDefaultAuthProfileId?: string;
  /** Effective provider after explicit/stored/repair/alias/fallback. */
  effectiveProvider: string;
  /** Effective model after explicit/stored/repair/alias/fallback. */
  effectiveModel: string;
};

/** Pure extraction of the auth-profile suffix bound to an agent's effective default model ref. */
export function resolveConfiguredDefaultAuthProfileId(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  return splitTrailingAuthProfile(resolveAgentEffectiveModelPrimary(cfg, agentId) ?? "").profile;
}

export type EffectiveDefaultDispositionParams = {
  cfg: OpenClawConfig;
  agentId: string;
  opts: { provider?: string; model?: string };
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  workspaceDir?: string;
  pluginsEnabled?: boolean;
  manifestMetadataSnapshot?: PluginMetadataSnapshot;
  defaultProvider?: string;
  defaultModel?: string;
  allowPluginNormalization?: boolean;
  modelManifestContext: ModelManifestNormalizationContext;
};

/**
 * Resolves the effective default disposition for an agent run. Pure: reads
 * config/session/model inputs and returns a disposition without mutating
 * session state, activating secrets, or validating auth profiles.
 */
export function resolveEffectiveDefaultDisposition(
  params: EffectiveDefaultDispositionParams,
): EffectiveDefaultDisposition {
  const { cfg, agentId, modelManifestContext, sessionEntry } = params;
  const allowPluginNormalization =
    params.allowPluginNormalization ?? params.pluginsEnabled ?? false;
  const configuredDefaultRef = resolveDefaultModelForAgent({
    cfg,
    agentId,
    allowPluginNormalization,
    ...modelManifestContext,
  });
  const { provider: defaultProvider, model: defaultModel } = normalizeAgentCommandDefaultModelRef(
    cfg,
    params.defaultProvider ?? configuredDefaultRef.provider,
    params.defaultModel ?? configuredDefaultRef.model,
    modelManifestContext,
  );
  const configuredDefaultAuthProfileId = resolveConfiguredDefaultAuthProfileId(cfg, agentId);

  let provider = defaultProvider;
  let model = defaultModel;

  // Visibility policy mirrors execution's construction so allows() and
  // resolveSelection() agree with the embedded path on allowlist/configured
  // models. The owner does NOT load the manifest catalog: prepare runs before
  // execution and must not duplicate catalog hydration (the real lazy boundary
  // stays with execution), and the allowlist/configured-model set is derived
  // from cfg alone. Fallback entries from cfg (buildTestConfiguredModelCatalog
  // in tests; configured entries at runtime) still feed resolveSelection.
  const visibilityPolicy: ModelVisibilityPolicy = createModelVisibilityPolicy({
    cfg,
    catalog: [],
    defaultProvider,
    defaultModel,
    agentId,
    allowManifestNormalization: true,
    allowPluginNormalization,
    ...modelManifestContext,
  });

  const explicitProvider =
    typeof params.opts.provider === "string" && params.opts.provider.trim()
      ? normalizeExplicitOverrideInput(params.opts.provider, "provider")
      : undefined;
  const explicitModel =
    typeof params.opts.model === "string" && params.opts.model.trim()
      ? normalizeExplicitOverrideInput(params.opts.model, "model")
      : undefined;
  const hasExplicitRunOverride = Boolean(explicitProvider || explicitModel);

  // Explicit override has the same authority as execution: when present it
  // selects the effective provider/model directly. The owner does NOT throw
  // when the override is disallowed by the visibility policy — prepare must not
  // abort a run that execution will reject anyway — and it still adopts the
  // override so `effectiveIsDefault` is decided by the override-vs-default
  // comparison: a non-default override is not the default binding.
  if (hasExplicitRunOverride) {
    const explicitRef = explicitModel
      ? explicitProvider
        ? normalizeAgentCommandModelRef(cfg, explicitProvider, explicitModel, modelManifestContext)
        : parseAgentCommandModelRef(cfg, agentId, explicitModel, provider, modelManifestContext)
      : explicitProvider
        ? normalizeAgentCommandModelRef(cfg, explicitProvider, model, modelManifestContext)
        : null;
    if (!explicitRef) {
      throw new Error("Invalid model override.");
    }
    provider = explicitRef.provider;
    model = explicitRef.model;
  } else {
    // Stored override (with repair): a legacy auto-fallback override or a stored
    // override that the visibility policy no longer allows repairs back to the
    // default, exactly like execution does before persisting.
    const hasStoredOverride = Boolean(
      sessionEntry &&
      sessionEntry.modelOverrideSource !== "default" &&
      (sessionEntry.modelOverride || sessionEntry.providerOverride),
    );
    if (hasStoredOverride) {
      const legacyAutoFallbackWithoutOrigin =
        hasStoredOverride && hasLegacyAutoFallbackWithoutOrigin(sessionEntry);
      const effectiveStoredOverride = legacyAutoFallbackWithoutOrigin
        ? null
        : resolveStoredModelOverride({
            sessionEntry,
            sessionStore: params.sessionStore,
            sessionKey: params.sessionKey,
            parentSessionKey: sessionEntry?.parentSessionKey,
            defaultProvider,
          });
      if (effectiveStoredOverride) {
        const candidateProvider = effectiveStoredOverride.provider ?? defaultProvider;
        const storedAlias =
          effectiveStoredOverride.routeResolution === "raw"
            ? resolveModelAliasFromPair({
                cfg,
                agentId,
                provider: candidateProvider,
                model: effectiveStoredOverride.model,
                defaultProvider,
                aliasIndex: visibilityPolicy.selectionAliasIndex,
                allowPluginNormalization,
                ...modelManifestContext,
              })
            : null;
        const normalizedStored = normalizeAgentCommandModelRef(
          cfg,
          storedAlias?.provider ?? candidateProvider,
          storedAlias?.model ?? effectiveStoredOverride.model,
          modelManifestContext,
        );
        if (isModelSelectionLocked(sessionEntry) || visibilityPolicy.allows(normalizedStored)) {
          provider = normalizedStored.provider;
          model = normalizedStored.model;
        }
        // When the stored override is not allowed it is ignored, leaving the
        // default (execution repairs and persists this; owner stays read-only).
      }
    }
  }

  // Auto-fallback primary recovery (P1-A, Codex R6): execution probes the
  // configured primary for a session that auto-fell-back with primary-origin
  // metadata (model-selection.ts:357-373). When it probes, run-embedded-attempt
  // requests the primary bound profile, so the owner must report the effective
  // selection as the probed primary (which is the default when the fallback
  // origin is the configured default). The primary is the session's fallback
  // origin — the same value execution's probe resolves to — so the owner agrees
  // with execution even under a channel override. The probe is a pure read; a
  // fresh probe state is passed so this decision never consumes execution's
  // throttle window.
  if (!hasExplicitRunOverride && !isModelSelectionLocked(sessionEntry) && sessionEntry) {
    const primaryProvider =
      sessionEntry.modelOverrideFallbackOriginProvider?.trim() || defaultProvider;
    const primaryModel = sessionEntry.modelOverrideFallbackOriginModel?.trim() || defaultModel;
    const autoFallbackProbe = resolveAutoFallbackPrimaryProbe({
      entry: sessionEntry,
      sessionKey: params.sessionKey,
      primaryProvider,
      primaryModel,
      probeState: new Map(),
    });
    if (autoFallbackProbe) {
      provider = autoFallbackProbe.provider;
      model = autoFallbackProbe.model;
    }
  }

  // resolveSelection fallback: if the chosen provider/model is not allowed by
  // the visibility policy, execution remaps to the first allowed fallback. Share
  // the same fallback outcome so prepare agrees with execution. When no allowed
  // model is available execution throws (no run reaches inference); the owner
  // reports the selection as non-default so the default binding is not
  // materialized for a run that cannot execute.
  if (!isModelSelectionLocked(sessionEntry)) {
    const allowedInitialSelection = visibilityPolicy.resolveSelection({ provider, model });
    if (!allowedInitialSelection) {
      return {
        effectiveIsDefault: false,
        configuredDefaultAuthProfileId,
        effectiveProvider: provider,
        effectiveModel: model,
      };
    }
    if (
      modelKey(allowedInitialSelection.provider, allowedInitialSelection.model) !==
      modelKey(provider, model)
    ) {
      provider = allowedInitialSelection.provider;
      model = allowedInitialSelection.model;
    }
  }

  return {
    effectiveIsDefault: provider === defaultProvider && model === defaultModel,
    configuredDefaultAuthProfileId,
    effectiveProvider: provider,
    effectiveModel: model,
  };
}
