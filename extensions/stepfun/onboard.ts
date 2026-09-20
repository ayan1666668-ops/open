// Stepfun setup module handles plugin onboarding behavior.
import {
  createModelCatalogPresetAppliers,
  type ModelProviderConfig,
  type OpenClawConfig,
  type ProviderOnboardPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildStepFunPlanProvider,
  buildStepFunProvider,
  STEPFUN_DEFAULT_MODEL_REF,
  STEPFUN_PLAN_CN_BASE_URL,
  STEPFUN_PLAN_DEFAULT_MODEL_REF,
  STEPFUN_PLAN_INTL_BASE_URL,
  STEPFUN_PLAN_PROVIDER_ID,
  STEPFUN_PROVIDER_ID,
  STEPFUN_STANDARD_CN_BASE_URL,
  STEPFUN_STANDARD_INTL_BASE_URL,
} from "./provider-catalog.js";

function createStepFunPresetAppliers(params: {
  providerId: string;
  primaryModelRef: string;
  alias: string;
  buildProvider: (baseUrl: string) => ModelProviderConfig;
}): ProviderOnboardPresetAppliers<[string]> {
  return createModelCatalogPresetAppliers<[string]>({
    primaryModelRef: params.primaryModelRef,
    resolveParams: (cfg: OpenClawConfig, baseUrl: string) => {
      const provider = params.buildProvider(baseUrl);
      const models = provider.models ?? [];
      // A prior onboarding run bound the shared alias (e.g. "StepFun") to the
      // then-current default. Re-binding it to a new default would leave two
      // model refs claiming the alias, and last-wins resolution would silently
      // redirect it off the model the user's config still points at. Only claim
      // the alias for the new default when no other ref already owns it.
      const aliasKey = params.alias.toLowerCase();
      const primaryKey = params.primaryModelRef.toLowerCase();
      const aliasOwnedByOtherModel = Object.entries(cfg.agents?.defaults?.models ?? {}).some(
        ([ref, entry]) =>
          typeof entry?.alias === "string" &&
          entry.alias.toLowerCase() === aliasKey &&
          ref.toLowerCase() !== primaryKey,
      );
      return {
        providerId: params.providerId,
        api: provider.api ?? "openai-completions",
        baseUrl,
        catalogModels: cfg.models?.mode === "replace" ? models : [],
        aliases: [
          ...models.map((model) => `${params.providerId}/${model.id}`),
          ...(aliasOwnedByOtherModel
            ? []
            : [{ modelRef: params.primaryModelRef, alias: params.alias }]),
        ],
      };
    },
  });
}

const stepFunPresetAppliers = createStepFunPresetAppliers({
  providerId: STEPFUN_PROVIDER_ID,
  primaryModelRef: STEPFUN_DEFAULT_MODEL_REF,
  alias: "StepFun",
  buildProvider: buildStepFunProvider,
});

const stepFunPlanPresetAppliers = createStepFunPresetAppliers({
  providerId: STEPFUN_PLAN_PROVIDER_ID,
  primaryModelRef: STEPFUN_PLAN_DEFAULT_MODEL_REF,
  alias: "StepFun Plan",
  buildProvider: buildStepFunPlanProvider,
});

export function applyStepFunStandardConfigCn(cfg: OpenClawConfig): OpenClawConfig {
  return stepFunPresetAppliers.applyConfig(cfg, STEPFUN_STANDARD_CN_BASE_URL);
}

export function applyStepFunStandardConfig(cfg: OpenClawConfig): OpenClawConfig {
  return stepFunPresetAppliers.applyConfig(cfg, STEPFUN_STANDARD_INTL_BASE_URL);
}

export function applyStepFunPlanConfigCn(cfg: OpenClawConfig): OpenClawConfig {
  return stepFunPlanPresetAppliers.applyConfig(cfg, STEPFUN_PLAN_CN_BASE_URL);
}

export function applyStepFunPlanConfig(cfg: OpenClawConfig): OpenClawConfig {
  return stepFunPlanPresetAppliers.applyConfig(cfg, STEPFUN_PLAN_INTL_BASE_URL);
}
