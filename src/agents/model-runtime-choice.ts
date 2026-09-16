import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getSessionExecutionSelection } from "../model-picker/execution-selection-state.js";
import { isAcpExecutionSelection } from "../model-picker/execution-selection.js";
import { buildAgentHarnessSupportContext } from "./harness/support.js";
import { modelKey } from "./model-ref-shared.js";
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
}): Promise<
  | { kind: "unavailable" | "unknown" | "unsupported"; message: string }
  | { kind: "ready"; validate: () => string | undefined }
> {
  const { getPublishedPreparedModelCatalogOwnerSnapshot, materializePreparedModelCatalogOwner } =
    await import("./prepared-model-catalog.js");
  const { getPreparedModelRuntimeAuthStore } = await import("./prepared-model-runtime-auth.js");
  const { createModelCatalogDecisions } = await import("./model-catalog-decisions.js");
  const published = getPublishedPreparedModelCatalogOwnerSnapshot({
    config: params.cfg,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
  });
  const unavailable = `Runtime "${params.runtimeId}" is not available for ${params.provider}/${params.model}. Refresh the model catalog and choose again.`;
  if (!published) {
    return { kind: "unknown", message: unavailable };
  }
  const owner = materializePreparedModelCatalogOwner(published);
  const authStore = getPreparedModelRuntimeAuthStore(owner);
  if (!authStore) {
    return { kind: "unknown", message: unavailable };
  }
  const accepted = getSessionExecutionSelection(params.sessionEntry, params.cfg);
  const decisions = createModelCatalogDecisions({
    cfg: owner.config,
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
      params.sessionEntry?.authProfileOverrideSource === "user"
        ? params.sessionEntry.authProfileOverride
        : undefined,
    profileProvider:
      params.profileProvider ??
      (accepted && !isAcpExecutionSelection(accepted) ? accepted.model.provider : undefined),
  });
  let entry = decisions.snapshot.entries.find(
    (row) => modelKey(row.provider, row.id) === modelKey(params.provider, params.model),
  );
  if (!entry) {
    // Explicit selections may be outside finite browse inventory. The normal
    // resolver still owns the requested model's provider and physical route.
    const { resolveModelAsync } = await import("./embedded-agent-runner/model.js");
    const { modelCatalogRowToEntry } = await import("./model-catalog-entry.js");
    const selectedAuth = await decisions.evaluateEntry(
      { provider: params.provider, id: params.model },
      undefined,
      params.runtimeId,
    );
    const authProfileMode = resolveProviderModelMaterializationAuthMode(
      selectedAuth.selectedAuthMode,
    );
    if (selectedAuth.availability !== true || !authProfileMode) {
      return { kind: "unavailable", message: unavailable };
    }
    const resolved = await resolveModelAsync(
      params.provider,
      params.model,
      owner.agentDir,
      owner.config,
      {
        agentId: owner.agentId ?? params.agentId,
        workspaceDir: owner.workspaceDir,
        preparedModelRuntime: owner,
        agentRuntimeId: params.runtimeId,
        allowBundledStaticCatalogFallback: true,
        // Discovery must retain the prepared account instead of rereading live auth stores.
        authProfileMode,
        ...(selectedAuth.selectedProfileId
          ? { authProfileId: selectedAuth.selectedProfileId }
          : {}),
      },
    );
    if (!resolved.model) {
      return { kind: "unknown", message: unavailable };
    }
    entry = modelCatalogRowToEntry(resolved.model);
  }
  const variants = decisions.snapshot.routeVariants.filter(
    (row) => modelKey(row.provider, row.id) === modelKey(entry.provider, entry.id),
  );
  const host = await decisions.evaluateEntry(
    entry,
    variants.length ? variants : [entry],
    params.runtimeId,
  );
  const evaluation = decisions.evaluateNative(entry, host, params.runtimeId);
  const route = evaluation.selectedRoute;
  const compatible = route?.runtimePolicy?.compatibleIds;
  if (compatible && !compatible.includes(params.runtimeId)) {
    return { kind: "unsupported", message: unavailable };
  }
  const cli = owner.pluginRegistry?.cliBackends.find(
    ({ backend }) => backend.id === params.runtimeId,
  )?.backend;
  if (cli && cli.modelProvider !== params.provider && cli.id !== params.provider) {
    return { kind: "unsupported", message: unavailable };
  }
  if (evaluation.availability !== true) {
    return {
      kind: evaluation.availability === false ? "unavailable" : "unknown",
      message: unavailable,
    };
  }
  if (params.runtimeId !== "openclaw" && !cli) {
    const harness = owner.pluginRegistry?.agentHarnesses.find(
      ({ harness }) => harness.id === params.runtimeId,
    )?.harness;
    if (!harness) {
      return { kind: "unknown", message: unavailable };
    }
    const support = harness.supports(
      buildAgentHarnessSupportContext({
        config: owner.config,
        agentId: owner.agentId ?? params.agentId,
        provider: params.provider,
        modelId: params.model,
        requestedRuntime: params.runtimeId,
        preparedModelProvider: true,
        modelProvider: {
          api: route?.api ?? entry.api,
          baseUrl: route?.baseUrl ?? entry.baseUrl,
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
      return { kind: "unsupported", message: support.reason ?? unavailable };
    }
  }
  const choices = await decisions.runtimeChoices(entry, variants.length ? variants : [entry]);
  if (!choices?.includes(params.runtimeId)) {
    return { kind: "unknown", message: unavailable };
  }
  const validate = () =>
    decisions.isCurrent() &&
    decisions.evaluateNative(entry, host, params.runtimeId).availability === true
      ? undefined
      : unavailable;

  return { kind: "ready", validate };
}

/** Transitional request adapter; readiness and compatibility have one evaluator. */
export async function preparePublishedModelRuntimeChoice(
  params: Parameters<typeof evaluatePublishedModelRuntimeChoice>[0],
): Promise<
  { kind: "unavailable"; message: string } | { kind: "ready"; validate: () => string | undefined }
> {
  const result = await evaluatePublishedModelRuntimeChoice(params);
  return result.kind === "ready" ? result : { kind: "unavailable", message: result.message };
}
