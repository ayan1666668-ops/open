import type { MemoryEmbeddingProviderRuntime } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
// Memory Core plugin module implements manager embedding timeout resolution behavior.
import { MAX_TIMER_TIMEOUT_MS, resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";

const EMBEDDING_QUERY_TIMEOUT_REMOTE_MS = 60_000;
const EMBEDDING_QUERY_TIMEOUT_LOCAL_MS = 5 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_REMOTE_MS = 2 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_LOCAL_MS = 10 * 60_000;

function resolveEmbeddingSecondsTimeoutMs(seconds: number): number {
  if (!Number.isFinite(seconds)) {
    return MAX_TIMER_TIMEOUT_MS;
  }
  const timeoutMs = Math.floor(seconds * 1000);
  return resolveTimerTimeoutMs(
    Number.isFinite(timeoutMs) ? timeoutMs : MAX_TIMER_TIMEOUT_MS,
    MAX_TIMER_TIMEOUT_MS,
  );
}

export function resolveEmbeddingTimeoutMs(params: {
  kind: "query" | "batch";
  providerId?: string;
  providerRuntime?: Pick<
    MemoryEmbeddingProviderRuntime,
    "inlineQueryTimeoutMs" | "inlineBatchTimeoutMs"
  >;
  /** Operator override for every memory embedding request, in seconds. */
  configuredTimeoutSeconds?: number;
}): number {
  // An explicit operator budget wins over provider-owned defaults for both
  // query and index requests: a slow-but-healthy local provider cannot raise
  // its own ceiling, and the docs otherwise call timeouts provider-owned.
  const configuredTimeoutSeconds = params.configuredTimeoutSeconds;
  if (typeof configuredTimeoutSeconds === "number" && configuredTimeoutSeconds > 0) {
    return resolveEmbeddingSecondsTimeoutMs(configuredTimeoutSeconds);
  }
  if (params.kind === "query") {
    const runtimeTimeoutMs = params.providerRuntime?.inlineQueryTimeoutMs;
    if (typeof runtimeTimeoutMs === "number" && runtimeTimeoutMs > 0) {
      return resolveTimerTimeoutMs(runtimeTimeoutMs, EMBEDDING_QUERY_TIMEOUT_REMOTE_MS);
    }
    return params.providerId === "local"
      ? EMBEDDING_QUERY_TIMEOUT_LOCAL_MS
      : EMBEDDING_QUERY_TIMEOUT_REMOTE_MS;
  }

  const runtimeTimeoutMs = params.providerRuntime?.inlineBatchTimeoutMs;
  if (typeof runtimeTimeoutMs === "number" && runtimeTimeoutMs > 0) {
    return resolveTimerTimeoutMs(runtimeTimeoutMs, EMBEDDING_BATCH_TIMEOUT_REMOTE_MS);
  }
  return params.providerId === "local"
    ? EMBEDDING_BATCH_TIMEOUT_LOCAL_MS
    : EMBEDDING_BATCH_TIMEOUT_REMOTE_MS;
}
