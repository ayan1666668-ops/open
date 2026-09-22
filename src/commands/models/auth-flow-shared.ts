import { expectDefined } from "@openclaw/normalization-core";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { promoteAuthProfileInOrder } from "../../agents/auth-profiles/profiles.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { normalizeProviderId } from "../../agents/model-ref-shared.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { logConfigUpdated } from "../../config/logging.js";
import { normalizeAgentModelRefForConfig } from "../../config/model-input.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.openclaw.js";
import {
  applyDefaultModel,
  applyProviderAuthConfigPatch,
  restorePriorAgentsDefaultsModelUnlessOptIn,
  resolveProviderMatch,
} from "../../plugins/provider-auth-choice-helpers.js";
import {
  createProviderAuthConfigPatch,
  writeProviderAuthConfig,
} from "../../plugins/provider-auth-config.js";
import { runProviderPluginAuthMethodUnpersisted } from "../../plugins/provider-auth-method.js";
import { persistProviderAuthProfilesAfterLogin } from "../../plugins/provider-auth-persistence.js";
import type { ProviderAuthContext } from "../../plugins/provider-authentication.types.js";
import { resolvePluginProvidersCore } from "../../plugins/providers.runtime.js";
import {
  resolvePluginSetupProviderCore,
  resolvePluginSetupRegistry,
} from "../../plugins/setup-registry.js";
import type {
  ProviderAuthMethod,
  ProviderAuthResult,
  ProviderPlugin,
} from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  ProviderAuthConfigApplyError,
  ProviderCredentialsSavedError,
} from "../../shared/provider-auth-result.js";
import { isRecord } from "../../utils.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { repairCodexRuntimePluginInstallForModelSelection } from "../codex-runtime-plugin-install.js";
import { repairCopilotRuntimePluginInstallForModelSelection } from "../copilot-runtime-plugin-install.js";
import { normalizeManualAuthProvider } from "./auth-manual-input.js";
import {
  applyProviderLoginDefaultModel,
  completeProviderModelAccess,
  prepareProviderModelAccess,
  withoutProviderModelPolicy,
  type PreparedProviderModelAccess,
} from "./auth-model-policy.js";
import { refreshRunningGatewayAuthState, type ModelAuthRefreshOutcome } from "./auth-refresh.js";
import { loadValidConfigSnapshotOrThrow, resolveModelsTargetAgent } from "./shared.js";

export type ResolvedModelsAuthContext = {
  config: OpenClawConfig;
  configSnapshot: ConfigFileSnapshot;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  providers: ProviderPlugin[];
};

export type ProviderAuthRefreshAfterLogin = (agentId: string) => Promise<void>;

export function listProvidersWithAuthMethods(providers: ProviderPlugin[]): ProviderPlugin[] {
  return providers.filter((provider) => provider.auth.length > 0);
}

function mergeSetupProviders(
  providers: readonly ProviderPlugin[],
  setupProviders: readonly ProviderPlugin[],
): ProviderPlugin[] {
  if (setupProviders.length === 0) {
    return [...providers];
  }
  const setupById = new Map(
    setupProviders.map((provider) => [normalizeProviderId(provider.id), provider] as const),
  );
  const merged = providers.map(
    (provider) => setupById.get(normalizeProviderId(provider.id)) ?? provider,
  );
  const existing = new Set(merged.map((provider) => normalizeProviderId(provider.id)));
  for (const provider of setupProviders) {
    if (!existing.has(normalizeProviderId(provider.id))) {
      merged.push(provider);
    }
  }
  return merged;
}

function preferSetupAuthProviders(params: {
  providers: readonly ProviderPlugin[];
  config: OpenClawConfig;
  workspaceDir: string;
  requestedProvider?: string;
  ownerPluginId?: string;
}): ProviderPlugin[] {
  if (params.ownerPluginId) {
    return mergeSetupProviders(
      params.providers,
      resolvePluginSetupRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        pluginIds: [params.ownerPluginId],
      }).providers.map((entry) => entry.provider),
    );
  }
  const requestedProvider = params.requestedProvider
    ? normalizeManualAuthProvider(params.requestedProvider)
    : undefined;
  if (requestedProvider) {
    const setupProvider = resolvePluginSetupProviderCore({
      provider: requestedProvider,
      config: params.config,
      workspaceDir: params.workspaceDir,
    });
    return setupProvider ? [setupProvider] : [...params.providers];
  }

  const setupProviders = resolvePluginSetupRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
  }).providers.map((entry) => entry.provider);
  return mergeSetupProviders(params.providers, setupProviders);
}

export async function resolveModelsAuthContext(params?: {
  requestedProvider?: string;
  rawAgentId?: string | null;
  config?: OpenClawConfig;
  ownerPluginId?: string;
}): Promise<ResolvedModelsAuthContext> {
  const configSnapshot = await loadValidConfigSnapshotOrThrow();
  const config = params?.config ?? configSnapshot.runtimeConfig;
  const { agentId, agentDir } = await resolveModelsAuthAgent(params?.rawAgentId, config);
  const workspaceDir =
    resolveAgentWorkspaceDir(config, agentId) ?? resolveDefaultAgentWorkspaceDir();
  const requestedProvider = params?.requestedProvider?.trim();
  const providerRef = requestedProvider
    ? normalizeManualAuthProvider(requestedProvider)
    : undefined;
  // Auth setup also runs inside the Gateway; discovery must not replace its live registry.
  const providers = resolvePluginProvidersCore({
    config,
    workspaceDir,
    mode: "setup",
    includeUntrustedWorkspacePlugins: false,
    ...(params?.ownerPluginId ? { onlyPluginIds: [params.ownerPluginId] } : {}),
    ...(providerRef ? { providerRefs: [providerRef] } : {}),
  });
  const authProviders = preferSetupAuthProviders({
    providers,
    config,
    workspaceDir,
    requestedProvider: providerRef,
    ownerPluginId: params?.ownerPluginId,
  });
  return {
    config,
    configSnapshot,
    agentId,
    agentDir,
    workspaceDir,
    providers: authProviders,
  };
}

export async function resolveModelsAuthAgent(rawAgentId?: string | null, config?: OpenClawConfig) {
  const cfg = config ?? (await loadValidConfigSnapshotOrThrow()).runtimeConfig;
  return resolveModelsTargetAgent(cfg, rawAgentId ?? undefined, { kind: "mutation" });
}

export function resolveRequestedProviderOrThrow(
  providers: ProviderPlugin[],
  rawProvider?: string,
): ProviderPlugin | null {
  const requested = rawProvider?.trim();
  if (!requested) {
    return null;
  }
  const matched = resolveProviderMatch(providers, requested);
  if (matched) {
    return matched;
  }
  const available = providers
    .map((provider) => provider.id)
    .filter(Boolean)
    .toSorted((a, b) => a.localeCompare(b));
  const availableText = available.length > 0 ? available.join(", ") : "(none)";
  throw new Error(
    `Unknown provider "${requested}". Loaded providers: ${availableText}. Verify plugins via \`${formatCliCommand("openclaw plugins list --json")}\`.`,
  );
}

export async function refreshProviderAuthAfterLogin(params: {
  refreshAfterLogin?: ProviderAuthRefreshAfterLogin;
  runtime: RuntimeEnv;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  agentId: string;
}): Promise<ModelAuthRefreshOutcome> {
  if (!params.refreshAfterLogin) {
    return refreshRunningGatewayAuthState(params.agentId, "login", params.runtime);
  }
  try {
    await params.refreshAfterLogin(params.agentId);
    return "refreshed";
  } catch {
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
    return "gateway-rejected";
  }
}

function credentialMode(credential: AuthProfileCredential): "api_key" | "oauth" | "token" {
  if (credential.type === "api_key") {
    return "api_key";
  }
  if (credential.type === "token") {
    return "token";
  }
  return "oauth";
}

function resolveLoginProfiles(params: {
  result: ProviderAuthResult;
  requestedProfileId?: string;
}): ProviderAuthResult["profiles"] {
  const requestedProfileId = params.requestedProfileId?.trim();
  if (!requestedProfileId) {
    return params.result.profiles;
  }
  if (params.result.profiles.length !== 1) {
    throw new Error(
      "--profile-id requires exactly one returned auth profile from the selected auth method.",
    );
  }
  const [profile] = params.result.profiles;
  return [{ ...expectDefined(profile, "auth profile"), profileId: requestedProfileId }];
}

function resolveConfiguredAuthSelectionForProvider(
  cfg: OpenClawConfig,
  provider: string,
): { createIfMissing: boolean; order?: string[] } {
  const providerAuthKey = resolveProviderIdForAuth(provider, { config: cfg });
  for (const [orderProvider, profileIds] of Object.entries(cfg.auth?.order ?? {})) {
    if (
      profileIds.length > 0 &&
      resolveProviderIdForAuth(orderProvider, { config: cfg }) === providerAuthKey
    ) {
      return { createIfMissing: true, order: profileIds };
    }
  }
  const profileIds = Object.entries(cfg.auth?.profiles ?? {})
    .filter(
      ([, profile]) =>
        resolveProviderIdForAuth(profile.provider, { config: cfg, storedCredential: true }) ===
        providerAuthKey,
    )
    .map(([profileId]) => profileId);
  return profileIds.length > 0
    ? { createIfMissing: true, order: profileIds }
    : { createIfMissing: false };
}

export async function promotePersistedAuthProfile(params: {
  config: OpenClawConfig;
  agentDir: string;
  provider: string;
  profileId: string;
}): Promise<void> {
  const selection = resolveConfiguredAuthSelectionForProvider(params.config, params.provider);
  const promotion = await promoteAuthProfileInOrder({
    agentDir: params.agentDir,
    provider: params.provider,
    profileId: params.profileId,
    createIfMissing: selection.createIfMissing,
    ...(selection.order ? { createFromOrder: selection.order } : {}),
  });
  if (!promotion.ok) {
    throw new ProviderCredentialsSavedError(
      "The auth profile was saved, but its order could not be updated because the auth store is busy. Wait a moment, then retry the login.",
    );
  }
}

async function persistProviderAuthResult(params: {
  result: ProviderAuthResult;
  profiles?: ProviderAuthResult["profiles"];
  config: OpenClawConfig;
  configSnapshot: ConfigFileSnapshot;
  agentId: string;
  agentDir: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  setDefault?: boolean;
  env?: NodeJS.ProcessEnv;
  beforePersistentEffect?: () => void | Promise<void>;
  assertCurrent?: () => void;
  signal?: AbortSignal;
  refreshAfterLogin?: ProviderAuthRefreshAfterLogin;
}): Promise<{ profiles: ProviderAuthResult["profiles"]; authRefresh: ModelAuthRefreshOutcome }> {
  const defaultModel = params.result.defaultModel
    ? normalizeAgentModelRefForConfig(params.result.defaultModel)
    : undefined;
  const profiles = params.profiles ?? params.result.profiles;
  const persistedProfiles: ProviderAuthResult["profiles"] = [];
  const loginConfig = applyProviderAuthConfigPatch(params.config, {});
  const configPatch = params.result.configPatch
    ? createProviderAuthConfigPatch(
        loginConfig,
        restorePriorAgentsDefaultsModelUnlessOptIn({
          cfg: applyProviderAuthConfigPatch(
            loginConfig,
            profiles.length > 0
              ? withoutProviderModelPolicy(params.result.configPatch, loginConfig)
              : params.result.configPatch,
            { replaceDefaultModels: params.result.replaceDefaultModels },
          ),
          priorAgentsDefaultsModel: loginConfig.agents?.defaults?.model,
          setDefault: params.setDefault,
        }),
      )
    : undefined;
  const shouldUpdateConfig =
    (isRecord(configPatch) && Object.keys(configPatch).length > 0) ||
    Boolean(params.setDefault && defaultModel);
  if (profiles.length > 0 || shouldUpdateConfig) {
    await params.beforePersistentEffect?.();
  }

  try {
    for (const candidate of profiles) {
      const persisted = await persistProviderAuthProfilesAfterLogin({
        profiles: [candidate],
        beforeWrite: params.assertCurrent,
        config: params.config,
        env: params.env,
        agentDir: params.agentDir,
        ...(params.env?.OPENCLAW_STATE_DIR ? { stateDir: params.env.OPENCLAW_STATE_DIR } : {}),
      });
      const profile = expectDefined(persisted[0], "persisted auth profile");
      persistedProfiles.push(profile);
      params.assertCurrent?.();
      await promotePersistedAuthProfile({
        config: params.config,
        agentDir: params.agentDir,
        provider: profile.credential.provider,
        profileId: profile.profileId,
      });
    }

    if (shouldUpdateConfig) {
      const updated = await writeProviderAuthConfig({
        config: params.config,
        configSnapshot: params.configSnapshot,
        configPatch,
        credentialsSaved: persistedProfiles.length > 0,
        writeOptions: { assertCurrent: params.assertCurrent },
        finalizeConfig: (replayed, cfg) => {
          const priorAgentsDefaultsModel = cfg.agents?.defaults?.model;
          const next = restorePriorAgentsDefaultsModelUnlessOptIn({
            cfg: replayed,
            priorAgentsDefaultsModel,
            setDefault: params.setDefault,
          });
          if (params.setDefault && defaultModel) {
            return profiles.length > 0
              ? applyProviderLoginDefaultModel(next, defaultModel)
              : applyDefaultModel(next, defaultModel);
          }
          return next;
        },
      });
      if (defaultModel) {
        const repaired = await repairCodexRuntimePluginInstallForModelSelection({
          cfg: updated,
          model: defaultModel,
        });
        const copilotRepaired = await repairCopilotRuntimePluginInstallForModelSelection({
          cfg: updated,
          model: defaultModel,
        });
        for (const warning of [...repaired.warnings, ...copilotRepaired.warnings]) {
          params.runtime.error?.(warning);
        }
      }
      logConfigUpdated(params.runtime);
    }

    const authRefresh = await refreshProviderAuthAfterLogin(params);
    for (const profile of persistedProfiles) {
      params.runtime.log(
        `Auth profile: ${profile.profileId} (${profile.credential.provider}/${credentialMode(profile.credential)})`,
      );
    }
    if (defaultModel) {
      params.runtime.log(
        params.setDefault
          ? `Default model set to ${defaultModel}`
          : `Default model available: ${defaultModel} (current default unchanged; run ${formatCliCommand(`openclaw models set ${defaultModel}`)} to apply)`,
      );
    }
    if (params.result.notes && params.result.notes.length > 0) {
      await params.prompter.note(params.result.notes.join("\n"), "Provider notes");
    }
    return { profiles: persistedProfiles, authRefresh };
  } catch (error) {
    if (persistedProfiles.length > 0 && !(error instanceof ProviderCredentialsSavedError)) {
      throw new ProviderCredentialsSavedError(
        error instanceof Error
          ? `Provider credentials were saved, but sign-in did not finish: ${error.message}`
          : "Provider credentials were saved, but sign-in did not finish.",
        { cause: error },
      );
    }
    throw error;
  }
}

export async function runProviderAuthMethod(params: {
  config: OpenClawConfig;
  configSnapshot: ConfigFileSnapshot;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  provider: ProviderPlugin;
  method: ProviderAuthMethod;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  profileId?: string;
  setDefault?: boolean;
  credentialOnly?: boolean;
  assertCurrent?: () => void;
  env?: NodeJS.ProcessEnv;
  isRemote?: boolean;
  signal?: AbortSignal;
  openUrl?: (url: string) => Promise<void>;
  browserAuthorization?: ProviderAuthContext["oauth"]["authorize"];
  beforePersistentEffect?: () => void | Promise<void>;
  refreshAfterLogin?: ProviderAuthRefreshAfterLogin;
  onModelAccessRequested?: (request: PreparedProviderModelAccess) => void;
  keepModelRestrictions?: boolean;
}): Promise<{
  result: ProviderAuthResult;
  profiles: ProviderAuthResult["profiles"];
  authRefresh: ModelAuthRefreshOutcome;
}> {
  params.signal?.throwIfAborted();
  params.assertCurrent?.();
  const modelAccess = prepareProviderModelAccess({
    config: params.config,
    agentId: params.agentId,
    provider: params.provider.id,
    providerLabel: params.provider.label,
  });
  const result = await runProviderPluginAuthMethodUnpersisted({
    method: params.method,
    config: params.config,
    credentialOnly: params.credentialOnly,
    assertCurrent: params.assertCurrent,
    env: params.env ?? process.env,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    prompter: params.prompter,
    runtime: params.runtime,
    allowSecretRefPrompt: false,
    isRemote: params.isRemote,
    signal: params.signal,
    openUrl: params.openUrl,
    browserAuthorization: params.browserAuthorization,
  });
  params.signal?.throwIfAborted();
  const connectionResult = params.credentialOnly
    ? {
        profiles: result.profiles,
        notes: result.notes,
        ...(result.configPatch
          ? {
              configPatch: {
                ...(result.configPatch.models?.providers
                  ? { models: { providers: result.configPatch.models.providers } }
                  : {}),
                ...(result.configPatch.plugins ? { plugins: result.configPatch.plugins } : {}),
              },
            }
          : {}),
      }
    : result;
  const profiles = resolveLoginProfiles({
    result: connectionResult,
    requestedProfileId: params.profileId,
  });
  const { profiles: persistedProfiles, authRefresh } = await persistProviderAuthResult({
    result: connectionResult,
    profiles,
    assertCurrent: params.assertCurrent,
    signal: params.signal,
    config: params.config,
    configSnapshot: params.configSnapshot,
    agentId: params.agentId,
    agentDir: params.agentDir,
    runtime: params.runtime,
    prompter: params.prompter,
    setDefault: params.setDefault,
    env: params.env ?? process.env,
    beforePersistentEffect: params.beforePersistentEffect,
    refreshAfterLogin: params.refreshAfterLogin,
  });
  if (persistedProfiles.length > 0) {
    await completeProviderModelAccess({
      prepared: modelAccess,
      prompter: params.prompter,
      onRequested: params.onModelAccessRequested,
      mode: params.keepModelRestrictions ? "keep" : "prompt",
      runtime: params.runtime,
      assertCurrent: () => {
        params.signal?.throwIfAborted();
        params.assertCurrent?.();
      },
    }).catch((error: unknown) => {
      throw new ProviderAuthConfigApplyError(error);
    });
  }
  return { result: connectionResult, profiles: persistedProfiles, authRefresh };
}

export { credentialMode };
