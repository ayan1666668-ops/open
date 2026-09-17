import path from "node:path";
import { summarizeGatewayServiceLayout } from "../../daemon/service-layout.js";
import { resolveManagedGatewayServiceCommand } from "../../daemon/service-types.js";
import { resolveCanonicalPath } from "../../infra/package-update-manager-preflight.js";
import { isPathStrictlyInside } from "../../infra/path-guards.js";
import { createUpdateFailureFact } from "../../infra/update-failure-facts.js";
import { inspectNpmGlobalDestination } from "../../infra/update-npm-prefix.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { UPDATE_FOREIGN_DESTINATION_REASON } from "../../shared/update-outcome.js";
import { formatCliCommand } from "../command-format.js";
import { quoteCliArg, quotePowerShellArg } from "../quote-cli-arg.js";
import {
  gatewayServiceCommandUsesRoot,
  isGatewayServiceManagementAllowedForUpdate,
  readManagedGatewayServiceCommandForUpdate,
} from "./update-command-service-plan.js";

/** Re-invocation after a Node switch must not adopt another prefix's package or launcher. */
export async function inspectPackageUpdateDestination(root: string, timeoutMs: number) {
  const destination = await inspectNpmGlobalDestination(runCommandWithTimeout, timeoutMs);
  // The update still targets the retained root. An unavailable PATH probe cannot
  // authorize moving it, and is not evidence that a different install is occupied.
  if (!destination || (!destination.packagePresent && !destination.launcherPresent)) {
    return null;
  }
  const manageable = isGatewayServiceManagementAllowedForUpdate(process.env);
  const command = manageable ? await readManagedGatewayServiceCommandForUpdate(process.env) : null;
  const ownsPackage =
    destination.packageRootReal !== null &&
    ((await resolveCanonicalPath(root)) === destination.packageRootReal ||
      (await gatewayServiceCommandUsesRoot({ root: destination.packageRootReal, command })) ===
        true);
  const ownsLauncher =
    !destination.launcherPresent ||
    (destination.packageRootReal !== null &&
      destination.launcherTarget !== null &&
      isPathStrictlyInside(destination.packageRootReal, destination.launcherTarget));
  if (ownsPackage && ownsLauncher) {
    return null;
  }
  const layout = await summarizeGatewayServiceLayout(command);
  const quote = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;
  const retry = formatCliCommand("openclaw update").replace(
    /^openclaw\b/,
    () => `node ${quote(path.resolve(root, "openclaw.mjs"))}`,
  );
  const wrapper = [
    process.env,
    command?.environment,
    resolveManagedGatewayServiceCommand(command)?.environment,
  ].some((env) => env?.OPENCLAW_WRAPPER?.trim());
  const launcherTarget = destination.launcherTarget;
  const select =
    command && !wrapper && ownsLauncher && launcherTarget
      ? formatCliCommand(
          `openclaw gateway install --force --runtime-path ${quote(process.execPath)}`,
        ).replace(/^openclaw\b/, () => `node ${quote(launcherTarget)}`)
      : undefined;
  const message = [
    `Selected npm destination ${destination.layout.prefix} is occupied by another OpenClaw installation: package ${destination.packageRoot}; launcher ${destination.launcher}${destination.launcherTarget ? ` -> ${destination.launcherTarget}` : " (target unresolved)"}.`,
    layout?.entrypoint
      ? `The selected service${layout.sourcePath ? ` (${layout.sourcePath})` : ""} uses ${layout.entrypoint}; it does not own this destination.`
      : "No selected managed service could be verified as owning this destination.",
    `No installation was attempted. Switch the runtime back and run \`${retry}\`.`,
    select
      ? `Alternatively, if the destination's owner agrees to use it for this service, explicitly select it with \`${select}\` and rerun the update. This changes the service binding; it does not grant ownership of another deployment's package.`
      : "Alternatively, ask the destination's deployment owner to resolve its package/launcher and select it for the intended service using their deployment procedure. Do not overwrite it.",
  ].join(" ");
  return {
    reason: UPDATE_FOREIGN_DESTINATION_REASON,
    message,
    failureFacts: [
      createUpdateFailureFact({
        check: "package-install",
        code: UPDATE_FOREIGN_DESTINATION_REASON,
        message,
      }),
    ],
  };
}
