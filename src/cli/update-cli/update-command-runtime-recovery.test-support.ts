import path from "node:path";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { UpdateRecoveryStep } from "../../shared/update-outcome.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { quoteCliArg, quotePowerShellArg } from "../quote-cli-arg.js";

// Independent operator-facing fixtures shared by CLI and preflight boundary tests.
export function expectedPlainRecovery(
  version: string,
  node: string,
  service: "refresh" | "owner" | "absent" = "owner",
  context = service === "refresh"
    ? "unset OPENCLAW_HOME OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH OPENCLAW_PROFILE OPENCLAW_GATEWAY_PORT OPENCLAW_LAUNCHD_LABEL OPENCLAW_SYSTEMD_UNIT OPENCLAW_WINDOWS_TASK_NAME OPENCLAW_WORKSPACE_DIR"
    : undefined,
): string {
  return [
    "Recovery:",
    "1. Use the same service account and keep the existing OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH overrides throughout recovery.",
    ...(context ? [`2. Run \`${context}\`.`] : []),
    `2. Install and select Node ${node} using your system package manager or https://nodejs.org/en/download.`,
    `3. Run \`npm install -g openclaw@${version}\`.`,
    ...(service === "refresh"
      ? [
          "4. Run `openclaw gateway install --force --runtime-path \"$(node -p 'process.execPath')\"`.",
          "5. Run `openclaw gateway restart`.",
          "6. Run `openclaw --version && openclaw status`.",
        ]
      : service === "owner"
        ? [
            "4. Have the existing Gateway service or deployment owner select the new Node runtime and OpenClaw install, then restart it with the same account, state, and configuration. Service ownership or permission to rewrite its definition was not established.",
            "5. Run `openclaw --version && openclaw status`.",
          ]
        : ["4. Run `openclaw --version && openclaw status`."]),
  ]
    .map((line, index) => (index ? line.replace(/^\d+\./, `${index}.`) : line))
    .join("\n");
}

export function expectedManagedRuntimeRecoverySteps(
  manager: "nvm" | "system",
): UpdateRecoveryStep[] {
  return [
    {
      kind: "preserve-context",
      instruction:
        "Use the same service account and keep the existing OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH overrides throughout recovery.",
    },
    {
      kind: "preserve-context",
      command:
        "unset OPENCLAW_HOME OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH OPENCLAW_PROFILE OPENCLAW_GATEWAY_PORT OPENCLAW_LAUNCHD_LABEL OPENCLAW_SYSTEMD_UNIT OPENCLAW_WINDOWS_TASK_NAME OPENCLAW_WORKSPACE_DIR",
    },
    manager === "nvm"
      ? { kind: "select-runtime", command: "nvm install 24.16.0 && nvm use 24.16.0" }
      : {
          kind: "select-runtime",
          instruction:
            "Install and select Node 24.16.0 using your system package manager or https://nodejs.org/en/download.",
        },
    { kind: "install-package", command: "npm install -g openclaw@2026.5.20" },
    {
      kind: "refresh-service",
      command: "openclaw gateway install --force --runtime-path \"$(node -p 'process.execPath')\"",
    },
    { kind: "restart-service", command: "openclaw gateway restart" },
    { kind: "verify", command: "openclaw --version && openclaw status" },
  ];
}

export const unsupportedServiceRuntimeFixture = {
  status: "unsupported",
  version: "22.18.0",
  sqliteVersion: "3.51.3",
  nodeSharedSqlite: false,
  sqliteProbe: { available: true, version: "3.51.3", text: false, blob: true, json: true },
  capabilityError: "Node 22.18.0: node:sqlite truncates TEXT at embedded NUL (nodejs/node#61954)",
} as const;

export function runtimeRecoveryCommandFixture(serviceNode: string) {
  return async (argv: readonly string[]) =>
    createCommandResult({
      stdout:
        argv[0] === serviceNode && argv[1] === "--version"
          ? "v22.18.0\n"
          : argv[0] === "npm" && argv[1] === "--version"
            ? "12.0.0\n"
            : "",
    });
}

export function currentGitCoreFixture(root: string, version: string) {
  const outcome: UpdateRunResult = {
    status: "skipped",
    mode: "git",
    root,
    reason: "already-current",
    before: { version, sha: "abc123" },
    steps: [],
    durationMs: 1,
  };
  const entry = path.join(root, "openclaw.mjs");
  const launcher = `node ${process.platform === "win32" ? quotePowerShellArg(entry) : quoteCliArg(entry)}`;
  const recoverySteps: UpdateRecoveryStep[] = [
    {
      kind: "preserve-context",
      instruction:
        "Use the same service account and keep the existing OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH overrides throughout recovery.",
    },
    {
      kind: "select-runtime",
      instruction:
        "Install and select Node 24.16.0 using your system package manager or https://nodejs.org/en/download.",
    },
    { kind: "verify", command: `${launcher} --version && ${launcher} status` },
  ];
  return {
    outcome,
    converged: {
      status: "skipped",
      reason: "already-current",
      after: { version, sha: "abc123" },
      postUpdate: { plugins: { changed: false } },
    },
    runtimeRefusal: {
      status: "error",
      reason: "node-runtime-preflight",
      failedStep: { recoverySteps },
    },
  };
}
