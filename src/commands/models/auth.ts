/** Commands for logging into provider model auth profiles. */
import { removeProviderAuthProfilesWithLock } from "../../agents/auth-profiles.js";
import { isCliProvider } from "../../agents/model-selection-cli.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { logConfigUpdated } from "../../config/logging.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveProviderMatch } from "../../plugins/provider-auth-choice-helpers.js";
import type { ProviderAuthContext } from "../../plugins/provider-authentication.types.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { ProviderAuthConfigApplyError } from "../../shared/provider-auth-result.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { tryImportProviderCredential } from "./auth-credential-import.js";
import {
  credentialMode,
  listProvidersWithAuthMethods,
  promotePersistedAuthProfile,
  refreshProviderAuthAfterLogin,
  resolveModelsAuthContext,
  resolveRequestedProviderOrThrow,
  runProviderAuthMethod,
  type ProviderAuthRefreshAfterLogin,
} from "./auth-flow-shared.js";
import { normalizeManualAuthProvider } from "./auth-manual-input.js";
import {
  assertModelsAuthProviderSelectionIsNonInteractive,
  pickProviderAuthMethod,
} from "./auth-method-selection.js";
import {
  completeProviderModelAccess,
  prepareProviderModelAccess,
  type PreparedProviderModelAccess,
} from "./auth-model-policy.js";
import { refreshRunningGatewayAuthState, type ModelAuthRefreshOutcome } from "./auth-refresh.js";

export {
  modelsAuthAddCommand,
  modelsAuthPasteApiKeyCommand,
  modelsAuthPasteTokenCommand,
  modelsAuthSetupTokenCommand,
} from "./auth-manual.js";

type LoginOptions = {
  provider?: string;
  method?: string;
  profileId?: string;
  setDefault?: boolean;
  yes?: boolean;
  agent?: string;
  /**
   * When true, remove any existing auth profiles for the resolved provider
   * before invoking the auth flow. This is the escape hatch for stuck
   * cached OAuth profiles where the standard `auth login` short-circuits
   * because credentials already exist on disk.
   */
  force?: boolean;
};

export type ModelsAuthLoginFlowResult = {
  providerId: string;
  methodId: string;
  authRefresh: ModelAuthRefreshOutcome;
  defaultModel?: string;
  imported?: boolean;
  profiles: Array<{
    profileId: string;
    provider: string;
    mode: "api_key" | "oauth" | "token";
  }>;
};

export type ModelsAuthLoginFlowOptions = LoginOptions & {
  ownerPluginId?: string;
  credentialOnly?: boolean;
  assertCurrent?: () => void;
  config?: OpenClawConfig;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  onModelAccessRequested?: (request: PreparedProviderModelAccess) => void;
  env?: NodeJS.ProcessEnv;
  isRemote?: boolean;
  signal?: AbortSignal;
  openUrl?: (url: string) => Promise<void>;
  browserAuthorization?: ProviderAuthContext["oauth"]["authorize"];
  beforePersistentEffect?: () => void | Promise<void>;
  /** Publish a hosted login through its current Gateway instead of a separate CLI connection. */
  refreshAfterLogin?: ProviderAuthRefreshAfterLogin;
};

/** Resolves a requested login provider or throws with available provider details. */
export function resolveRequestedLoginProviderOrThrow(
  providers: ProviderPlugin[],
  rawProvider?: string,
): ProviderPlugin | null {
  return resolveRequestedProviderOrThrow(providers, rawProvider);
}

function maybeLogOpenAICodexNativeSearchTip(runtime: RuntimeEnv, providerId: string) {
  if (providerId !== "openai") {
    return;
  }
  runtime.log(
    `Tip: Codex-capable models can use native Codex web search. Configure the \`web_search\` tool with \`${formatCliCommand("openclaw configure --section web")}\`. Docs: https://docs.openclaw.ai/tools/web`,
  );
}

export async function runModelsAuthLoginFlowCore(
  opts: ModelsAuthLoginFlowOptions,
): Promise<ModelsAuthLoginFlowResult> {
  // The shared core is also used by Gateway and browser-auth callers. The
  // CLI wrapper is the owner of the interactive-terminal admission policy.
  return runModelsAuthLoginFlow(opts, "core");
}

export async function runModelsAuthLoginFlowForGateway(
  opts: ModelsAuthLoginFlowOptions,
): Promise<ModelsAuthLoginFlowResult> {
  return runModelsAuthLoginFlow(opts, "gateway");
}

async function runModelsAuthLoginFlow(
  opts: ModelsAuthLoginFlowOptions,
  entrypoint: "core" | "gateway" | "cli",
): Promise<ModelsAuthLoginFlowResult> {
  const requestedProviderId = opts.provider
    ? normalizeManualAuthProvider(opts.provider)
    : undefined;
  let context = await resolveModelsAuthContext({
    requestedProvider: requestedProviderId,
    rawAgentId: opts.agent,
    config: opts.config,
    ownerPluginId: opts.ownerPluginId,
  });
  const prompter = opts.prompter;
  let authProviders = listProvidersWithAuthMethods(context.providers);
  let requestedProvider = requestedProviderId
    ? resolveProviderMatch(authProviders, requestedProviderId)
    : null;
  const useProviderPicker =
    !opts.ownerPluginId &&
    requestedProviderId !== undefined &&
    requestedProvider === null &&
    isCliProvider(requestedProviderId, context.config);
  const nonInteractiveCli = entrypoint === "cli" && !process.stdin.isTTY;
  assertModelsAuthProviderSelectionIsNonInteractive({
    nonInteractiveCli,
    requestedProviderId,
    useProviderPicker,
  });
  if (useProviderPicker) {
    context = await resolveModelsAuthContext({
      rawAgentId: opts.agent,
      config: context.config,
    });
    authProviders = listProvidersWithAuthMethods(context.providers);
  }
  if (authProviders.length === 0) {
    throw new Error(
      `No provider plugins found. Install one via \`${formatCliCommand("openclaw plugins install")}\`.`,
    );
  }
  if (useProviderPicker) {
    await prompter.note(
      `Provider "${requestedProviderId}" uses its own CLI login. Select a provider with an OpenClaw auth flow.`,
      "Provider auth",
    );
  } else if (requestedProviderId && !requestedProvider) {
    requestedProvider = resolveRequestedLoginProviderOrThrow(authProviders, requestedProviderId);
  }
  if (entrypoint !== "gateway") {
    await prompter.note(
      [
        "Scope: System / agent",
        `Agent: ${context.agentId}`,
        "Location: the machine running OpenClaw",
        `For personal model accounts on a Gateway, run ${formatCliCommand("openclaw models accounts login --help")}.`,
      ].join("\n"),
      "Provider sign-in",
    );
  }
  const selectedProvider =
    requestedProvider ??
    (await prompter
      .select({
        message: "Select a provider",
        options: authProviders.map((provider) => ({
          value: provider.id,
          label: provider.label,
          hint: provider.docsPath ? `Docs: ${provider.docsPath}` : undefined,
        })),
      })
      .then((id) => resolveProviderMatch(authProviders, id)));

  if (!selectedProvider) {
    throw new Error(
      `Unknown provider. Run ${formatCliCommand("openclaw models status")} or ${formatCliCommand("openclaw plugins list")} to see available provider plugins.`,
    );
  }
  if (opts.ownerPluginId && selectedProvider.id !== opts.provider) {
    throw new Error("The selected provider login is no longer available.");
  }

  const chosenMethod = opts.ownerPluginId
    ? selectedProvider.auth.find((method) => method.id === opts.method)
    : await pickProviderAuthMethod({
        provider: selectedProvider,
        requestedMethod: opts.method,
        prompter,
        nonInteractiveCli,
      });
  if (!chosenMethod) {
    throw new Error(
      `Unknown auth method. Run ${formatCliCommand("openclaw models auth login --provider " + selectedProvider.id)} without --method to choose interactively.`,
    );
  }
  if (nonInteractiveCli && chosenMethod.headless !== true) {
    throw new Error(
      `models auth login requires an interactive TTY for ${chosenMethod.label}. In automation, use ${formatCliCommand("openclaw models auth paste-token --provider <provider>")} when token auth is available, or select a provider-owned headless method.`,
    );
  }

  const modelAccess = prepareProviderModelAccess({
    config: context.config,
    agentId: context.agentId,
    provider: selectedProvider.id,
    providerLabel: selectedProvider.label,
  });
  const imported =
    !opts.credentialOnly && !opts.force && !opts.profileId && !opts.setDefault
      ? await tryImportProviderCredential({
          method: chosenMethod,
          providerId: selectedProvider.id,
          config: context.config,
          agentId: context.agentId,
          runtime: opts.runtime,
          signal: opts.signal,
          beforePersistentEffect: opts.beforePersistentEffect,
        })
      : undefined;
  if (imported && "unavailableReason" in imported) {
    await prompter.note(imported.unavailableReason, "Existing CLI sign-in");
  } else if (imported) {
    await promotePersistedAuthProfile({
      config: context.config,
      agentDir: context.agentDir,
      provider: imported.provider,
      profileId: imported.profileId,
    });
    const authRefresh = await refreshProviderAuthAfterLogin({ ...opts, agentId: context.agentId });
    if (imported.configUpdated) {
      logConfigUpdated(opts.runtime);
    }
    opts.runtime.log(
      `Auth profile: ${imported.profileId} (${imported.provider}/${imported.mode}, imported)`,
    );
    await completeProviderModelAccess({
      prepared: modelAccess,
      prompter,
      mode: nonInteractiveCli ? "keep" : "prompt",
      onRequested: opts.onModelAccessRequested,
      runtime: opts.runtime,
      assertCurrent: () => {
        opts.signal?.throwIfAborted();
        opts.assertCurrent?.();
      },
    }).catch((error: unknown) => {
      throw new ProviderAuthConfigApplyError(error);
    });
    return {
      providerId: selectedProvider.id,
      methodId: chosenMethod.id,
      authRefresh,
      imported: true,
      profiles: [
        { profileId: imported.profileId, provider: imported.provider, mode: imported.mode },
      ],
    };
  }

  if (opts.force) {
    await opts.beforePersistentEffect?.();
    // Validate the provider and method before removing any working credentials.
    try {
      const clearedStore = await removeProviderAuthProfilesWithLock({
        cfg: context.config,
        provider: selectedProvider.id,
        agentDir: context.agentDir,
      });
      if (!clearedStore) {
        throw new Error(
          "auth store is busy; close other OpenClaw commands using this state directory and retry",
        );
      }
      opts.runtime.log(
        `Removed cached auth profiles for provider "${selectedProvider.id}" (--force). Running fresh auth flow.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not clear cached profiles for "${selectedProvider.id}" before re-login: ${message}. Re-login was not started because --force must remove cached profiles first.`,
        { cause: err },
      );
    }
    await refreshRunningGatewayAuthState(context.agentId, "logout", opts.runtime);
  }

  const { result, profiles, authRefresh } = await runProviderAuthMethod({
    config: context.config,
    configSnapshot: context.configSnapshot,
    agentId: context.agentId,
    agentDir: context.agentDir,
    workspaceDir: context.workspaceDir,
    provider: selectedProvider,
    method: chosenMethod,
    runtime: opts.runtime,
    prompter,
    profileId: opts.profileId,
    setDefault: opts.setDefault,
    credentialOnly: opts.credentialOnly,
    assertCurrent: opts.assertCurrent,
    env: opts.env,
    isRemote: opts.isRemote,
    signal: opts.signal,
    openUrl: opts.openUrl,
    browserAuthorization: opts.browserAuthorization,
    beforePersistentEffect: opts.beforePersistentEffect,
    refreshAfterLogin: opts.refreshAfterLogin,
    onModelAccessRequested: opts.onModelAccessRequested,
    keepModelRestrictions: nonInteractiveCli,
  });
  maybeLogOpenAICodexNativeSearchTip(opts.runtime, selectedProvider.id);
  return {
    providerId: selectedProvider.id,
    methodId: chosenMethod.id,
    authRefresh,
    ...(result.defaultModel ? { defaultModel: result.defaultModel } : {}),
    profiles: profiles.map((profile) => ({
      profileId: profile.profileId,
      provider: profile.credential.provider,
      mode: credentialMode(profile.credential),
    })),
  };
}

export async function modelsAuthLoginCommand(opts: LoginOptions, runtime: RuntimeEnv) {
  // Only the CLI owns the TTY policy; shared callers may run through a browser or Gateway.
  const cliOpts = { ...opts, runtime, prompter: createClackPrompter() };
  await runModelsAuthLoginFlow(cliOpts, "cli");
}
