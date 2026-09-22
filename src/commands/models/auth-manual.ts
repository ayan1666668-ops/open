import {
  cancel,
  confirm as clackConfirm,
  isCancel,
  password as clackPassword,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { styleSelectParams } from "../../../packages/terminal-core/src/prompt-select-styled-params.js";
import { stylePromptMessage } from "../../../packages/terminal-core/src/prompt-style.js";
import { upsertAuthProfileWithLockOrThrow } from "../../agents/auth-profiles/profiles.js";
import { normalizeProviderId } from "../../agents/model-ref-shared.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { logConfigUpdated } from "../../config/logging.js";
import { applyAuthProfileConfig } from "../../plugins/provider-auth-helpers.js";
import type { RuntimeEnv } from "../../runtime.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { validateAnthropicSetupToken } from "../auth-token.js";
import { saveModelProviderApiKey } from "./auth-api-key.js";
import {
  resolveModelsAuthAgent,
  resolveModelsAuthContext,
  resolveRequestedProviderOrThrow,
  runProviderAuthMethod,
} from "./auth-flow-shared.js";
import {
  looksLikeOpenAIApiKey,
  normalizeManualAuthProvider,
  resolveDefaultTokenProfileId,
  validateOpenAICodexApiKeyInput,
} from "./auth-manual-input.js";
import {
  listProvidersWithTokenMethods,
  listTokenAuthMethods,
  pickProviderTokenMethod,
} from "./auth-method-selection.js";
import { refreshRunningGatewayAuthState } from "./auth-refresh.js";
import { loadValidConfigSnapshotOrThrow, updateConfig } from "./shared.js";

function resolveManualTokenExpiryMs(expiresIn: string | undefined): number | undefined {
  const normalizedExpiresIn = normalizeStringifiedOptionalString(expiresIn);
  if (!normalizedExpiresIn) {
    return undefined;
  }
  const durationMs = parseDurationMs(normalizedExpiresIn, { defaultUnit: "d" });
  const expires = resolveExpiresAtMsFromDurationMs(durationMs);
  if (expires === undefined) {
    throw new Error("Invalid expiry duration: resulting token expiry is outside Date range.");
  }
  return expires;
}

function guardCancel<T>(value: T | typeof import("@clack/prompts").CANCEL_SYMBOL): T {
  if (typeof value === "symbol" || isCancel(value)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return value;
}

const confirm = async (params: Parameters<typeof clackConfirm>[0]) =>
  guardCancel(
    await clackConfirm({
      ...params,
      message: stylePromptMessage(params.message),
    }),
  );
const text = async (params: Parameters<typeof clackText>[0]) =>
  guardCancel(
    await clackText({
      ...params,
      message: stylePromptMessage(params.message),
    }),
  );
const password = async (params: Parameters<typeof clackPassword>[0]) =>
  guardCancel(
    await clackPassword({
      ...params,
      message: stylePromptMessage(params.message),
    }),
  );
const select = async <T>(params: Parameters<typeof clackSelect<T>>[0]) =>
  guardCancel(await clackSelect(styleSelectParams(params)));

const MODELS_AUTH_STDIN_MAX_BYTES = 1024 * 1024;

async function readPipedStdin(): Promise<string> {
  const bytes = await readByteStreamWithLimit(process.stdin, {
    maxBytes: MODELS_AUTH_STDIN_MAX_BYTES,
    onOverflow: ({ maxBytes }) => new Error(`Piped auth input exceeds ${maxBytes} bytes.`),
  });
  return bytes.toString("utf8");
}

async function readPastedSecret(params: {
  message: string;
  masked: boolean;
  validate?: (value: string | undefined) => string | undefined;
}): Promise<string> {
  const promptParams = { message: params.message, validate: params.validate };
  const input = process.stdin.isTTY
    ? await (params.masked ? password(promptParams) : text(promptParams))
    : await readPipedStdin();
  const normalized = normalizeSecretInput(input);
  const validationMessage = params.validate?.(normalized);
  if (validationMessage) {
    throw new Error(validationMessage);
  }
  return normalized;
}

function isOpenAIProvider(provider: string): boolean {
  return normalizeManualAuthProvider(provider) === "openai";
}

/** Runs an interactive provider setup-token auth flow. */
export async function modelsAuthSetupTokenCommand(
  opts: { provider?: string; yes?: boolean; agent?: string },
  runtime: RuntimeEnv,
) {
  if (!process.stdin.isTTY) {
    throw new Error(
      `setup-token requires an interactive TTY. In automation, use ${formatCliCommand("openclaw models auth paste-token --provider <provider>")} instead.`,
    );
  }

  const { config, configSnapshot, agentId, agentDir, workspaceDir, providers } =
    await resolveModelsAuthContext({
      requestedProvider: opts.provider,
      rawAgentId: opts.agent,
    });
  const tokenProviders = listProvidersWithTokenMethods(providers);
  if (tokenProviders.length === 0) {
    throw new Error(
      `No provider token-auth plugins found. Install one via \`${formatCliCommand("openclaw plugins install")}\`.`,
    );
  }

  const provider =
    resolveRequestedProviderOrThrow(tokenProviders, opts.provider) ?? tokenProviders[0] ?? null;
  if (!provider) {
    throw new Error(
      `No token-capable provider is available. Run ${formatCliCommand("openclaw plugins list")} to verify provider plugins are installed.`,
    );
  }

  if (!opts.yes) {
    const proceed = await confirm({
      message: `Continue with ${provider.label} token auth?`,
      initialValue: true,
    });
    if (!proceed) {
      return;
    }
  }

  const prompter = createClackPrompter();
  const method = await pickProviderTokenMethod({ provider, prompter });
  if (!method) {
    throw new Error(`Provider "${provider.id}" does not expose a token auth method.`);
  }

  await runProviderAuthMethod({
    config,
    configSnapshot,
    agentId,
    agentDir,
    workspaceDir,
    provider,
    method,
    runtime,
    prompter,
  });
}

/** Reads a pasted bearer/setup token and stores it as an auth profile. */
export async function modelsAuthPasteTokenCommand(
  opts: {
    provider?: string;
    profileId?: string;
    expiresIn?: string;
    agent?: string;
  },
  runtime: RuntimeEnv,
) {
  const { agentId, agentDir } = await resolveModelsAuthAgent(opts.agent);
  const rawProvider = normalizeOptionalString(opts.provider);
  if (!rawProvider) {
    throw new Error(
      `Missing --provider. Run ${formatCliCommand("openclaw models status")} or ${formatCliCommand("openclaw plugins list")} to choose a provider.`,
    );
  }
  const provider = normalizeManualAuthProvider(rawProvider);
  const profileId =
    normalizeOptionalString(opts.profileId) || resolveDefaultTokenProfileId(provider);

  const validateTokenInput = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return "Required";
    }
    if (provider === "anthropic") {
      return validateAnthropicSetupToken(trimmed.replaceAll(/\s+/g, ""));
    }
    if (isOpenAIProvider(provider) && looksLikeOpenAIApiKey(trimmed)) {
      return `That looks like an OpenAI API key. Use ${formatCliCommand("openclaw models auth paste-api-key --provider openai")} for API-key auth.`;
    }
    return undefined;
  };
  const tokenInput = await readPastedSecret({
    message: `Paste token for ${provider}`,
    masked: true,
    validate: validateTokenInput,
  });
  const token =
    provider === "anthropic"
      ? tokenInput.replaceAll(/\s+/g, "").trim()
      : (normalizeOptionalString(tokenInput) ?? "");

  const expires = resolveManualTokenExpiryMs(opts.expiresIn);
  await upsertAuthProfileWithLockOrThrow({
    profileId,
    credential: {
      type: "token",
      provider,
      token,
      ...(expires ? { expires } : {}),
    },
    agentDir,
  });
  await updateConfig((cfg) => applyAuthProfileConfig(cfg, { profileId, provider, mode: "token" }));
  await refreshRunningGatewayAuthState(agentId, "login", runtime);

  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (${provider}/token)`);
  if (provider === "anthropic") {
    runtime.log("Anthropic setup-token auth is supported in OpenClaw.");
    runtime.log("OpenClaw prefers Claude CLI reuse when it is available on the host.");
    runtime.log("Anthropic staff told us this OpenClaw path is allowed again.");
  }
}

/** Reads a pasted API key and stores it as an auth profile. */
export async function modelsAuthPasteApiKeyCommand(
  opts: {
    provider?: string;
    profileId?: string;
    agent?: string;
  },
  runtime: RuntimeEnv,
) {
  const config = (await loadValidConfigSnapshotOrThrow()).runtimeConfig;
  const { agentId, agentDir } = await resolveModelsAuthAgent(opts.agent, config);
  const rawProvider = normalizeOptionalString(opts.provider);
  if (!rawProvider) {
    throw new Error(
      `Missing --provider. Run ${formatCliCommand("openclaw models status")} or ${formatCliCommand("openclaw plugins list")} to choose a provider.`,
    );
  }
  const provider = normalizeManualAuthProvider(rawProvider);

  const key = await readPastedSecret({
    message: `Paste API key for ${provider}`,
    masked: true,
    validate: (value) => {
      const trimmed = value?.trim();
      if (!trimmed) {
        return "Required";
      }
      if (isOpenAIProvider(provider)) {
        return validateOpenAICodexApiKeyInput(trimmed);
      }
      return undefined;
    },
  });

  const { profileId, warning } = await saveModelProviderApiKey({
    config,
    provider,
    apiKey: key,
    agentDir,
    profileId: normalizeOptionalString(opts.profileId),
  });
  await refreshRunningGatewayAuthState(agentId, "login", runtime);
  if (warning) {
    runtime.error(warning);
  }

  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (${provider}/api_key)`);
}

/** Interactive helper for adding token auth profiles, with provider/method prompts. */
export async function modelsAuthAddCommand(opts: { agent?: string }, runtime: RuntimeEnv) {
  const { config, configSnapshot, agentId, agentDir, workspaceDir, providers } =
    await resolveModelsAuthContext({
      rawAgentId: opts.agent,
    });
  const tokenProviders = listProvidersWithTokenMethods(providers);

  const provider = await select({
    message: "Token provider",
    options: [
      ...tokenProviders.map((providerPlugin) => ({
        value: providerPlugin.id,
        label: providerPlugin.id,
        hint: providerPlugin.docsPath ? `Docs: ${providerPlugin.docsPath}` : undefined,
      })),
      { value: "custom", label: "custom (type provider id)" },
    ],
  });

  const providerId =
    provider === "custom"
      ? normalizeProviderId(
          await text({
            message: "Provider id",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        )
      : provider;
  const providerPlugin =
    provider === "custom" ? null : resolveRequestedProviderOrThrow(tokenProviders, providerId);
  if (providerPlugin) {
    const tokenMethods = listTokenAuthMethods(providerPlugin);
    const methodId =
      tokenMethods.length > 0
        ? await select({
            message: "Token method",
            options: [
              ...tokenMethods.map((method) => ({
                value: method.id,
                label: method.label,
                hint: method.hint,
              })),
              { value: "paste", label: "paste token" },
            ],
          })
        : "paste";
    if (methodId !== "paste") {
      const prompter = createClackPrompter();
      const method = tokenMethods.find((candidate) => candidate.id === methodId);
      if (!method) {
        throw new Error(
          `Unknown token auth method "${methodId}". Run ${formatCliCommand("openclaw models auth login --provider " + providerPlugin.id)} to choose interactively.`,
        );
      }
      await runProviderAuthMethod({
        config,
        configSnapshot,
        agentId,
        agentDir,
        workspaceDir,
        provider: providerPlugin,
        method,
        runtime,
        prompter,
      });
      return;
    }
  }

  const profileIdDefault = resolveDefaultTokenProfileId(providerId);
  const profileId = (
    await text({
      message: "Profile id",
      initialValue: profileIdDefault,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    })
  ).trim();
  const wantsExpiry = await confirm({
    message: "Does this token expire?",
    initialValue: false,
  });
  const expiresIn = wantsExpiry
    ? (
        await text({
          message: "Expires in (duration)",
          initialValue: "365d",
          validate: (value) => {
            try {
              parseDurationMs(value ?? "", { defaultUnit: "d" });
              return undefined;
            } catch {
              return "Invalid duration (e.g. 365d, 12h, 30m)";
            }
          },
        })
      ).trim()
    : undefined;

  await modelsAuthPasteTokenCommand(
    { provider: providerId, profileId, expiresIn, agent: opts.agent },
    runtime,
  );
}
