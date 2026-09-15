import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveNodeCommandAllowlist,
  resolveRequiredNodeCommandAuthority,
} from "../node-command-policy.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { readNodeSessionWithheldCommands } from "../node-registry.js";
import { deviceUnavailableText, resolveDeviceWorkerAvailability } from "./device-provider.js";

/**
 * Paired-device inventory eligibility (connection, session-host consent, command
 * authority, and worker slots). Session-scoped blockers that also prevent hosting —
 * non-portable workspace symlinks that escape the sync root, and Codex remote-exec
 * prepared OpenAI auth / appServer.homeScope="agent" — are enforced at authoritative
 * dispatch (workspace inventory + auth-bridge) and surfaced in the Control UI picker
 * via session placement blockers when a preflight supplies them.
 */
type DevicePlacementEligibility =
  | { ok: true; availableSlots: number; node: NodeWorkerSupervisorNodeProof }
  | { ok: false; error: string };

/** Raised only before a dispatch begins workspace preparation. */
export class DevicePlacementUnavailableError extends Error {
  constructor(
    readonly deviceId: string,
    message: string,
  ) {
    super(message);
  }
}

export async function resolveDevicePlacementEligibility(params: {
  environmentService: object | undefined;
  deviceId: string;
  runtimeId?: string;
  requirement: DevicePlacementRequirement | undefined;
  config: OpenClawConfig;
  currentNode?: {
    nodeId: string;
    connId?: string;
    pairingGeneration?: string;
    platform?: string;
    deviceFamily?: string;
    declaredCommands?: readonly string[];
    commands?: readonly string[];
  };
}): Promise<DevicePlacementEligibility> {
  const { deviceId, requirement } = params;
  if (!requirement) {
    return {
      ok: false,
      error: `runtime ${params.runtimeId ?? "selection"} does not support paired-device placement; select a compatible runtime or cloud worker provider`,
    };
  }
  const availability = await resolveDeviceWorkerAvailability(params.environmentService, deviceId);
  if (!availability.available || !availability.node) {
    return { ok: false, error: deviceUnavailableText(deviceId, availability) };
  }
  const node = availability.node;
  if (
    node.nodeId !== deviceId ||
    (params.currentNode &&
      (params.currentNode.nodeId !== node.nodeId ||
        (params.currentNode.connId && params.currentNode.connId !== node.connId) ||
        (params.currentNode.pairingGeneration &&
          params.currentNode.pairingGeneration !== node.pairingGeneration)))
  ) {
    return {
      ok: false,
      error: deviceUnavailableText(deviceId, {
        available: false,
        unavailableReason: "disconnected",
      }),
    };
  }
  const declaredCommands = [...node.commands];
  const allowlist = resolveNodeCommandAllowlist(params.config, {
    ...(params.currentNode?.platform ? { platform: params.currentNode.platform } : {}),
    ...(params.currentNode?.deviceFamily ? { deviceFamily: params.currentNode.deviceFamily } : {}),
    commands: declaredCommands,
    approvedCommands: declaredCommands,
  });
  const requiredNodeCommand = resolveRequiredNodeCommandAuthority({
    requiredCommands: requirement.requiredNodeCommands,
    declaredCommands: params.currentNode?.declaredCommands ?? declaredCommands,
    effectiveCommands: params.currentNode?.commands ?? declaredCommands,
    withheldCommands: params.currentNode ? readNodeSessionWithheldCommands(params.currentNode) : [],
    allowlist,
  });
  if (requiredNodeCommand && requiredNodeCommand.state !== "invocable") {
    return {
      ok: false,
      error: `paired-device command ${requiredNodeCommand.command} is not enabled or approved for ${deviceId}; enable it in gateway.nodes.commands.allow and approve the command on the node`,
    };
  }
  if (requirement.consumesWorkerSlot && node.workerHost.capacity.available <= 0) {
    return {
      ok: false,
      error: deviceUnavailableText(deviceId, {
        available: false,
        unavailableReason: "at-capacity",
      }),
    };
  }
  return { ok: true, availableSlots: node.workerHost.capacity.available, node };
}
