import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ThinkLevel } from "../thinking.shared.js";
import type { createModelSelectionState } from "./model-selection.js";

/** Supplies selected-model facts to tests outside the model-selection owner. */
export function createModelSelectionStateFixture(params: {
  agentCfg: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
  provider: string;
  model: string;
  sessionEntry?: Pick<SessionEntry, "executionSelection">;
}): Awaited<ReturnType<typeof createModelSelectionState>> {
  return {
    refreshExecution: async (entry) =>
      createModelSelectionStateFixture({ ...params, sessionEntry: entry }),
    provider: params.provider,
    model: params.model,
    executionSelection: {
      model: { provider: params.provider, id: params.model },
      executor: { kind: "harness", id: "openclaw" },
    },
    sessionExecutionSelection: structuredClone(params.sessionEntry?.executionSelection),
    requestedRouteResolution: "resolved",
    modelPolicy: createModelVisibilityPolicy({
      cfg: { agents: { defaults: params.agentCfg } },
      catalog: [],
      defaultProvider: params.provider,
      defaultModel: { provider: params.provider, model: params.model },
    }),
    allowedModelKeys: new Set<string>(),
    allowedModelCatalog: [],
    policyAliasIndex: { byAlias: new Map(), byKey: new Map() },
    modelPolicyConfigPath: undefined,
    modelPolicyRepairConfigPath: undefined,
    resolveThinkingCatalog: async () => [],
    resolveDefaultThinkingLevel: async () => params.agentCfg?.thinkingDefault as ThinkLevel,
    hasConfiguredThinkingDefault: params.agentCfg?.thinkingDefault !== undefined,
    resolveDefaultReasoningLevel: async () => "off",
    needsModelCatalog: false,
    modelContextWindow: undefined,
    modelContextTokens: undefined,
  };
}
