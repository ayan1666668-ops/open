import { extractErrorCode, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemoryReadResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { jsonResult } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  attemptMemoryCorpus,
  composeMemoryCorpusMetadata,
  readMemoryCorpusSupplements,
  runMemoryCorpusDeadline,
  unavailableMemoryCorpus,
  type MemoryCorpusAttempt,
} from "./memory-corpus.js";
import { isMemorySearchDeadlineError } from "./memory/search-deadline.js";

type MemoryReadRequest = {
  requestedCorpus?: "memory" | "wiki" | "all";
  relPath: string;
  from?: number;
  lines?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  signal?: AbortSignal;
  /**
   * Configured deadline for the whole read. When absent, wiki and combined reads keep
   * the built-in memory search timeout and a primary-only read stays unbounded.
   */
  timeoutMs?: number;
};

function readWiki(params: MemoryReadRequest, signal: AbortSignal) {
  return readMemoryCorpusSupplements({
    lookup: params.relPath,
    fromLine: params.from,
    lineCount: params.lines,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
    signal,
  });
}

function attemptValue<T>(attempt: MemoryCorpusAttempt<T>): T | null {
  return attempt.outcome === "not-registered" ? null : attempt.value;
}

export async function executeWikiMemoryReadResult(params: MemoryReadRequest) {
  return await runMemoryCorpusDeadline({
    operation: "memory_get",
    timeoutMs: params.timeoutMs,
    parentSignal: params.signal,
    run: async (signal) => {
      const wiki = await readWiki(params, signal);
      const result =
        attemptValue(wiki) ??
        (wiki.outcome === "ok"
          ? { status: "not_found" as const, path: params.relPath, text: "" as const }
          : { path: params.relPath, text: "" });
      return jsonResult({ ...result, ...composeMemoryCorpusMetadata([wiki]) });
    },
  });
}

export async function executeMemoryReadResult(
  params: MemoryReadRequest & { read: () => Promise<MemoryReadResult> },
) {
  if (params.requestedCorpus !== "all") {
    const readError = (code: string | undefined, error: string) => ({
      path: params.relPath,
      text: "",
      status: "error",
      code: code ?? "MEMORY_READ_FAILED",
      error,
    });
    if (params.timeoutMs === undefined) {
      // Shipped behaviour: a primary-only read has no deadline unless one is configured.
      try {
        return jsonResult(await params.read());
      } catch (error) {
        return jsonResult(readError(extractErrorCode(error), formatErrorMessage(error)));
      }
    }
    const timedOut = (memory: MemoryCorpusAttempt<MemoryReadResult | null>) =>
      jsonResult({
        path: params.relPath,
        text: "",
        disabled: true,
        ...composeMemoryCorpusMetadata(
          [memory],
          [
            "Retry memory_get after a short wait, or raise memory.search.query.timeoutSeconds if reads keep timing out.",
          ],
        ),
      });
    try {
      return await runMemoryCorpusDeadline({
        operation: "memory_get",
        timeoutMs: params.timeoutMs,
        parentSignal: params.signal,
        run: async (signal) => {
          const memory = await attemptMemoryCorpus({
            corpus: "memory",
            signal,
            unavailableValue: null,
            run: params.read,
          });
          if (memory.outcome === "ok") {
            return jsonResult(memory.value);
          }
          // Only the deadline is this tool's own failure; an ordinary read error
          // keeps the shipped error result and its code.
          return memory.deadline
            ? timedOut(memory)
            : jsonResult(readError(memory.code, memory.error));
        },
      });
    } catch (error) {
      // A read that fails after the deadline passed, but before the overdue timer
      // ran, surfaces as the owner's own deadline error rather than a read result.
      if (!isMemorySearchDeadlineError(error)) {
        throw error;
      }
      return timedOut(unavailableMemoryCorpus("memory", null, error));
    }
  }
  return await runMemoryCorpusDeadline({
    operation: "memory_get",
    timeoutMs: params.timeoutMs,
    parentSignal: params.signal,
    run: async (signal) => {
      const [memory, wiki] = await Promise.all([
        attemptMemoryCorpus({
          corpus: "memory",
          signal,
          unavailableValue: null,
          run: params.read,
        }),
        readWiki(params, signal),
      ]);
      const memoryResult = attemptValue(memory);
      const wikiResult = attemptValue(wiki);
      const result =
        memoryResult?.status !== "not_found" && memoryResult !== null
          ? memoryResult
          : (wikiResult ??
            (memory.outcome === "ok" || wiki.outcome === "ok"
              ? { status: "not_found" as const, path: params.relPath, text: "" as const }
              : { status: "error", path: params.relPath, text: "" }));
      return jsonResult({ ...result, ...composeMemoryCorpusMetadata([memory, wiki]) });
    },
  });
}
