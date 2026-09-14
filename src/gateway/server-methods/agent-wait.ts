import {
  ErrorCodes,
  errorShape,
  validateAgentWaitParams,
  type AgentWaitParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { readDurableAgentJobTerminalReceipt } from "../agent-turn/agent-job.js";
import { createAgentTurnService } from "../agent-turn/agent-turn-service.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import {
  createSessionListEntryFilter,
  isGatewayAdmin,
  resolveSessionSharingTarget,
} from "../session-sharing.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const agentWaitHandler: GatewayRequestHandlers["agent.wait"] = async ({
  params,
  respond,
  context,
  client,
  isWebchatConnect,
}) => {
  if (!assertValidParams(params, validateAgentWaitParams, "agent.wait", respond)) {
    return;
  }
  const gatewayClient = client ?? null;
  const cfg = context.getRuntimeConfig();
  const requiresRunAuthorization =
    gatewayClient?.authenticatedUserProfile &&
    !isGatewayAdmin(gatewayClient) &&
    operatorSessionCap(gatewayClient, cfg) === "none";
  const canReadRun = (): boolean => {
    if (requiresRunAuthorization) {
      const run = getAgentRunContext(params.runId);
      let recoveredOwner:
        | NonNullable<ReturnType<typeof readDurableAgentJobTerminalReceipt>>["owner"]
        | undefined;
      if (!run) {
        try {
          recoveredOwner = readDurableAgentJobTerminalReceipt(params.runId)?.owner;
        } catch {
          // Authorization fails closed when durable state is temporarily unreadable.
        }
      }
      const owner = run ?? recoveredOwner;
      const target = owner?.sessionKey
        ? resolveSessionSharingTarget({
            cfg,
            sessionKey: owner.sessionKey,
            agentId: owner.agentId,
          })
        : null;
      // A live run is not authority to reuse a session key after that key has
      // been reassigned while this request was waiting. Bind both hot and
      // recovered owners to the exact retained session when one was recorded.
      const retainedSessionMatches =
        typeof owner?.sessionId === "string" && target?.entry.sessionId === owner.sessionId;
      const visibilityFilter = createSessionListEntryFilter({ client: gatewayClient, cfg });
      if (
        !target ||
        !retainedSessionMatches ||
        visibilityFilter?.(target.storeKey, target.entry) === false
      ) {
        return false;
      }
    }
    return true;
  };
  const rejectUnavailableRun = () =>
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "agent run was not found"));
  if (!canReadRun()) {
    rejectUnavailableRun();
    return;
  }
  const result = await createAgentTurnService({ context, isWebchatConnect }).waitForTurn(
    params as AgentWaitParams,
  );
  // Authority can change while a wait is pending. Never release a terminal result
  // under the stale authorization snapshot captured before the await.
  if (!canReadRun()) {
    rejectUnavailableRun();
    return;
  }
  respond(true, result);
};
