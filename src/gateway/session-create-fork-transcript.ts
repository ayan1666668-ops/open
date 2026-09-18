import { resolveContextTokensForModel } from "../agents/context.js";
import { selectModelCatalogRuntimeEntry } from "../agents/model-catalog-view.js";
import { findModelCatalogEntry } from "../agents/model-catalog.js";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { resolveModelContextWindowProfile } from "../agents/model-context-window.js";
import { resolveSessionModelRefCore as resolveSessionModelRef } from "../agents/session-model-ref.js";
import { resolveEffectiveAgentRuntimeCore } from "../agents/thinking-runtime.js";
import { forkSessionFromParentWithDecision } from "../auto-reply/reply/session-fork.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PreparedGatewaySessionLifecycle } from "./session-lifecycle-preparation.js";
import type { resolveGatewaySessionStoreTarget } from "./session-utils.js";

export async function createGatewaySessionForkTranscript(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  parentEntry: SessionEntry;
  parentTarget: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  parentSessionKey: string;
  loadGatewayModelCatalogSnapshot?: () => Promise<ModelCatalogSnapshot>;
  forkFrom?: "last-completed";
  commitGuard: () => void;
  withCommit?: PreparedGatewaySessionLifecycle["withCommit"];
}) {
  const childModel = resolveSessionModelRef(params.cfg, params.entry, params.target.agentId);
  const childCatalog = params.loadGatewayModelCatalogSnapshot
    ? await params.loadGatewayModelCatalogSnapshot()
    : undefined;
  const childLogicalEntry = findModelCatalogEntry(childCatalog?.entries ?? [], {
    provider: childModel.provider,
    modelId: childModel.model,
  });
  const childCatalogEntry =
    childLogicalEntry && childCatalog
      ? selectModelCatalogRuntimeEntry({
          entry: childLogicalEntry,
          routeVariants: childCatalog.routeVariants,
          runtimeId: resolveEffectiveAgentRuntimeCore({
            cfg: params.cfg,
            agentId: params.target.agentId,
            provider: childModel.provider,
            modelId: childModel.model,
            sessionKey: params.target.canonicalKey,
            sessionEntry: params.entry,
          }),
        }).entry
      : undefined;
  const childContextWindow = resolveModelContextWindowProfile({
    catalogEntry: childCatalogEntry,
    selected: params.entry.contextWindow,
  });
  const resolvedForkMaxTokens = resolveContextTokensForModel({
    cfg: params.cfg,
    provider: childModel.provider,
    model: childModel.model,
    modelContextTokens: childCatalogEntry?.contextTokens,
    modelContextWindow: childContextWindow.contextTokens,
    allowAsyncLoad: false,
    allowUnscopedModelLookup: false,
  });
  const forkMaxTokens = childContextWindow.contextTokens
    ? Math.min(
        resolvedForkMaxTokens ?? childContextWindow.contextTokens,
        childContextWindow.contextTokens,
      )
    : resolvedForkMaxTokens;
  // The storage owner selects one source for both size admission and copying,
  // so an active tail cannot make a smaller stable prefix fail the cap.
  const forkFromParent = async (assertSourceCurrent?: () => void) =>
    await forkSessionFromParentWithDecision({
      parentEntry: params.parentEntry,
      agentId: params.parentTarget.agentId,
      commitGuard: () => {
        params.commitGuard();
        assertSourceCurrent?.();
      },
      parentSessionKey: params.parentSessionKey,
      sessionKey: params.target.canonicalKey,
      storePath: params.parentTarget.storePath,
      ...(forkMaxTokens ? { maxTokens: forkMaxTokens } : {}),
      // Keep the fork transcript owned by the child store across agent boundaries.
      targetStorePath: params.target.storePath,
      ...(params.forkFrom ? { forkFrom: params.forkFrom } : {}),
    });
  return params.withCommit ? await params.withCommit(forkFromParent) : await forkFromParent();
}
