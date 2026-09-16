import { createAbortError, racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { resolvePublishedModelCatalogOwner } from "./prepared-model-catalog-owner.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "./prepared-model-runtime.errors.js";
import type {
  PreparedModelRuntimeOwner,
  PreparedReplyDispatchRuntime,
} from "./prepared-model-runtime.types.js";

function createReplyDispatchRuntime(
  runtimeOwner: PreparedModelRuntimeOwner,
): PreparedReplyDispatchRuntime {
  const snapshot = runtimeOwner.snapshot!;
  const owner = resolvePublishedModelCatalogOwner(snapshot);
  const pluginGeneration = runtimeOwner.pluginGeneration;
  const inboundPluginRegistry = pluginGeneration?.inboundPluginRegistry;
  if (!pluginGeneration || !inboundPluginRegistry) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      `prepared inbound plugin registry was not published for ${snapshot.agentDir}`,
    );
  }
  return Object.freeze({
    agentId: owner.agentId,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
    config: owner.config,
    modelCatalog: owner.modelCatalog,
    readFullModelCatalog: snapshot.readFullModelCatalog,
    inboundPluginRegistry,
    pluginGeneration,
  });
}

type PreparedReplyDispatchPublicationHost = Readonly<{
  getOwners: () => Iterable<PreparedModelRuntimeOwner>;
  isGatewayLifecycleActive: () => boolean;
  getPendingReplacement: () => Promise<void> | undefined;
}>;

/** Reads one immutable configured Gateway dispatch generation without activating an owner. */
export function createGatewayReplyDispatchRuntimeLoader(
  host: PreparedReplyDispatchPublicationHost,
) {
  return async ({
    agentId,
    abortSignal,
  }: {
    agentId: string;
    abortSignal?: AbortSignal;
  }): Promise<PreparedReplyDispatchRuntime | undefined> => {
    for (;;) {
      if (abortSignal?.aborted) {
        throw createAbortError("Prepared reply dispatch admission aborted", {
          cause: abortSignal.reason,
        });
      }
      if (!host.isGatewayLifecycleActive()) {
        return undefined;
      }
      const replacement = host.getPendingReplacement();
      if (replacement) {
        await racePromiseWithAbortSignal(replacement, abortSignal);
        continue;
      }
      const matches = [...host.getOwners()].filter(
        (owner) => owner.provenance === "configured" && owner.input.agentId === agentId,
      );
      if (matches.length !== 1) {
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared reply dispatch runtime owner was not published for ${agentId}`,
        );
      }
      const owner = matches[0]!;
      if (owner.pending) {
        await racePromiseWithAbortSignal(owner.pending, abortSignal);
        continue;
      }
      if (!owner.snapshot || owner.needsRefresh) {
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared reply dispatch runtime owner was not published for ${agentId}`,
          { cause: owner.refreshError },
        );
      }
      return createReplyDispatchRuntime(owner);
    }
  };
}
