import fs from "node:fs/promises";
import path from "node:path";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import {
  formatUpdateCandidateRuntimeIdentity,
  resolveUpdateCandidateRuntimeIdentity,
} from "../../infra/update-candidate-runtime-identity.js";
import { resolveNodeRunner } from "./shared.js";
import {
  assertGatewayServiceManagementAllowedForUpdate,
  gatewayServiceCommandUsesRoot,
  resolveManagedServiceNodeRunner,
} from "./update-command-service-plan.js";

/** Verify the durable service definition selects the exact admitted package and Node runtime. */
export async function assertUpdatedGatewayServiceBinding(params: {
  root: string;
  nodeRunner?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  assertCurrent: () => void;
}): Promise<void> {
  const identity = await resolveUpdateCandidateRuntimeIdentity({
    root: params.root,
    nodeRunner: params.nodeRunner ?? resolveNodeRunner(),
  });
  const state = await readGatewayServiceState(resolveGatewayService(), {
    env: params.env,
    requireEffective: true,
    requireLoadedCommand: true,
    validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
    timeoutMs: params.timeoutMs,
  });
  params.assertCurrent();
  const installedNodeRunner = resolveManagedServiceNodeRunner(state.command);
  const rootMatches = await gatewayServiceCommandUsesRoot({
    root: identity.root,
    command: state.command,
    env: params.env,
  });
  const installedNodeRealPath = installedNodeRunner
    ? await fs.realpath(path.resolve(installedNodeRunner)).catch(() => undefined)
    : undefined;
  if (
    rootMatches !== true ||
    !installedNodeRealPath ||
    installedNodeRealPath !== identity.nodeRunner
  ) {
    throw new Error(
      `Gateway service binding does not match the admitted candidate (${formatUpdateCandidateRuntimeIdentity(identity)}); ` +
        `service-node=${installedNodeRunner ?? "missing"}; service-node-realpath=${installedNodeRealPath ?? "unresolved"}; service-root-match=${String(rootMatches)}.`,
    );
  }
}
