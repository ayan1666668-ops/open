// Model-backed compaction request construction.
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { compactEmbeddedAgentSession } from "../../agents/embedded-agent.js";
import { preflightManualSessionCompaction } from "../../agents/sessions/manual-compaction-preflight.js";
import { isIndexedSessionEntry } from "../../agents/sessions/session-manager-codec.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import { normalizeReasoningLevel, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import { resolveCurrentSessionPrimaryConversation } from "../../config/sessions/conversation-registry.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  resolveSessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "../../config/sessions/transcript-tree.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getSessionExecutionSelection,
  isModelExecutionSelection,
} from "../../model-picker/execution-selection.js";

type GatewaySessionCompactionParams = {
  agentId: string;
  cfg: OpenClawConfig;
  entry: SessionEntry;
  runId?: string;
  sessionId: string;
  sessionKey: string;
  sessionStoreKey: string;
  storePath: string;
};

function usesLegacyOpenClawCompaction(params: GatewaySessionCompactionParams): boolean {
  const selected = getSessionExecutionSelection(params.entry);
  if (!selected || selected.executor.kind !== "harness" || selected.executor.id !== "openclaw") {
    return false;
  }
  const contextEngine = params.cfg.plugins?.slots?.contextEngine?.trim();
  return !contextEngine || contextEngine === "legacy";
}

async function resolveGatewayCompactionTranscriptTarget(params: GatewaySessionCompactionParams) {
  return await resolveSessionTranscriptRuntimeTarget({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionStoreKey,
    storePath: params.storePath,
  });
}

/** Returns only definitive legacy-runtime no-op verdicts; other runtimes decide for themselves. */
export async function preflightGatewaySessionCompaction(
  params: GatewaySessionCompactionParams,
): Promise<{ reason: "Already compacted" | "Nothing to compact (session too small)" } | undefined> {
  if (!usesLegacyOpenClawCompaction(params)) {
    return undefined;
  }
  try {
    const transcriptEvents = await loadTranscriptEvents({
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionStoreKey,
      storePath: params.storePath,
    });
    const tree = scanSessionTranscriptTree(transcriptEvents);
    const branch = selectSessionTranscriptTreePathNodes(tree, tree.leafId)
      .map((node) => node.entry)
      .filter(isIndexedSessionEntry);
    const preflight = preflightManualSessionCompaction(branch, {
      enabled: true,
      reserveTokens: 0,
      keepRecentTokens: 0,
    });
    return preflight.compactable ? undefined : { reason: preflight.reason };
  } catch {
    // Preserve the existing compaction error path for malformed or unavailable transcripts.
    return undefined;
  }
}

export async function runGatewaySessionCompaction(
  params: GatewaySessionCompactionParams,
  host?: Parameters<typeof compactEmbeddedAgentSession>[1],
): Promise<Awaited<ReturnType<typeof compactEmbeddedAgentSession>>> {
  let expectedEntry = structuredClone(params.entry);
  let currentTarget = {
    agentId: params.agentId,
    sessionKey: params.sessionStoreKey,
    storePath: params.storePath,
  };
  const readCurrent = () =>
    loadSessionEntryReadOnly({ ...currentTarget, readConsistency: "latest" });
  const validateAuthority = () => {
    host?.assertActive?.();
    const current = readCurrent();
    if (
      !current ||
      current.sessionId !== expectedEntry.sessionId ||
      current.lifecycleRevision !== expectedEntry.lifecycleRevision ||
      current.activeWriterRunId !== expectedEntry.activeWriterRunId
    ) {
      return "The session changed. Retry compaction.";
    }
    return resolveSessionWorkStartError(params.sessionKey, current);
  };
  const initialError = validateAuthority();
  if (initialError) {
    return { ok: false, compacted: false, reason: initialError };
  }
  const { initializeSessionExecutionSelectionForRun } =
    await import("../../model-picker/apply-session-model-selection.js");
  const prepared = await initializeSessionExecutionSelectionForRun(
    {
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionStoreKey,
      storePath: params.storePath,
      sessionEntry: params.entry,
      validateCommit: validateAuthority,
    },
    "compaction",
  );
  if (prepared.status !== "applied") {
    return { ok: false, compacted: false, reason: prepared.message };
  }
  expectedEntry = structuredClone(params.entry);
  const assertActive = () => {
    const error = validateAuthority();
    if (error) {
      throw new Error(error);
    }
    const current = readCurrent();
    if (!isDeepStrictEqual(current?.executionSelection, expectedEntry.executionSelection)) {
      throw new Error("The session selection changed. Retry compaction.");
    }
    const accountError = prepared.validateExecution?.() ?? prepared.auth?.validate(current);
    if (accountError) {
      throw new Error(accountError);
    }
  };
  assertActive();
  const transcriptTarget = await resolveGatewayCompactionTranscriptTarget(params);
  assertActive();
  const selected = prepared.selection;
  if (selected.executor.kind === "acp") {
    throw new Error("App-owned compaction cannot enter the embedded runtime.");
  }
  const model = isModelExecutionSelection(selected) ? selected.model : undefined;
  const workspaceDir =
    resolveIngressWorkspaceOverrideForSessionRun({
      spawnedBy: params.entry.spawnedBy,
      workspaceDir: params.entry.spawnedWorkspaceDir,
      cwd: params.entry.spawnedCwd,
    }) ?? resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const cliSessionBinding = getCliSessionBinding(params.entry, selected.executor.id);
  const primaryConversation = resolveCurrentSessionPrimaryConversation(transcriptTarget);
  return await compactEmbeddedAgentSession(
    {
      contextEngineAgentId: params.agentId,
      runId: params.runId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      sessionTarget: {
        agentId: params.agentId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      allowGatewaySubagentBinding: true,
      sessionFile: transcriptTarget.sessionKey,
      workspaceDir,
      cwd: normalizeOptionalString(params.entry.spawnedCwd),
      config: params.cfg,
      // Current delivery owns the account; origin can retain historical identity.
      // Group session keys do not carry an account themselves.
      agentAccountId:
        params.entry.delivery?.kind === "external"
          ? params.entry.delivery.context?.accountId
          : undefined,
      conversationRoutePeerId: primaryConversation?.routeContext?.peerId,
      chatType: primaryConversation?.kind,
      provider: model?.provider,
      model: model?.id,
      authProfileId: prepared.auth?.selection?.profileId,
      authProfileIdSource: prepared.auth?.selection?.source,
      agentHarnessId: selected.executor.id,
      cliSessionId: cliSessionBinding?.sessionId,
      cliSessionBinding,
      sessionEntry: params.entry,
      modelSelectionLocked: params.entry.modelSelectionLocked === true,
      thinkLevel: normalizeThinkLevel(params.entry.thinkingLevel),
      reasoningLevel: normalizeReasoningLevel(params.entry.reasoningLevel),
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      trigger: "manual",
    },
    {
      ...host,
      preparedSelection: { selection: selected, auth: prepared.auth },
      assertActive,
      onCommitted: (accepted) => {
        prepared.onCommitted?.(accepted);
        expectedEntry = structuredClone(accepted.entry);
        currentTarget = accepted.sessionTarget;
        host?.onCommitted?.(accepted);
      },
    },
  );
}
