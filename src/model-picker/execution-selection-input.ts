import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import {
  buildModelAliasIndex,
  resolveAllowedModelRef,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { prepareSelection } from "./execution-selection-preparation.js";
import type {
  PreparedSessionExecutionSelection,
  PrepareSessionExecutionSelectionParams,
} from "./execution-selection.js";

/** Prepare one accepted pair or one turn-local pair; persistence is an explicit later operation. */
export async function prepareSessionExecutionSelection(
  params: PrepareSessionExecutionSelectionParams,
): Promise<PreparedSessionExecutionSelection> {
  if (!params.modelInput) {
    return prepareSelection(params);
  }
  // Raw-input catalog loading stays lazy so prepared/native choices do not load discovery.
  const { withPreparedModelCatalogOwner } = await import("../agents/prepared-model-catalog.js");
  const input = params.modelInput;
  return withPreparedModelCatalogOwner(
    {
      config: params.cfg,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      readOnly: true,
    },
    (owner) =>
      withPluginRuntimeGenerationScope(owner, async () => {
        const defaults = resolveDefaultModelForAgent({
          cfg: owner.config,
          agentId: params.agentId,
        });
        const options = {
          cfg: owner.config,
          agentId: params.agentId,
          defaultProvider: defaults.provider,
          defaultModel: defaults,
          catalog: owner.modelCatalog.entries,
          manifestPlugins: owner.metadataSnapshot.plugins,
          raw: input.raw,
        };
        const automatic = params.request.kind === "initialize";
        const chosen =
          automatic && input.resolvedRef
            ? { ref: input.resolvedRef }
            : automatic
              ? resolveModelRefFromString({ ...options, aliasIndex: buildModelAliasIndex(options) })
              : resolveAllowedModelRef(options);
        if (!chosen || "error" in chosen) {
          return {
            status: "rejected" as const,
            reason: "not-allowed" as const,
            message: chosen && "error" in chosen ? chosen.error : "Invalid model: " + input.raw,
          };
        }
        const profile = splitTrailingAuthProfile(input.raw).profile;
        const model = { provider: chosen.ref.provider, id: chosen.ref.model };
        const preparedParams: PrepareSessionExecutionSelectionParams = {
          ...params,
          cfg: owner.config,
          workspaceDir: owner.workspaceDir,
          modelCatalog: owner.modelCatalog.entries,
          manifestPlugins: owner.metadataSnapshot.plugins,
          profileProvider: chosen.ref.provider,
          request: automatic ? { kind: "initialize", model } : { kind: "model", model },
        };
        if (profile) {
          preparedParams.sessionEntry = {
            ...preparedParams.sessionEntry,
            authProfileOverride: profile,
            authProfileOverrideSource: automatic ? "auto" : "user",
          };
        }
        return prepareSelection(preparedParams);
      }),
  );
}
