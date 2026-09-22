import { getRuntimeConfigSnapshotMetadata } from "../../config/runtime-snapshot.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import {
  canResolveOperatorApproval,
  canReviewOperatorApproval,
} from "../operator-approval-authorization.js";
import type { OperatorApprovalStoreGuard } from "../operator-approval-store.types.js";
import { resolveGatewayOperatorRoleActor } from "../operator-role-policy.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Retain the original invocation; copying options loses its request-owner binding. */
export function createApprovalRequestAuthority(options: GatewayRequestHandlerOptions) {
  const authority = readGatewayRequestMutationAuthority(options);
  const { client } = options;
  const method = options.req.method;
  const profileId = client?.authenticatedUserProfile?.profileId;
  const userId = client?.authenticatedUserId;
  const role = client?.connect.role;
  const deviceId = client?.connect.device?.id;
  const approvalRuntime = client?.internal?.approvalRuntime;
  const runtimeIdentity = client?.internal?.agentRuntimeIdentity;
  const actor = resolveGatewayOperatorRoleActor(client);
  const actorKind = actor?.kind;
  const actorProfileId = actor?.kind === "operator" ? actor.profileId : undefined;
  const config = getRuntimeConfigSnapshotMetadata();
  const readRuntimeConfig = options.context.getRuntimeConfig;
  const runtimeConfig =
    authority.family === "worker" ? options.context.getRuntimeConfig() : undefined;
  const accessRevision = readGatewayAccessRevision();
  const assertPolicyCurrent = () => {
    const currentActor = resolveGatewayOperatorRoleActor(client);
    const legacy = method.startsWith("exec.approval.") || method.startsWith("plugin.approval.");
    const allowed = legacy
      ? authority.family === "native-compatibility" ||
        authorizeOperatorScopesForMethod(method, client?.connect.scopes ?? []).allowed
      : method === "approval.resolve"
        ? canResolveOperatorApproval(client)
        : method === "approval.history"
          ? authorizeOperatorScopesForMethod(method, client?.connect.scopes ?? []).allowed
          : canReviewOperatorApproval(client);
    if (
      !allowed ||
      client?.invalidated ||
      client?.connect.role !== role ||
      client?.connect.device?.id !== deviceId ||
      client?.internal?.approvalRuntime !== approvalRuntime ||
      client?.internal?.agentRuntimeIdentity !== runtimeIdentity ||
      currentActor?.kind !== actorKind ||
      (currentActor?.kind === "operator" ? currentActor.profileId : undefined) !== actorProfileId ||
      client?.authenticatedUserProfile?.profileId !== profileId ||
      client?.authenticatedUserId !== userId ||
      (authority.family === "worker" &&
        (getRuntimeConfigSnapshotMetadata() !== config ||
          options.context.getRuntimeConfig !== readRuntimeConfig ||
          options.context.getRuntimeConfig() !== runtimeConfig ||
          readGatewayAccessRevision() !== accessRevision))
    ) {
      throw new Error("Approval requester authority changed");
    }
  };
  const assertCurrent = () => {
    authority.assertCurrent();
    authority.expectedProfileBinding?.assertCurrent();
    assertPolicyCurrent();
  };
  const guard: OperatorApprovalStoreGuard = {
    family: authority.family,
    assertCurrent:
      authority.family === "native-compatibility"
        ? assertCurrent
        : () => {
            authority.assertWorkerCurrent();
            authority.expectedProfileBinding?.assertCurrent();
            assertPolicyCurrent();
          },
  };
  return {
    guard,
    assertCurrent,
    assertCommitCurrent: guard.assertCurrent,
    isCurrent: () => {
      try {
        assertCurrent();
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type ApprovalRequestAuthority = ReturnType<typeof createApprovalRequestAuthority>;
