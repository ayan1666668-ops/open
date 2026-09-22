import { resolveManifestModelCatalogProviderAliasMetadata } from "../../agents/embedded-agent-runner/model.manifest-alias.js";
import type { ModelFallbackAttemptProvenance } from "../../agents/model-fallback.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FollowupRun } from "./queue.js";
import type { ReplyOperation, ReplyToolAuthorityRoute } from "./reply-run-registry.contracts.js";
import { resolveFollowupRunToolAuthorityFingerprint } from "./reply-tool-authority.js";

/** Project one inbound steer against the active operation without weakening route authority. */
export function resolveReplyFallbackSteeringAuthority(params: {
  followupRun: FollowupRun;
  activeReplyOperation: ReplyOperation | undefined;
  shouldSteer: boolean;
  isActive: boolean;
}) {
  const { followupRun, activeReplyOperation } = params;
  const incomingToolAuthorityFingerprint = resolveFollowupRunToolAuthorityFingerprint(followupRun);
  const activeToolAuthorityFingerprint = activeReplyOperation?.toolAuthorityFingerprint;
  const activeRoute = activeReplyOperation?.toolAuthorityRoute;
  const incomingAuthorityAtActiveRoute =
    activeRoute && resolveFollowupRunToolAuthorityFingerprint(followupRun, activeRoute);
  const hasAuthorityMismatch =
    activeReplyOperation !== undefined &&
    activeToolAuthorityFingerprint !== incomingToolAuthorityFingerprint;
  const hasRouteOnlyAuthorityMismatch =
    hasAuthorityMismatch &&
    activeToolAuthorityFingerprint !== undefined &&
    incomingAuthorityAtActiveRoute === activeToolAuthorityFingerprint;
  const requestedRoute = activeReplyOperation?.requestedToolAuthorityRoute;
  const hasUnchangedModelSelection =
    requestedRoute?.provider === followupRun.run.provider &&
    requestedRoute?.model === followupRun.run.model;
  const hasModelSelectionChange = requestedRoute !== undefined && !hasUnchangedModelSelection;
  const fallbackRoute = activeReplyOperation?.automaticFallbackRoute;
  const automaticFallbackRoute =
    hasRouteOnlyAuthorityMismatch &&
    hasUnchangedModelSelection &&
    fallbackRoute?.provider === activeRoute?.provider &&
    fallbackRoute?.model === activeRoute?.model
      ? fallbackRoute
      : undefined;
  return {
    incomingToolAuthorityFingerprint,
    activeToolAuthorityFingerprint,
    incomingAuthorityAtActiveRoute,
    hasRouteOnlyAuthorityMismatch,
    automaticFallbackRoute,
    shouldQueueAuthorityMismatch:
      params.shouldSteer &&
      params.isActive &&
      (hasModelSelectionChange || (hasAuthorityMismatch && !hasRouteOnlyAuthorityMismatch)),
  };
}

/** Translate canonical selection/materialization facts; never infer provenance from the final hook route. */
export function recordReplyAutomaticFallbackRoute(params: {
  operation: ReplyOperation | undefined;
  provenance: ModelFallbackAttemptProvenance;
  route: ReplyToolAuthorityRoute;
  config: OpenClawConfig;
  workspaceDir?: string;
}): void {
  const { operation, provenance, route } = params;
  const requested = operation?.requestedToolAuthorityRoute;
  if (!operation) {
    return;
  }
  if (
    provenance.stage !== "fallback" ||
    provenance.selectionChanged !== false ||
    requested?.provider !== provenance.requestedProvider ||
    requested?.model !== provenance.requestedModel
  ) {
    operation.setAutomaticFallbackRoute(undefined);
    return;
  }
  // Same manifest owner and scope as final selected-model preparation. Complete
  // transport aliases stay distinct; ambiguous claims cannot authorize promotion.
  const canonical = resolveManifestModelCatalogProviderAliasMetadata({
    provider: route.provider,
    modelId: route.model,
    cfg: params.config,
    workspaceDir: params.workspaceDir,
  });
  operation.setAutomaticFallbackRoute(
    canonical.ambiguous ? undefined : { provider: canonical.provider, model: route.model },
  );
}
