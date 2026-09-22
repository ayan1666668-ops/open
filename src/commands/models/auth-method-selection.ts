import { pickAuthMethod } from "../../plugins/provider-auth-choice-helpers.js";
import type { ProviderAuthMethod, ProviderPlugin } from "../../plugins/types.js";
import type { WizardPrompter } from "../../wizard/prompts.js";

export function listTokenAuthMethods(provider: ProviderPlugin): ProviderAuthMethod[] {
  return provider.auth.filter((method) => method.kind === "token");
}

export function listProvidersWithTokenMethods(providers: ProviderPlugin[]): ProviderPlugin[] {
  return providers.filter((provider) => listTokenAuthMethods(provider).length > 0);
}

export function assertModelsAuthProviderSelectionIsNonInteractive(params: {
  nonInteractiveCli: boolean;
  requestedProviderId?: string;
  useProviderPicker: boolean;
}): void {
  if (!params.nonInteractiveCli || (params.requestedProviderId && !params.useProviderPicker)) {
    return;
  }
  const selection = params.requestedProviderId
    ? `provider "${params.requestedProviderId}" does not expose a directly selectable OpenClaw auth flow`
    : "--provider is missing";
  throw new Error(
    `models auth login cannot open the provider picker because ${selection} and stdin is not an interactive TTY.`,
  );
}

export async function pickProviderAuthMethod(params: {
  provider: ProviderPlugin;
  requestedMethod?: string;
  prompter: WizardPrompter;
  nonInteractiveCli?: boolean;
}): Promise<ProviderAuthMethod | null> {
  const rawRequestedMethod = params.requestedMethod?.trim();
  if (rawRequestedMethod) {
    return pickAuthMethod(params.provider, rawRequestedMethod);
  }
  const oauthMethod = params.provider.auth.find((method) => method.kind === "oauth");
  if (oauthMethod) {
    return oauthMethod;
  }
  if (params.provider.auth.length === 1) {
    return params.provider.auth[0] ?? null;
  }
  if (params.nonInteractiveCli) {
    throw new Error(
      `models auth login requires --method for ${params.provider.label} when stdin is not an interactive TTY.`,
    );
  }
  return await params.prompter
    .select({
      message: `Auth method for ${params.provider.label}`,
      options: params.provider.auth.map((method) => ({
        value: method.id,
        label: method.label,
        hint: method.hint,
      })),
    })
    .then((id) => params.provider.auth.find((method) => method.id === id) ?? null);
}

function resolveTokenMethodOrThrow(
  provider: ProviderPlugin,
  rawMethod?: string,
): ProviderAuthMethod | null {
  const tokenMethods = listTokenAuthMethods(provider);
  if (rawMethod?.trim()) {
    const matched = pickAuthMethod(provider, rawMethod);
    if (matched && matched.kind === "token") {
      return matched;
    }
    const available = tokenMethods.map((method) => method.id).join(", ") || "(none)";
    throw new Error(
      `Unknown token auth method "${rawMethod}" for provider "${provider.id}". Available token methods: ${available}.`,
    );
  }
  return null;
}

export async function pickProviderTokenMethod(params: {
  provider: ProviderPlugin;
  requestedMethod?: string;
  prompter: WizardPrompter;
}): Promise<ProviderAuthMethod | null> {
  const explicitTokenMethod = resolveTokenMethodOrThrow(params.provider, params.requestedMethod);
  if (explicitTokenMethod) {
    return explicitTokenMethod;
  }
  const tokenMethods = listTokenAuthMethods(params.provider);
  if (tokenMethods.length === 0) {
    return null;
  }
  const setupTokenMethod = tokenMethods.find((method) => method.id === "setup-token");
  if (setupTokenMethod) {
    return setupTokenMethod;
  }
  if (tokenMethods.length === 1) {
    return tokenMethods[0] ?? null;
  }
  return await params.prompter
    .select({
      message: `Token method for ${params.provider.label}`,
      options: tokenMethods.map((method) => ({
        value: method.id,
        label: method.label,
        hint: method.hint,
      })),
    })
    .then((id) => tokenMethods.find((method) => method.id === id) ?? null);
}
