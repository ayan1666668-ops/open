import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "../copilot-dynamic-headers.js";
import type { AgentMessage } from "../runtime/index.js";
import type { ExtensionContext } from "../sessions/index.js";

const log = createSubsystemLogger("compaction-safeguard");
const DEFAULT_RECENT_TURNS_PRESERVE = 3;
const DEFAULT_QUALITY_GUARD_MAX_RETRIES = 1;
const MAX_RECENT_TURNS_PRESERVE = 12;
const MAX_QUALITY_GUARD_MAX_RETRIES = 3;

type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string> }
  | { ok: false; error: string };

type ModelRegistryWithRequestAuthLookup = {
  getApiKeyAndHeaders?: (
    model: NonNullable<ExtensionContext["model"]>,
  ) => Promise<ResolvedRequestAuth>;
};

export async function resolveModelAuth(
  ctx: ExtensionContext,
  model: NonNullable<ExtensionContext["model"]>,
): Promise<
  { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; reason: string }
> {
  let requestAuth: ResolvedRequestAuth;
  try {
    // SAFETY: the runtime model registry supports this optional compatibility method when present.
    const modelRegistry = ctx.modelRegistry as ModelRegistryWithRequestAuthLookup;
    if (typeof modelRegistry.getApiKeyAndHeaders !== "function") {
      throw new Error("model registry auth lookup unavailable");
    }
    requestAuth = await modelRegistry.getApiKeyAndHeaders(model);
  } catch (err) {
    const error = formatErrorMessage(err);
    log.warn(
      `Compaction safeguard: request credentials unavailable; cancelling compaction. ${error}`,
    );
    return {
      ok: false,
      reason: `Compaction safeguard could not resolve request credentials for ${model.provider}/${model.id}: ${error}`,
    };
  }
  if (!requestAuth.ok) {
    log.warn(
      `Compaction safeguard: request credential resolution failed for ${model.provider}/${model.id}: ${requestAuth.error}`,
    );
    return {
      ok: false,
      reason: `Compaction safeguard could not resolve request credentials for ${model.provider}/${model.id}: ${requestAuth.error}`,
    };
  }
  return { ok: true, apiKey: requestAuth.apiKey, headers: requestAuth.headers };
}

export function buildCompactionSummaryHeaders(params: {
  model: NonNullable<ExtensionContext["model"]>;
  messages: AgentMessage[];
  headers?: Record<string, string>;
}): Record<string, string> | undefined {
  if (params.model.provider !== "github-copilot") {
    return params.headers;
  }
  // SAFETY: Copilot header inspection reads the same message content fields shared by both SDK projections.
  const messages = params.messages as unknown as Parameters<
    typeof buildCopilotDynamicHeaders
  >[0]["messages"];
  return {
    ...buildCopilotDynamicHeaders({
      messages,
      hasImages: hasCopilotVisionInput(messages),
    }),
    ...params.headers,
  };
}

export function clampNonNegativeInt(
  value: unknown,
  fallback: number,
  max = Number.POSITIVE_INFINITY,
): number {
  const normalized = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(0, Math.floor(normalized)));
}

export function resolveRecentTurnsPreserve(value: unknown): number {
  return clampNonNegativeInt(value, DEFAULT_RECENT_TURNS_PRESERVE, MAX_RECENT_TURNS_PRESERVE);
}

export function resolveQualityGuardMaxRetries(value: unknown): number {
  return clampNonNegativeInt(
    value,
    DEFAULT_QUALITY_GUARD_MAX_RETRIES,
    MAX_QUALITY_GUARD_MAX_RETRIES,
  );
}
