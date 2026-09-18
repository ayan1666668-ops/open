import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveMissingAgentHarnessSessionError } from "../../sessions/agent-harness-session-key.js";
import { authorizeGatewaySessionCreation } from "../operator-role-policy.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import {
  resolveCanonicalSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTargetWithStore,
} from "../session-utils.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { validateSessionUnreadAck, type SessionPatchTargetIdentity } from "./session-unread-ack.js";
import { validateSessionPatchArchiveProjection } from "./sessions-patch-archive.js";
import {
  invalidSessionPatchOutcome,
  sessionChangedError,
  unexpectedPatchError,
} from "./sessions-patch-errors.js";
import {
  resolveSessionPatchExpectationError,
  sessionPatchExpectationsChanged,
} from "./sessions-patch-expectations.js";
import type {
  MutationOutcome,
  MutationTarget,
  PreparedPatchTarget,
} from "./sessions-patch-types.js";
import { resolveSessionWorkerPlacementPatchError } from "./sessions-shared.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export function prepareSessionPatchTargets(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  context: GatewayRequestContext;
  patch: Omit<SessionsPatchParams, keyof SessionPatchTargetIdentity>;
  targets: readonly MutationTarget[];
}) {
  const { cfg, client } = params;
  const archiveActor = gatewayClientSessionCreator(client);
  const pluginOwnerId = client?.internal?.pluginRuntimeOwnerId;
  const targetDiscoveryCache = new Map();
  const preflightTargets = params.targets.map((input) => {
    const key = input.key.trim();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, input.agentId);
    return {
      input,
      key,
      requestedAgent,
      resolved: requestedAgent.ok
        ? resolveGatewaySessionStoreTargetWithStore({
            cfg,
            key,
            agentId: requestedAgent.agentId,
            exactRead: true,
            targetDiscoveryCache,
          })
        : undefined,
    };
  });
  const logicalTargets = new Set<string>();
  for (const { key, resolved } of preflightTargets) {
    if (!resolved) {
      continue;
    }
    const logicalId = `${resolved.storePath}\0${resolved.canonicalKey ?? key}`;
    if (logicalTargets.has(logicalId)) {
      return invalidSessionPatchOutcome("Duplicate target.");
    }
    logicalTargets.add(logicalId);
  }

  const outcomes = Array.from<MutationOutcome | undefined>({ length: params.targets.length });
  const prepared: PreparedPatchTarget[] = [];
  const preparedByIndex = Array.from<PreparedPatchTarget | undefined>({
    length: params.targets.length,
  });
  for (const [index, { input, key, requestedAgent, resolved }] of preflightTargets.entries()) {
    const unreadAckError = validateSessionUnreadAck(params.patch, input);
    if (unreadAckError) {
      outcomes[index] = invalidSessionPatchOutcome(unreadAckError);
      continue;
    }
    if (!requestedAgent.ok) {
      outcomes[index] = requestedAgent;
      continue;
    }
    if (!resolved) {
      outcomes[index] = invalidSessionPatchOutcome("Session target could not be resolved.");
      continue;
    }
    const requestedAgentId = requestedAgent.agentId;
    const canonicalKey = resolved.canonicalKey ?? key;
    const candidateKeys = resolved.storeKeys;
    let initialEntry: SessionEntry | undefined;
    try {
      initialEntry = resolveCanonicalSessionEntryFromStoreKeys(resolved.store, [...candidateKeys]);
    } catch (error) {
      outcomes[index] = { ok: false, error: unexpectedPatchError(key, error) };
      continue;
    }
    const creationError =
      !initialEntry && authorizeGatewaySessionCreation({ cfg, client, agentId: resolved.agentId });
    if (creationError) {
      outcomes[index] = { ok: false, error: creationError };
      continue;
    }
    const ownershipError = resolvePluginSessionOwnershipError({
      action: "patch",
      entry: initialEntry,
      key: canonicalKey,
      pluginOwnerId,
    });
    if (ownershipError) {
      outcomes[index] = { ok: false, error: ownershipError };
      continue;
    }
    const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(
      canonicalKey,
      initialEntry,
    );
    if (missingHarnessSessionError) {
      outcomes[index] = invalidSessionPatchOutcome(missingHarnessSessionError);
      continue;
    }
    // Commit guards are core control state; construct the protocol patch from
    // its public identity fields so closures can never reach hooks or entries.
    const { commitGuard: _commitGuard, ...identity } = input;
    const fullPatch: SessionsPatchParams = { ...params.patch, ...identity };
    const expectationError = resolveSessionPatchExpectationError(fullPatch);
    if (expectationError) {
      outcomes[index] = invalidSessionPatchOutcome(expectationError);
      continue;
    }
    let initialPlacementPatchError: string | undefined;
    try {
      initialPlacementPatchError = resolveSessionWorkerPlacementPatchError({
        agentId: resolved.agentId,
        cfg,
        context: params.context,
        entry: initialEntry,
        key,
        patch: fullPatch,
        sessionKey: canonicalKey,
        validateModelRuntime: false,
      });
    } catch (error) {
      outcomes[index] = { ok: false, error: unexpectedPatchError(key, error) };
      continue;
    }
    if (initialPlacementPatchError) {
      outcomes[index] = invalidSessionPatchOutcome(initialPlacementPatchError);
      continue;
    }
    const lifecycleIdentities = Array.from(
      new Set([key, canonicalKey, ...candidateKeys, initialEntry?.sessionId]),
    );
    const preparedTarget: PreparedPatchTarget = {
      archiveActor,
      canonicalKey,
      fullPatch,
      index,
      ...(initialEntry ? { initialEntry } : {}),
      initialStoreKeys: [...candidateKeys],
      key,
      lifecycleIdentities,
      ...(requestedAgentId ? { requestedAgentId } : {}),
      storePath: resolved.storePath,
      targetAgentId: resolved.agentId,
    };
    prepared.push(preparedTarget);
    preparedByIndex[index] = preparedTarget;
  }
  return { ok: true as const, prepared, preparedByIndex, outcomes };
}

/** Recheck ownership and caller expectations against the fresh mutation snapshot. */
export function resolveSessionPatchProjectionError(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  target: PreparedPatchTarget;
  existingEntry: SessionEntry | undefined;
  primaryKey: string;
}) {
  const { cfg, client, target, existingEntry, primaryKey } = params;
  const creationError =
    !existingEntry &&
    authorizeGatewaySessionCreation({ cfg, client, agentId: target.targetAgentId });
  if (creationError) {
    return creationError;
  }
  const pluginOwnerId = client?.internal?.pluginRuntimeOwnerId;
  const ownershipError = resolvePluginSessionOwnershipError({
    action: "patch",
    entry: existingEntry,
    key: primaryKey,
    pluginOwnerId,
  });
  if (ownershipError) {
    return ownershipError;
  }
  const patch = target.fullPatch;
  const expectedSessionChanged =
    (patch.expectedSessionId !== undefined &&
      existingEntry?.sessionId !== patch.expectedSessionId) ||
    (patch.expectedLifecycleRevision !== undefined &&
      existingEntry?.lifecycleRevision !== patch.expectedLifecycleRevision) ||
    sessionPatchExpectationsChanged(existingEntry, patch);
  const lifecycleEntryRemoved = target.initialEntry !== undefined && existingEntry === undefined;
  const archiveTargetChanged =
    patch.archived === true &&
    (target.initialEntry === undefined
      ? existingEntry !== undefined
      : existingEntry !== undefined &&
        (existingEntry.sessionId !== target.initialEntry.sessionId ||
          existingEntry.lifecycleRevision !== target.initialEntry.lifecycleRevision));
  if (expectedSessionChanged || lifecycleEntryRemoved || archiveTargetChanged) {
    return sessionChangedError(target.key);
  }
  if (patch.archived === true) {
    return validateSessionPatchArchiveProjection({
      cfg,
      existingEntry,
      fullPatch: patch,
      key: target.key,
      ...(pluginOwnerId ? { pluginOwnerId } : {}),
      preparation: target.archivePreparation!,
      primaryKey,
    });
  }
  return undefined;
}
