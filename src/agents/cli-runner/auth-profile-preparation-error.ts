/** Typed terminal fact for a selected profile that fails before CLI spawn. */
import { buildOAuthRefreshFailureLoginCommand } from "../auth-profiles/oauth-refresh-failure.js";
import { FailoverError } from "../failover-error.js";

export class CliAuthProfilePreparationError extends FailoverError {
  declare readonly profileId: string;
  declare readonly provider: string;
  readonly agentDir: string;

  constructor(params: {
    message: string;
    profileId: string;
    provider: string;
    agentDir: string;
    cause?: unknown;
  }) {
    super(params.message, {
      reason: "auth",
      provider: params.provider,
      profileId: params.profileId,
      cause: params.cause,
    });
    this.name = "CliAuthProfilePreparationError";
    this.agentDir = params.agentDir;
  }
}

type CliAuthProfileResolutionFailure =
  | { kind: "unmaterialized" }
  | { kind: "resolved-as-other"; resolvedProfileId: string };

function describeCliAuthProfileResolutionFailure(
  profileId: string,
  failure: CliAuthProfileResolutionFailure,
): string {
  switch (failure.kind) {
    case "resolved-as-other":
      return `selected auth profile "${profileId}" resolved as "${failure.resolvedProfileId}"`;
    case "unmaterialized":
      return `could not materialize selected auth profile "${profileId}"`;
  }
  return failure satisfies never;
}

export function buildCliAuthProfileResolutionError(params: {
  backendId: string;
  profileId: string;
  provider: string;
  agentDir: string;
  failure: CliAuthProfileResolutionFailure;
}): CliAuthProfilePreparationError {
  const loginCommand = buildOAuthRefreshFailureLoginCommand(params.provider, {
    profileId: params.profileId,
  });
  const reason = describeCliAuthProfileResolutionFailure(params.profileId, params.failure);
  return new CliAuthProfilePreparationError({
    message: `CLI backend "${params.backendId}" ${reason}. Re-authenticate with: ${loginCommand}. OpenClaw did not start the run.`,
    profileId: params.profileId,
    provider: params.provider,
    agentDir: params.agentDir,
  });
}
