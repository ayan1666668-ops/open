import type { NodeVersionManager } from "./version-manager-path.js";

export type UpdateRecoveryStep =
  | {
      kind:
        | "preserve-context"
        | "select-runtime"
        | "install-package"
        | "refresh-service"
        | "restart-service"
        | "verify";
      command: string;
    }
  | {
      kind: "select-runtime" | "preserve-context" | "service-owner" | "deployment";
      instruction: string;
    };

export function formatUpdateRecoverySteps(steps: readonly UpdateRecoveryStep[]): string {
  return steps
    .map(
      (step, index) =>
        `${index + 1}. ${"command" in step ? `Run \`${step.command}\`.` : step.instruction}`,
    )
    .join("\n");
}

export function createRuntimeUpdateRecoverySteps(params: {
  nodeVersion: string;
  targetVersion: string;
  manager: NodeVersionManager;
  service: "refresh" | "absent" | "owner";
  container: boolean;
  contextCommand?: string;
  installPackage?: boolean;
  command: (value: string) => string;
}): UpdateRecoveryStep[] {
  const { nodeVersion, targetVersion, manager, command } = params;
  const underNode = (value: string) =>
    manager === "volta" ? `volta run --node ${nodeVersion} ${value}` : value;
  const cli = (value: string) => underNode(command(value));
  if (params.container) {
    return [
      {
        kind: "deployment",
        instruction: `Pull or build an OpenClaw image with version ${targetVersion} and Node ${nodeVersion}, then recreate or redeploy the container with the same state/config mounts. In-container package changes are not durable.`,
      },
    ];
  }
  const runtimeCommand =
    manager === "nvm"
      ? `nvm install ${nodeVersion} && nvm use ${nodeVersion}`
      : manager === "fnm"
        ? `fnm install ${nodeVersion} && fnm use ${nodeVersion}`
        : manager === "volta"
          ? `volta install node@${nodeVersion}`
          : undefined;
  return [
    {
      kind: "preserve-context",
      instruction:
        "Use the same service account and keep the existing OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH overrides throughout recovery.",
    },
    ...(params.contextCommand
      ? [{ kind: "preserve-context" as const, command: params.contextCommand }]
      : []),
    runtimeCommand
      ? { kind: "select-runtime", command: runtimeCommand }
      : {
          kind: "select-runtime",
          instruction: `Install and select Node ${nodeVersion} using ${manager === "other" ? "your version manager" : "your system package manager or https://nodejs.org/en/download"}.`,
        },
    ...(params.installPackage === false
      ? []
      : [
          {
            kind: "install-package" as const,
            command: underNode(`npm install -g openclaw@${targetVersion}`),
          },
        ]),
    ...(params.service === "refresh"
      ? [
          {
            kind: "refresh-service" as const,
            command: cli(
              `openclaw gateway install --force --runtime-path "$(${underNode("node")} -p 'process.execPath')"`,
            ),
          },
          { kind: "restart-service" as const, command: cli("openclaw gateway restart") },
        ]
      : params.service === "owner"
        ? [
            {
              kind: "service-owner" as const,
              instruction:
                "Have the existing Gateway service or deployment owner select the new Node runtime and OpenClaw install, then restart it with the same account, state, and configuration. Service ownership or permission to rewrite its definition was not established.",
            },
          ]
        : []),
    {
      kind: "verify",
      command: `${cli("openclaw --version")} && ${cli("openclaw status")}`,
    },
  ];
}

export const UPDATE_ACTIVATION_TIMEOUT_REASON = "update-activation-timeout";
export const UPDATE_GLOBAL_PERMISSION_REASON = "global-install-permission-denied";
export const UPDATE_ENVIRONMENT_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "node-runtime-preflight",
  UPDATE_GLOBAL_PERMISSION_REASON,
]);

export function formatUpdateActivationTimeoutGuidance(
  command: (value: string) => string = (value) => value,
): string {
  return `Inspect \`${command("openclaw update status")}\` and \`${command("openclaw doctor")}\`. Wait for the owning updater and its child processes to stop before running \`${command("openclaw update repair")}\`. The timeout does not make rollback or removal of retained update state safe.`;
}

export const UPDATE_INSTALL_SKIP_GUIDANCE: Readonly<Record<string, string>> = {
  "container-image-install":
    "Pull or build the target Docker/container image, then redeploy it with the same state/config mounts. No package changes or Gateway restart were attempted.",
  "unmanaged-package-install":
    "No npm, pnpm, or Bun global owner was detected. Reinstall using the original method; use Yarn for Yarn global installs. No package changes or Gateway restart were attempted.",
  "package-update-requires-cli":
    "Run `openclaw update` through this install's npm, pnpm, or Bun global launcher. No package changes or Gateway restart were attempted.",
};

export const SKIPPED_UPDATE_OUTCOMES: Readonly<Record<string, "pending" | "noop">> = {
  "managed-service-handoff-started": "pending",
  "restart-health-pending": "pending",
  "already-current": "noop",
  "gateway-readiness-unverified": "noop",
  "managed-service-handoff-already-running": "noop",
  "managed-service-handoff-cancelled": "noop",
  "container-image-install": "noop",
  "unmanaged-package-install": "noop",
  "package-update-requires-cli": "noop",
  "update-ledger-busy": "noop",
};

/** A skipped update can be a handoff, an intentional no-op, or a failed attempt. */
export function classifyUpdateOutcome(outcome: {
  status?: string;
  reason?: string;
}): "succeeded" | "pending" | "noop" | "failed" | undefined {
  if (outcome.status === "ok") {
    return "succeeded";
  }
  if (outcome.status === "error") {
    return "failed";
  }
  if (outcome.status !== "skipped") {
    return undefined;
  }
  return outcome.reason !== undefined && Object.hasOwn(SKIPPED_UPDATE_OUTCOMES, outcome.reason)
    ? SKIPPED_UPDATE_OUTCOMES[outcome.reason]
    : "failed";
}

/** Ledger refusals can be failed attempts even when no update work started. */
export function isReportableUpdateRun(run: { status: string; reason: string | null }): boolean {
  if (run.status === "failed" || run.status === "rolled-back") {
    return true;
  }
  // These are intentional CLI ledger outcomes, not failed update attempts.
  // Reuse the result owner's classification for all other skipped outcomes.
  return (
    run.status === "skipped" &&
    run.reason !== null &&
    run.reason !== "dry-run" &&
    run.reason !== "cancelled" &&
    classifyUpdateOutcome({ status: run.status, reason: run.reason }) === "failed"
  );
}
