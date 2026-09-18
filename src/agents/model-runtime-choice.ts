import { resolveCollapsedSessionAuthPinSource } from "../config/sessions/auth-profile-override-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getSessionExecutionSelection,
  isModelExecutionSelection,
} from "../model-picker/execution-selection.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { FailoverError } from "./failover/error.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { buildAgentHarnessSupportContext } from "./harness/support.js";
import { resolveModelProviderAuthConfig } from "./model-auth-provider-route.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { modelKey, type ModelRef } from "./model-ref-shared.js";
import { resolveProviderModelMaterializationAuthMode } from "./provider-model-route-auth.js";

/** Bind runtime selection and its commit check to the current published model owner. */
export async function evaluatePublishedModelRuntimeChoice(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir?: string;
  provider: string;
  model: string;
  runtimeId: string;
  sessionEntry?: Pick<SessionEntry, "authProfileOverride" | "authProfileOverrideSource"> &
    Partial<SessionEntry>;
  profileProvider?: string;
  materialize?: "override" | "automatic";
}): Promise<
  | { kind: "unknown"; message: string }
  | { kind: "forbidden"; message: string }
  | { kind: "unavailable"; message: string; validate: () => string | undefined }
  | {
      kind: "unsupported";
      message: string;
      fallback?: { runtime: string; validate: () => string | undefined };
    }
  | { kind: "pending"; ref: ModelRef; validate: () => string | undefined }
  | {
      kind: "ready";
      entry: ModelCatalogEntry;
      ref?: ModelRef;
      model?: ProviderRuntimeModel;
      validate: () => string | undefined;
    }
> {
  const {
    getPublishedPreparedModelCatalogOwnerSnapshot,
    preparePublishedModelCatalogOwnerSnapshot,
    materializePreparedModelCatalogOwner,
  } = await import("./prepared-model-catalog.js");
  const { getPreparedModelRuntimeAuthStore } = await import("./prepared-model-runtime-auth.js");
  const { createModelCatalogDecisions } = await import("./model-catalog-decisions.js");
  const catalogScope = {
    config: params.cfg,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
  };
  const published =
    getPublishedPreparedModelCatalogOwnerSnapshot(catalogScope) ??
    (await preparePublishedModelCatalogOwnerSnapshot(catalogScope));
  const unavailable = `Runtime "${params.runtimeId}" is not available for ${params.provider}/${params.model}. Refresh the model catalog and choose again.`;
  if (!published) {
    return { kind: "unknown", message: unavailable };
  }
  const owner = materializePreparedModelCatalogOwner(published);
  const authStore = getPreparedModelRuntimeAuthStore(owner);
  if (!authStore) {
    return { kind: "unknown", message: unavailable };
  }
  const accepted = getSessionExecutionSelection(params.sessionEntry);
  const decisions = createModelCatalogDecisions({
    cfg: resolveModelProviderAuthConfig({
      config: owner.config,
      provider: params.provider,
      modelId: params.model,
      metadataSnapshot: owner.metadataSnapshot,
    }),
    agentId: owner.agentId ?? params.agentId,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
    snapshot: owner.modelCatalog,
    metadataSnapshot: owner.metadataSnapshot,
    preparedAuthStore: authStore,
    preparedRuntimeAuthModes: owner.authModes,
    pluginRegistry: owner.pluginRegistry,
    observationConfig: owner.observationConfig,
    isCurrent: owner.isCurrent,
    preferredProfileId: params.sessionEntry?.authProfileOverride,
    pinnedProfileId:
      resolveCollapsedSessionAuthPinSource(params.sessionEntry) === "user"
        ? params.sessionEntry?.authProfileOverride
        : undefined,
    profileProvider:
      params.profileProvider ??
      (accepted && isModelExecutionSelection(accepted) ? accepted.model.provider : undefined),
  });
  const changed = "Model configuration changed during selection. Retry the request.";
  const validateGeneration = () => (decisions.isCurrent() ? undefined : changed);
  const catalogEntry = decisions.snapshot.entries.find(
    (row) => modelKey(row.provider, row.id) === modelKey(params.provider, params.model),
  );
  const entry = catalogEntry ?? { provider: params.provider, id: params.model, name: params.model };
  const variants = decisions.snapshot.routeVariants.filter(
    (row) => modelKey(row.provider, row.id) === modelKey(entry.provider, entry.id),
  );
  const host = await decisions.evaluateEntry(
    entry,
    variants.length ? variants : [entry],
    params.runtimeId,
  );
  if (!decisions.isCurrent()) {
    return { kind: "unknown", message: changed };
  }
  const evaluation = decisions.evaluateNative(entry, host, params.runtimeId);
  const route = evaluation.selectedRoute;
  if (evaluation.routeResolution?.kind === "incompatible") {
    return { kind: "unsupported", message: evaluation.routeResolution.message };
  }
  const policy = resolveAgentHarnessPolicy({
    config: owner.config,
    agentId: owner.agentId ?? params.agentId,
    provider: params.provider,
    modelId: params.model,
    modelApi: route?.api ?? entry.api,
    modelBaseUrl: route?.baseUrl ?? entry.baseUrl,
    requestTransportOverrides: route?.requestTransportOverrides,
  });
  if (
    (policy.forcedByEnvironment && policy.runtime !== params.runtimeId) ||
    (evaluation.runtimeAuth && evaluation.runtimeAuth.id !== params.runtimeId)
  ) {
    return {
      kind: "forbidden",
      message:
        "Could not change models. This app is not permitted for this session. Your selection is unchanged.",
    };
  }
  const compatible = route?.runtimePolicy?.compatibleIds;
  const routeExcluded = compatible !== undefined && !compatible.includes(params.runtimeId);
  const cli = owner.pluginRegistry?.cliBackends.find(
    ({ backend }) => backend.id === params.runtimeId,
  )?.backend;
  if (cli && cli.modelProvider !== params.provider && cli.id !== params.provider) {
    return { kind: "unsupported", message: unavailable };
  }
  const harness =
    params.runtimeId !== "openclaw" && !cli
      ? owner.pluginRegistry?.agentHarnesses.find(
          ({ harness: candidateHarness }) => candidateHarness.id === params.runtimeId,
        )?.harness
      : undefined;
  if (routeExcluded && (!harness || evaluation.availability !== true || !decisions.isCurrent())) {
    return { kind: "unsupported", message: unavailable };
  }
  if (evaluation.availability !== true) {
    return {
      kind: evaluation.availability === false ? "unavailable" : "unknown",
      message: params.sessionEntry?.authProfileOverride
        ? `The selected account or native runtime is unavailable for ${params.provider}/${params.model}. Restore that account before spawning this model.`
        : unavailable,
      validate: validateGeneration,
    };
  }
  if (params.runtimeId !== "openclaw" && !cli && !harness) {
    return { kind: "unknown", message: unavailable };
  }
  const validate = () =>
    decisions.isCurrent() &&
    decisions.evaluateNative(entry, host, params.runtimeId).availability === true
      ? undefined
      : unavailable;

  let materialized: { ref: ModelRef; model: ProviderRuntimeModel } | undefined;
  let finalEntry = entry;
  if (!routeExcluded && (params.materialize || !catalogEntry)) {
    const { resolveModelAsync } = await import("./embedded-agent-runner/model.js");
    const { modelCatalogRowToEntry } = await import("./model-catalog-entry.js");
    const { projectProviderModelRouteConfig } = await import("./provider-model-route.js");
    const { validatePreparedRuntimeModel } = await import("./runtime-plan/materialize-model.js");
    const config = route
      ? projectProviderModelRouteConfig({ provider: params.provider, config: owner.config, route })
      : owner.config;
    const resolution = await resolveModelAsync(
      params.provider,
      params.model,
      owner.agentDir,
      config,
      {
        agentId: owner.agentId ?? params.agentId,
        workspaceDir: owner.workspaceDir,
        preparedModelRuntime: owner,
        modelIdSource: "selected",
        authProfileId: evaluation.selectedProfileId,
        authProfileMode: resolveProviderModelMaterializationAuthMode(evaluation.selectedAuthMode),
        agentRuntimeId: params.runtimeId,
        allowBundledStaticCatalogFallback: true,
        deferProviderDynamicModelPreparation: params.materialize === "automatic",
      },
    );
    if (!decisions.isCurrent()) {
      return { kind: "unknown", message: changed };
    }
    if (!resolution.model) {
      return resolution.deferred === "provider-dynamic-model"
        ? { kind: "pending", ref: { provider: params.provider, model: params.model }, validate }
        : {
            kind: params.materialize ? "unavailable" : "unknown",
            message: resolution.error,
            validate: validateGeneration,
          };
    }
    try {
      const model = validatePreparedRuntimeModel({
        provider: params.provider,
        modelId: params.model,
        config,
        workspaceDir: owner.workspaceDir,
        metadataSnapshot: owner.metadataSnapshot,
        route: route ? { ...route, provider: params.provider, modelId: params.model } : undefined,
        model: resolution.model,
      });
      const ref = resolution.logicalRef;
      materialized = { model, ref };
      finalEntry = { ...modelCatalogRowToEntry(model), provider: ref.provider, id: ref.model };
    } catch (error) {
      if (error instanceof FailoverError && error.reason === "model_not_found") {
        return { kind: "unavailable", message: error.message, validate: validateGeneration };
      }
      throw error;
    }
  }
  if (harness) {
    const support = harness.supports(
      buildAgentHarnessSupportContext({
        config: owner.config,
        agentId: owner.agentId ?? params.agentId,
        provider: params.provider,
        modelId: params.model,
        requestedRuntime: params.runtimeId,
        preparedModelProvider: true,
        modelProvider: {
          api: materialized?.model.api ?? route?.api ?? entry.api,
          baseUrl: materialized?.model.baseUrl ?? route?.baseUrl ?? entry.baseUrl,
          runtimePolicy: route?.runtimePolicy,
          requestTransportOverrides: route?.requestTransportOverrides,
          preparedAuth: evaluation.runtimeAuth
            ? { source: "harness" }
            : {
                source: evaluation.selectedProfileId ? "profile" : "direct",
                mode: evaluation.selectedAuthMode,
                requirement: route?.authRequirement,
              },
        },
      }),
    );
    if (!support.supported) {
      // Older support hooks also return false when route metadata is absent.
      // An explicit route exclusion or a declared lossless fallback proves
      // incompatibility; missing route metadata alone does not.
      return support.fallbackRuntime
        ? {
            kind: "unsupported",
            message: support.reason ?? unavailable,
            fallback: { runtime: support.fallbackRuntime, validate },
          }
        : {
            kind: routeExcluded ? "unsupported" : "unknown",
            message: support.reason ?? unavailable,
          };
    }
  }
  return routeExcluded
    ? { kind: "unsupported", message: unavailable }
    : { kind: "ready", entry: finalEntry, ...materialized, validate };
}
