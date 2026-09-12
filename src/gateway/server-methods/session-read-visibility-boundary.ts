import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  authorizeIncognitoSessionTarget,
  hiddenSessionNotFound,
} from "../session-sharing-policy.js";
import { createSessionReadVisibilityFilter } from "../session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export type AdmittedSessionReadTarget = {
  agentId: string;
  canonicalKey: string;
  sessionId: string | undefined;
  storePath: string | undefined;
};

export function authorizeSessionReadTarget(params: {
  canonicalKey: string;
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  entry: SessionEntry | undefined;
  sessionKey: string;
}): ErrorShape | null {
  const incognitoError = authorizeIncognitoSessionTarget({
    client: params.client,
    sessionKey: params.sessionKey,
    target: params.entry ? { canonicalKey: params.canonicalKey, entry: params.entry } : null,
  });
  if (incognitoError) {
    return incognitoError;
  }
  const entryFilter = createSessionReadVisibilityFilter(params.client, params.cfg);
  return params.entry && entryFilter && !entryFilter(params.canonicalKey, params.entry)
    ? hiddenSessionNotFound(params.sessionKey)
    : null;
}

export function revalidateSessionReadTarget(params: {
  admitted: AdmittedSessionReadTarget;
  client: GatewayClient | null;
  context: GatewayRequestContext;
  requestedAgentId?: string;
  sessionKey: string;
}): ErrorShape | null {
  const cfg = params.context.getRuntimeConfig();
  const requestedAgent = resolveRequestedSessionAgentId(
    cfg,
    params.sessionKey,
    params.requestedAgentId,
  );
  if (!requestedAgent.ok || requestedAgent.agentId !== params.admitted.agentId) {
    return hiddenSessionNotFound(params.sessionKey);
  }
  const current = loadGatewaySessionEntryReadOnly(params.sessionKey, {
    ...(requestedAgent.agentId ? { agentId: requestedAgent.agentId } : {}),
  });
  if (
    current.canonicalKey !== params.admitted.canonicalKey ||
    current.storePath !== params.admitted.storePath ||
    current.entry?.sessionId !== params.admitted.sessionId
  ) {
    return hiddenSessionNotFound(params.sessionKey);
  }
  return authorizeSessionReadTarget({
    canonicalKey: current.canonicalKey,
    cfg,
    client: params.client,
    entry: current.entry,
    sessionKey: params.sessionKey,
  });
}
