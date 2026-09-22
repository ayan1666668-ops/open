import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { logVerbose } from "../globals.js";
import type { ArchivedSessionTranscript } from "./session-transcript-files.fs.js";
import { resolveStableSessionEndTranscript } from "./session-transcript-files.fs.js";
import { readSessionMessagesAsync } from "./session-transcript-readers.js";

type HookTranscriptReadParams = {
  agentId: string;
  entry?: SessionEntry;
  sessionId?: string;
  sessionKey: string;
  storePath: string;
};

/**
 * Reads the canonical transcript messages for a lifecycle hook payload.
 * Best-effort: a read failure logs and returns an empty list so the hook still
 * fires. Shared by before_reset and session_end so both read the same owner.
 */
async function readHookTranscriptMessages(
  params: HookTranscriptReadParams & { hookName: string },
): Promise<unknown[]> {
  if (typeof params.sessionId !== "string" || params.sessionId.trim().length === 0) {
    return [];
  }
  try {
    return await readSessionMessagesAsync(
      {
        agentId: params.agentId,
        sessionEntry: params.entry,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      {
        mode: "full",
        reason: `${params.hookName} hook payload`,
      },
    );
  } catch (err) {
    logVerbose(
      `${params.hookName}: failed to read session messages for ${params.sessionId}; firing hook with empty messages (${String(err)})`,
    );
    return [];
  }
}

export async function readGatewayBeforeResetPluginHookMessages(
  params: HookTranscriptReadParams,
): Promise<unknown[]> {
  return readHookTranscriptMessages({ ...params, hookName: "before_reset" });
}

export async function readGatewaySessionEndPluginHookMessages(
  params: HookTranscriptReadParams,
): Promise<unknown[]> {
  return readHookTranscriptMessages({ ...params, hookName: "session_end" });
}

/**
 * Resolves the transcript a session_end hook should receive. Prefers an
 * existing on-disk transcript, then falls back to the SQLite marker so plugins
 * never get a path to a JSONL that does not exist. Callers that destroy the
 * transcript first (reset / delete) pass the pre-captured `messages`.
 */
export async function readGatewaySessionEndPluginHookTranscript(params: {
  agentId: string;
  entry?: SessionEntry;
  sessionId?: string;
  sessionKey: string;
  storePath?: string;
  sessionFile?: string;
  archivedTranscripts?: ArchivedSessionTranscript[];
  messages?: unknown[];
}): Promise<{ messages: unknown[]; sessionFile?: string; transcriptArchived?: boolean }> {
  const sessionId =
    typeof params.sessionId === "string" && params.sessionId.trim().length > 0
      ? params.sessionId
      : undefined;
  const resolved = sessionId
    ? resolveStableSessionEndTranscript({
        sessionId,
        storePath: params.storePath,
        sessionFile: params.sessionFile,
        agentId: params.agentId,
        archivedTranscripts: params.archivedTranscripts,
      })
    : {};
  const sessionFile =
    resolved.sessionFile ??
    (sessionId && params.storePath
      ? formatSqliteSessionFileMarker({
          agentId: params.agentId,
          sessionId,
          storePath: params.storePath,
        })
      : undefined);
  const messages =
    params.messages ??
    (sessionId && params.storePath
      ? await readHookTranscriptMessages({
          agentId: params.agentId,
          entry: params.entry,
          sessionId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          hookName: "session_end",
        })
      : []);
  return { messages, sessionFile, transcriptArchived: resolved.transcriptArchived };
}
