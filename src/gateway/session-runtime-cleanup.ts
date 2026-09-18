import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { resolveAmbientOwnerAgentId } from "../agents/agent-scope.js";
import { clearBootstrapSnapshot } from "../agents/bootstrap-cache.js";
import { resolveActiveReplyOperationForSessionId } from "../auto-reply/reply/reply-run-registry.js";
import { isReplyOperationPreBackendPhase } from "../auto-reply/reply/reply-run-registry.state.js";
import {
  clearSessionResetRuntimeState,
  createSessionResetCleanupGuard,
  SessionResetCleanupError,
  stopSessionResetSubagents,
} from "../auto-reply/reply/session-reset-cleanup.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import type { resolveGatewaySessionStoreTarget } from "./session-utils.js";

type McpRunEndWatcherState = {
  cancellations: Map<string, () => void>;
  retirements: Set<Promise<void>>;
  watchers: Map<string, Promise<void>>;
};

const mcpRunEndWatcherState = resolveGlobalSingleton<McpRunEndWatcherState>(
  Symbol.for("openclaw.mcpRunEndWatchers"),
  () => ({ cancellations: new Map(), retirements: new Set(), watchers: new Map() }),
  async (state) => {
    for (const cancel of state.cancellations.values()) {
      cancel();
    }
    await Promise.allSettled([...state.watchers.values(), ...state.retirements]);
    state.cancellations.clear();
    state.retirements.clear();
    state.watchers.clear();
  },
);
const mcpRunEndWatchers = mcpRunEndWatcherState.watchers;

export async function ensureSessionRuntimeCleanup(params: {
  cfg: OpenClawConfig;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  sessionId?: string;
  sessionLifecycleRevision?: string;
  assertCurrent?: () => void;
}) {
  const assertCurrent = createSessionResetCleanupGuard({
    storePath: params.target.storePath,
    sessionKey: params.target.canonicalKey,
    expectedSession: params.sessionId
      ? { sessionId: params.sessionId, lifecycleRevision: params.sessionLifecycleRevision }
      : undefined,
    assertCurrent: params.assertCurrent,
  });
  // Session lifecycle mutation owns this heavy runtime edge; read-only gateway
  // commands such as status must not load the embedded-agent barrel.
  const [embeddedAgent, mcpTools, { clearFinishedSessionsForScopes }] = await Promise.all([
    import("../agents/embedded-agent.js"),
    import("../agents/agent-bundle-mcp-tools.js"),
    import("../agents/bash-process-registry.js"),
  ]);
  const closeTrackedBrowserTabs = async () => {
    assertCurrent();
    const closeKeys = new Set<string>([
      params.key,
      params.target.canonicalKey,
      ...params.target.storeKeys,
      params.sessionId ?? "",
    ]);
    await cleanupBrowserSessionsForLifecycleEnd({
      cfg: params.cfg,
      sessionKeys: [...closeKeys],
      onWarn: (message) => logVerbose(message),
    });
    assertCurrent();
  };

  try {
    assertCurrent();
    await stopSessionResetSubagents({
      cfg: params.cfg,
      sessionKey: params.target.canonicalKey,
      agentId: normalizeAgentId(params.target.agentId ?? resolveAmbientOwnerAgentId(params.cfg)),
      assertCurrent,
    });
  } catch (error) {
    if (error instanceof SessionResetCleanupError) {
      return errorShape(ErrorCodes.UNAVAILABLE, error.message);
    }
    throw error;
  }
  // Parent admissions are already drained. Reject stale or incomplete child cleanup
  // before discarding queues or interrupting a newly accepted reply operation.
  assertCurrent();
  const queueKeys = new Set<string>(params.target.storeKeys);
  queueKeys.add(params.target.canonicalKey);
  if (params.sessionId) {
    queueKeys.add(params.sessionId);
  }
  // Process scopes may use the requested alias, canonical key, or session id.
  // Clear only completed records so reset/delete cannot erase another scope's
  // output or hide a background process whose owner has not confirmed exit.
  const processScopeKeys = new Set(queueKeys);
  processScopeKeys.add(params.key);
  clearFinishedSessionsForScopes(processScopeKeys);
  clearSessionResetRuntimeState([...queueKeys], {
    activeReplySessionId: params.sessionId,
    agentId: normalizeAgentId(params.target.agentId ?? resolveAmbientOwnerAgentId(params.cfg)),
  });
  if (!params.sessionId) {
    assertCurrent();
    clearBootstrapSnapshot(params.target.canonicalKey);
    await closeTrackedBrowserTabs();
    return undefined;
  }
  const sessionId = params.sessionId;
  assertCurrent();
  const cleanupProviderResources = () => {
    try {
      cleanupSessionResources(sessionId);
    } catch (error) {
      logVerbose(
        `sessions cleanup: failed to dispose provider resources for ${sessionId}: ${String(error)}`,
      );
    }
  };
  const retireMcpRuntime = async (retainAcrossReuse: boolean) => {
    await mcpTools.retireSessionMcpRuntime({
      sessionId,
      reason: "gateway-session-cleanup",
      preserveActiveLeases: true,
      retainAcrossReuse,
      onError: (error, retiredSessionId) => {
        logVerbose(
          `sessions cleanup: failed to dispose bundle MCP runtime for ${retiredSessionId}: ${String(error)}`,
        );
      },
    });
  };
  const ensureMcpRetirementWatcher = (): Promise<void> => {
    return getOrCreatePromise(
      mcpRunEndWatchers,
      sessionId,
      async () => {
        let cancelWatcher = () => {};
        const cancelled = new Promise<false>((resolve) => {
          cancelWatcher = () => resolve(false);
        });
        mcpRunEndWatcherState.cancellations.set(sessionId, cancelWatcher);
        try {
          while (
            await Promise.race([
              embeddedAgent.waitForEmbeddedAgentRunEnd(sessionId, null),
              cancelled,
            ])
          ) {
            // A replacement can register after the wait promise settles but before
            // this continuation runs. Keep the required retirement armed for it.
            if (embeddedAgent.isEmbeddedAgentRunActive(sessionId)) {
              continue;
            }
            const retirement = retireMcpRuntime(false);
            mcpRunEndWatcherState.retirements.add(retirement);
            try {
              await retirement;
            } finally {
              mcpRunEndWatcherState.retirements.delete(retirement);
            }
            if (embeddedAgent.isEmbeddedAgentRunActive(sessionId)) {
              continue;
            }
            cleanupProviderResources();
            return;
          }
        } catch (error) {
          logVerbose(
            `sessions cleanup: failed to disarm deferred MCP retirement: ${String(error)}`,
          );
        } finally {
          if (mcpRunEndWatcherState.cancellations.get(sessionId) === cancelWatcher) {
            mcpRunEndWatcherState.cancellations.delete(sessionId);
          }
        }
      },
      { evictOnSettled: true },
    );
  };
  // Competing admissions have drained. A surviving pre-backend reply is the
  // reset command itself; generic Stop would cancel that command and its tail.
  const reply = resolveActiveReplyOperationForSessionId(sessionId);
  const preparingReset =
    reply !== undefined &&
    isReplyOperationPreBackendPhase(reply.phase) &&
    !embeddedAgent.isEmbeddedAgentRunHandleActive(sessionId);
  let mcpRetirementWatcher: Promise<void> | undefined;
  let ended = true;
  if (preparingReset) {
    mcpRetirementWatcher = mcpRunEndWatchers.get(sessionId);
    await retireMcpRuntime(false);
  } else {
    // Capture the run before cancellation can replace its registry entry.
    mcpRetirementWatcher = ensureMcpRetirementWatcher();
    embeddedAgent.abortEmbeddedAgentRun(sessionId);
    // Active leases retain in-flight tools; the marker covers late runtime reuse.
    await retireMcpRuntime(true);
    ended = await embeddedAgent.waitForEmbeddedAgentRunEnd(sessionId, 15_000);
    assertCurrent();
    await retireMcpRuntime(!ended);
  }
  assertCurrent();
  clearBootstrapSnapshot(params.target.canonicalKey);
  if (ended && (preparingReset || !embeddedAgent.isEmbeddedAgentRunActive(sessionId))) {
    assertCurrent();
    mcpRunEndWatcherState.cancellations.get(sessionId)?.();
    await mcpRetirementWatcher;
    assertCurrent();
    cleanupProviderResources();
    await closeTrackedBrowserTabs();
    return undefined;
  }
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `Session ${params.key} is still active; try again in a moment.`,
  );
}
