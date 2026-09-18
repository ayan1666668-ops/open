import { formatCliCommand } from "../cli/command-format.js";
import {
  inspectGatewayRestart,
  renderRestartDiagnostics,
  waitForGatewayHealthyRestart,
} from "../cli/daemon-cli/restart-health.js";
import { gatewayMaintenanceBlockMessage } from "../cli/update-cli/update-command-handoff.js";
import {
  maybeStopManagedServiceBeforeMutableUpdate,
  revalidateManagedGatewayServiceAfterUpdate,
  type PreManagedServiceStop,
} from "../cli/update-cli/update-command-service-maintenance.js";
import { resolveUpdatedGatewayRestartPort } from "../cli/update-cli/update-command-service-plan.js";
import { withGatewayServiceOperationLock } from "../daemon/service-operation-lock.js";
import { readGatewayServiceState, resolveGatewayService } from "../daemon/service.js";
import { readLegacyGatewayLockIdentity } from "../infra/gateway-lock-legacy.js";
import { readPackageVersion } from "../infra/package-json.js";
import { UpdateDoctorError } from "../infra/update-doctor-result.js";
import { createUpdateFailureFact } from "../infra/update-failure-facts.js";
import { readBuiltGatewayBuildId } from "../infra/update-git-runtime.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";

export type DoctorStaleGatewayReplacement = {
  version: string;
  buildId: string;
  warning: string;
  inspection: PreManagedServiceStop;
};

/** Reuse native service custody and restart health before admitting a stale updater child. */
export async function replaceStaleDoctorGateway(params: {
  root: string;
  env: NodeJS.ProcessEnv;
  before: PreManagedServiceStop;
  stdout: NodeJS.WritableStream;
  assertCurrent?: () => void;
}): Promise<DoctorStaleGatewayReplacement | undefined> {
  const { before, root, env } = params;
  const fail = (code: string, detail: string, cause?: unknown): never => {
    const restart = formatCliCommand("openclaw gateway restart", env);
    const status = formatCliCommand("openclaw gateway status --deep", env);
    const message = `Stale Gateway replacement failed. ${detail} Run ${restart}; inspect ${status}.`;
    throw new UpdateDoctorError(
      message,
      [
        createUpdateFailureFact({ check: "gateway", code, message: detail }, env),
        createUpdateFailureFact(
          { check: "gateway", code: "stale-gateway-recovery-command", message: restart },
          env,
        ),
      ],
      { cause },
    );
  };
  const legacy = await readLegacyGatewayLockIdentity(env);
  if (!before.running && !legacy) {
    return undefined;
  }
  const serviceEnv = before.serviceEnv ?? env;
  const service = resolveGatewayService();
  const [version, buildId, serviceCommand] = await Promise.all([
    readPackageVersion(root),
    readBuiltGatewayBuildId(root),
    service.readCommand(serviceEnv).catch(() => null),
  ]);
  params.assertCurrent?.();
  if ((!version || !buildId) && !legacy) {
    return undefined;
  }
  const port = await resolveUpdatedGatewayRestartPort({ serviceEnv, serviceCommand });
  const health = await inspectGatewayRestart({
    service,
    port,
    env: serviceEnv,
    expectedVersion: version,
    expectedBuildId: buildId,
    requirePluginHealth: false,
  });
  params.assertCurrent?.();
  // A live legacy lock identifies predecessor code even when its removed chunks
  // prevent the hello handshake. The current Gateway never writes that lock.
  const legacyPid = legacy?.state === "alive" ? legacy.pid : undefined;
  const stale =
    health.buildIdMismatch?.actual != null ||
    health.versionMismatch ||
    legacy ||
    health.probeError?.startsWith("gateway closed (1011): gateway message handler unavailable");
  if (!stale) {
    return undefined;
  }
  const pid = legacyPid ?? before.servicePid ?? health.runtime.pid;
  if (
    before.serviceUpdateVerdict?.kind !== "owned" ||
    !before.serviceEnv ||
    !before.running ||
    (legacy && (legacy.state !== "alive" || legacy.pid !== before.servicePid))
  ) {
    return fail(
      "stale-gateway-service-unverified",
      `Gateway PID ${pid ?? "unknown"} is stale, but its managed service ownership is unverified. ${before.blockMessage ?? before.serviceMutationSkipMessage ?? ""}`,
    );
  }
  if (!version || !buildId) {
    return fail(
      "stale-gateway-restart-failed",
      "The installed candidate's build identity is unavailable.",
    );
  }
  const expected = {
    ...before,
    serviceUpdateVerdict: { ...before.serviceUpdateVerdict, refreshDefinition: false },
  };
  try {
    await withGatewayServiceOperationLock(serviceEnv, async (assertNative) => {
      const assertCurrent = () => {
        assertNative();
        params.assertCurrent?.();
      };
      const current = await readGatewayServiceState(service, {
        env: serviceEnv,
        requireEffective: true,
        requireLoadedCommand: true,
      });
      assertCurrent();
      await revalidateManagedGatewayServiceAfterUpdate({
        state: current,
        root,
        preManagedServiceStop: expected,
      });
      assertCurrent();
      if (pid !== undefined && current.runtime?.pid !== pid) {
        throw new Error("The managed Gateway PID changed during stale-instance inspection.");
      }
      const ancestryBlock = gatewayMaintenanceBlockMessage(current, root);
      if (ancestryBlock) {
        throw new Error(ancestryBlock);
      }
      await service.restart({
        env: current.env,
        stdout: params.stdout,
        preserveDefinition: true,
        assertCurrent,
      });
      assertCurrent();
    });
    const replacement = await waitForGatewayHealthyRestart({
      service,
      port,
      env: serviceEnv,
      expectedVersion: version,
      expectedBuildId: buildId,
      requireRunningService: true,
      requirePluginHealth: false,
      settle: { probes: 12 },
    });
    params.assertCurrent?.();
    if (!replacement.healthy) {
      throw new Error(renderRestartDiagnostics(replacement).join(" "));
    }
    const inspection = await maybeStopManagedServiceBeforeMutableUpdate({
      root,
      updateInstallKind: "package",
      shouldRestart: true,
      jsonMode: true,
      phase: "inspect",
      expectedService: expected,
      assertCurrent: params.assertCurrent,
    });
    params.assertCurrent?.();
    if (
      inspection.serviceUpdateVerdict?.kind !== "owned" ||
      !inspection.running ||
      inspection.servicePid !== replacement.runtime.pid
    ) {
      throw new Error("The replacement Gateway's service ownership changed after verification.");
    }
    return {
      version,
      buildId,
      inspection,
      warning: `Warning: Replaced stale Gateway PID ${pid ?? "unknown"} through its service manager; verified ${version} build ${buildId} before Doctor maintenance.`,
    };
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    return fail("stale-gateway-restart-failed", String(error), error);
  }
}
