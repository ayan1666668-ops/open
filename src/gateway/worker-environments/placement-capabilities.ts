import { OPENCLAW_AGENT_RUNTIME_ID } from "../../agents/agent-runtime-id.js";
import { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import type { GatewayAgentRuntime } from "../../shared/session-types.js";
import type { WorkerPlacementExecutionMode } from "./placement-record.js";

/** Returns the bounded placement and direct-node contracts of one active runtime. */
export function resolveWorkerPlacementCapabilities(runtime: string): {
  executionMode?: WorkerPlacementExecutionMode;
  devicePlacement?: NonNullable<GatewayAgentRuntime["devicePlacement"]>;
  nodeToolsSupported: boolean;
} {
  const runtimeId = runtime.trim();
  if (runtimeId === OPENCLAW_AGENT_RUNTIME_ID) {
    return {
      executionMode: "worker-turn",
      devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
      nodeToolsSupported: true,
    };
  }
  const harness = getRegisteredAgentHarness(runtimeId)?.harness;
  const nodeToolsSupported = harness?.nodeToolsSupported === true;
  const placement = harness?.cloudPlacement;
  if (!placement) {
    return { nodeToolsSupported };
  }
  const requirement = placement.devicePlacement;
  if (!requirement) {
    return { executionMode: placement.mode, nodeToolsSupported };
  }
  const requiredNodeCommands = [...new Set(requirement.requiredNodeCommands)].toSorted();
  // Invalid declarations disable placement. Dropping a command would silently weaken authority.
  if (
    requiredNodeCommands.length > 32 ||
    requiredNodeCommands.some(
      (command) => command.length === 0 || command.length > 128 || command.trim() !== command,
    )
  ) {
    return { executionMode: placement.mode, nodeToolsSupported };
  }
  return {
    executionMode: placement.mode,
    devicePlacement: { requiredNodeCommands, consumesWorkerSlot: requirement.consumesWorkerSlot },
    nodeToolsSupported,
  };
}
