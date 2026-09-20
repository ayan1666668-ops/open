import { resolveVitestPretestBuildMode } from "./vitest-build-prerequisites.mts";

export type WindowsTestShard = {
  check_name: string;
  targets: string[];
  predicted_seconds: number;
};

// Run 35520647082, jobs 106104133329/106104133245: summed case seconds,
// rounded up. Timings guide placement; package scripts alone own coverage.
const fileSeconds: Readonly<Record<string, number>> = {
  "extensions/acpx/src/runtime-argv.process.test.ts": 11,
  "src/agents/sessions/exec.real.test.ts": 7,
  "src/agents/worktrees/git.test.ts": 4,
  "src/commands/doctor-lint.state-isolation.test.ts": 33,
  "src/config/sessions/session-accessor.sqlite-archive.worker.test.ts": 19,
  "src/daemon/schtasks.env-case.real.test.ts": 5,
  "src/flows/doctor-health-contributions.windows-cloud-state.test.ts": 4,
  "src/gateway/gateway-cron-process-identity.windows.test.ts": 8,
  "src/gateway/worker-environments/workspace-result-ref-mutation.test.ts": 9,
  "src/infra/sqlite-snapshot-staging.cancellation.test.ts": 6,
  "src/infra/update-candidate-state.budget.test.ts": 15,
  "src/infra/update-candidate-state.cleanup.test.ts": 20,
  "src/infra/update-candidate-state.namespaced-paths.test.ts": 10,
  "src/infra/update-candidate-state.online-backup.process.test.ts": 4,
  "src/infra/update-managed-service-handoff-database-publication.test.ts": 5,
  "src/node-host/invoke-agent-cli-claude.test.ts": 5,
  "src/process/exec.windows.integration.test.ts": 101,
  "src/process/supervisor/supervisor.anchored-shell.real.test.ts": 4,
  "src/process/windows-command.test.ts": 7,
  "src/skills/runtime/refresh.missing-root.integration.test.ts": 8,
  "src/state/openclaw-database-paths.windows.test.ts": 6,
  "src/state/openclaw-state-ownership.test.ts": 6,
  "test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts": 18,
  "test/helpers/openclaw-test-instance.test.ts": 25,
  "test/scripts/check-openclaw-package-tarball.test.ts": 52,
  "test/scripts/ci-platform-checkout.test.ts": 42,
  "test/scripts/direct-run-entrypoints.test.ts": 16,
  "test/scripts/install-ps1.test.ts": 18,
  "test/scripts/tsdown-declaration-resolution.test.ts": 79,
  "test/scripts/vitest-worker-artifacts.test.ts": 214,
  "test/scripts/vitest-worker-artifacts.transforms.test.ts": 9,
  "test/scripts/worker-deploy-build-plugin.test.ts": 13,
  "test/scripts/write-plugin-sdk-entry-dts.test.ts": 68,
  "test/scripts/write-unified-entry-dts.test.ts": 62,
};

const setupSeconds = 65;
const runtimeBuildSeconds = 56;
const perFileOverheadSeconds = 3;
const fallbackFileSeconds = 3;
const targetSeconds = 420;

function readWindowsTargets(scripts: Readonly<Record<string, string | undefined>>): string[] {
  const targets = [1, 2].flatMap((part) => {
    const script = scripts[`test:windows:ci:${part}`];
    const match = script?.match(/^node --import \S+ scripts\/test-projects\.mts (.+)$/u);
    const files = match?.[1]?.trim().split(/\s+/u);
    if (!files?.length || files.some((file) => !/^[\w./-]+\.test\.tsx?$/u.test(file))) {
      throw new Error(`Windows CI part ${part} must declare explicit test-projects file targets`);
    }
    return files;
  });
  if (new Set(targets).size !== targets.length) {
    throw new Error("Windows CI package scripts must not repeat a test file");
  }
  return targets;
}

export function createWindowsTestShards(
  scripts: Readonly<Record<string, string | undefined>>,
): WindowsTestShard[] {
  const files = readWindowsTargets(scripts).map((file) => ({
    file,
    seconds: (fileSeconds[file] ?? fallbackFileSeconds) + perFileOverheadSeconds,
    requiresBuild: resolveVitestPretestBuildMode([{ includePatterns: [file] }]) !== undefined,
  }));
  files.sort(
    (left, right) =>
      right.seconds +
        Number(right.requiresBuild) * runtimeBuildSeconds -
        (left.seconds + Number(left.requiresBuild) * runtimeBuildSeconds) ||
      left.file.localeCompare(right.file, "en"),
  );

  for (const count of [4, 5]) {
    const shards = Array.from({ length: Math.min(count, files.length) }, (_, index) => ({
      check_name: `checks-windows-node-test-${index + 1}`,
      targets: [] as string[],
      predicted_seconds: setupSeconds,
      requiresBuild: false,
    }));
    for (const file of files) {
      const addedSeconds = (shard: (typeof shards)[number]) =>
        file.seconds + (file.requiresBuild && !shard.requiresBuild ? runtimeBuildSeconds : 0);
      const shard = shards.reduce((best, candidate) =>
        candidate.predicted_seconds + addedSeconds(candidate) <
        best.predicted_seconds + addedSeconds(best)
          ? candidate
          : best,
      );
      shard.predicted_seconds += addedSeconds(shard);
      shard.requiresBuild ||= file.requiresBuild;
      shard.targets.push(file.file);
    }
    // Keep whole files: splitting a fixture file would repeat its prepared compiler.
    // Growth may exceed the estimate, but must never remove coverage or exceed five jobs.
    if (count === 5 || shards.every((shard) => shard.predicted_seconds < targetSeconds)) {
      return shards.map(({ requiresBuild: _requiresBuild, ...shard }) => ({
        ...shard,
        targets: shard.targets.toSorted(),
      }));
    }
  }
  throw new Error("Windows CI shard count is unavailable");
}
