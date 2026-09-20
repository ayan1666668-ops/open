import { createHash } from "node:crypto";
import fs, { fstatSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { gitNullConfigPath } from "./git-exec.js";
import { classifyPartialCloneGitFailure } from "./update-runner-git-target.js";
import { prepareGitCandidateTransfer } from "./update-runner-git-transfer.js";
import type { CommandRunner, RunStepOptions, UpdateStepResult } from "./update-runner-types.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { state: "partial-clone", expected: "promised objects in this partial clone" },
  { state: "unverified", expected: "did not verify repository corruption" },
  { state: "corrupt", expected: "verified repository corruption" },
])(
  "classifies Git's unverified corruption claim from repository evidence ($state)",
  async ({ state, expected }) => {
    const stderr =
      "fatal: object is in the commit graph file but not in the object database. This is probably due to repo corruption.";
    const runCommand: CommandRunner = async (argv) => {
      if (argv.includes("--get-regexp")) {
        return {
          code: state === "partial-clone" ? 0 : 1,
          stdout: state === "partial-clone" ? "remote.origin.promisor true\n" : "",
          stderr: "",
        };
      }
      return {
        code: state === "corrupt" ? 1 : 0,
        stdout: "",
        stderr: state === "corrupt" ? "missing blob 0123456789abcdef" : "",
      };
    };
    const result = await classifyPartialCloneGitFailure({
      result: { code: 128, stdout: "", stderr },
      root: "/partial-clone",
      runCommand,
      timeoutMs: 1_000,
    });
    expect(result.stderr).toContain(expected);
    if (state === "partial-clone") {
      expect(result.stderr).not.toContain("repo corruption");
      expect(result.stderr).toContain("sed -n 's/^?//p'");
    }
  },
);

it("uses the installed checkout runner for partial-clone classification", async () => {
  const results: UpdateStepResult[] = [];
  const inspectionRunCommand: CommandRunner = async () => ({
    code: 128,
    stdout: "",
    stderr:
      "fatal: object is in the commit graph file but not in the object database. " +
      "This is probably due to repo corruption.",
  });
  let installedConfigProbed = false;
  const installedRunCommand: CommandRunner = async (argv) => {
    installedConfigProbed = argv.includes("--get-regexp");
    return {
      code: 0,
      stdout: "remote.origin.promisor true\n",
      stderr: "",
    };
  };

  const transfer = await prepareGitCandidateTransfer({
    candidateSha: "candidate",
    beforeSha: null,
    installedRoot: "/installed",
    installedRunCommand,
    probeTimeoutMs: 1_000,
    step: {
      runCommand: inspectionRunCommand,
      cwd: "/inspection",
      argv: [],
      name: "transfer proof",
      timeoutMs: 1_000,
      stepIndex: 0,
      totalSteps: 1,
      results,
    },
  });

  expect(transfer).toBeUndefined();
  expect(installedConfigProbed).toBe(true);
  expect(results.at(-1)?.stderrTail).toContain("promised objects in this partial clone");
});

// Windows forcibly terminates children instead of delivering the handled POSIX signal.
it
  .skipIf(process.platform === "win32")
  .each([
    "none",
    "inventory",
    "pack",
    "retry",
    "missing-before",
    "legacy-git",
    "configured-limit",
    "large-history",
  ] as const)("bounds transfer inventories and binary input (failure=%s)", async (failure) => {
  const overflow = failure === "inventory";
  const oversized = failure === "pack";
  const root = temporary.make("git-transfer-bounds-");
  const source = path.join(root, "source");
  const install = path.join(root, "install");
  fs.mkdirSync(source);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitNullConfigPath(),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], {
      timeoutMs: 15_000,
      env,
    });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Transfer fixture");
  await git(source, "config", "user.email", "fixture@example.invalid");
  const baseBytes = Buffer.concat(
    Array.from({ length: 4096 }, (_, index) =>
      createHash("sha256").update(`base:${index}`).digest(),
    ),
  );
  fs.writeFileSync(path.join(source, "base"), baseBytes);
  await git(source, "add", ".");
  await git(source, "commit", "-m", "base");
  const beforeSha = await git(source, "rev-parse", "HEAD");
  await git(source, "config", "uploadpack.allowFilter", "true");
  await git(
    root,
    "clone",
    ...(failure === "missing-before"
      ? ["--filter=blob:none", "--no-checkout", `file://${source}`, install]
      : [source, install]),
  );
  if (failure === "missing-before") {
    const missing = await runCommandWithTimeout(
      ["git", "--no-lazy-fetch", "-C", install, "cat-file", "-e", `${beforeSha}:base`],
      { timeoutMs: 15_000, env },
    );
    expect(missing.code).not.toBe(0);
  }
  for (let index = 0; index < 250; index++) {
    const bytes = Buffer.concat(
      Array.from({ length: failure === "configured-limit" ? 320 : 8 }, (_, block) =>
        createHash("sha256").update(`${index}:${block}`).digest(),
      ),
    );
    fs.writeFileSync(path.join(source, `object-${index}`), bytes);
  }
  await git(source, "add", ".");
  await git(source, "commit", "-m", "candidate");
  const candidateSha = await git(source, "rev-parse", "HEAD");
  if (failure === "configured-limit") {
    await git(source, "config", "pack.packSizeLimit", "1m");
  }
  const results: UpdateStepResult[] = [];
  let inventoryBytes = 0;
  let packBytes = 0;
  let historyInventoryAllowsMissingObjects = false;
  const runCommand: CommandRunner = async (argv, options) => {
    const isHistoryInventory = argv.includes("rev-list") && argv.includes("--missing=allow-any");
    if (isHistoryInventory && argv.includes(candidateSha)) {
      historyInventoryAllowsMissingObjects = argv.includes("--missing=allow-any");
    }
    if (failure === "legacy-git" && argv.includes("--no-lazy-fetch") && argv.includes("version")) {
      return { code: 129, stdout: "", stderr: "unknown option: --no-lazy-fetch" };
    }
    if (failure === "large-history" && isHistoryInventory) {
      const script = `const { spawnSync } = require("node:child_process");
        const result = spawnSync(process.argv[1], process.argv.slice(2), { encoding: null });
        if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status ?? 1); }
        const target = 17 * 1024 * 1024;
        for (let written = 0; written < target; written += result.stdout.length) process.stdout.write(result.stdout);`;
      return await runCommandWithTimeout([process.execPath, "-e", script, ...argv], {
        ...options,
        env,
      });
    }
    if (argv.includes("pack-objects")) {
      inventoryBytes = fstatSync(options.stdinFileDescriptor!).size;
    }
    if (argv.includes("index-pack")) {
      packBytes = (options.input as Buffer).byteLength;
    }
    const result = await runCommandWithTimeout(argv, { ...options, env });
    if (oversized && argv.includes("pack-objects") && result.code === 0) {
      // Grow a real staged pack sparsely; refusal must precede a large allocation.
      const packPath = `${argv.at(-1)}-${result.stdout.trim()}.pack`;
      fs.chmodSync(packPath, 0o600);
      fs.truncateSync(packPath, 256 * 1024 * 1024 + 1);
    }
    return result;
  };
  const step = (cwd: string): RunStepOptions => ({
    runCommand,
    cwd,
    argv: [],
    name: "transfer proof",
    timeoutMs: 15_000,
    stepIndex: 0,
    totalSteps: 1,
    results,
  });
  let transfer = await prepareGitCandidateTransfer({
    candidateSha,
    beforeSha,
    installedRoot: install,
    installedRunCommand: runCommand,
    probeTimeoutMs: 15_000,
    step: step(source),
    ...(overflow ? { historyInventoryLimitBytes: 41 * 12 } : {}),
  });
  expect(historyInventoryAllowsMissingObjects).toBe(true);
  if (overflow || oversized) {
    expect(transfer).toBeUndefined();
    if (overflow) {
      const boundedExitObserved = results.some(
        (result) =>
          result.name === "git update history" &&
          result.failureFacts?.some((fact) => fact.code === "history-inventory-too-large"),
      );
      expect(boundedExitObserved).toBe(true);
      expect(results).toContainEqual(
        expect.objectContaining({
          name: "git update history",
          signal: null,
          stderrTail: expect.stringMatching(/objects=\d+ bytes=\d+ limit=492/u),
        }),
      );
      expect(inventoryBytes).toBe(0);
    } else {
      expect(results).toContainEqual(
        expect.objectContaining({
          exitCode: 1,
          stderrTail: expect.stringContaining("file exceeds limit of 268435456 bytes"),
        }),
      );
    }
    expect(await git(install, "rev-parse", "HEAD")).toBe(beforeSha);
    return;
  }
  expect(transfer).toBeDefined();
  expect(inventoryBytes).toBeGreaterThan(8000);
  if (failure === "large-history") {
    expect(inventoryBytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(results).toContainEqual(
      expect.objectContaining({
        name: "git update history",
        stdoutTail: expect.stringMatching(/objects=\d+ bytes=\d+/u),
      }),
    );
  }
  expect(await transfer!.importInto(step(install))).toBe(true);
  expect(packBytes).toBeGreaterThan(8000);
  if (failure === "none") {
    expect(packBytes).toBeLessThan(baseBytes.length);
  }
  if (failure === "missing-before" || failure === "legacy-git") {
    expect(packBytes).toBeGreaterThan(baseBytes.length);
  }
  if (failure === "retry") {
    await transfer!.cleanup(step(install));
    const inspection = path.join(root, "inspection.git");
    await git(root, "clone", "--mirror", "--shared", install, inspection);
    await git(inspection, "update-ref", "refs/heads/candidate", candidateSha);
    transfer = await prepareGitCandidateTransfer({
      candidateSha,
      beforeSha,
      installedRoot: install,
      installedRunCommand: runCommand,
      probeTimeoutMs: 15_000,
      step: step(inspection),
    });
    expect(transfer).toBeDefined();
    expect(await transfer!.importInto(step(install))).toBe(true);
    await git(install, "repack", "-a", "-d");
  }
  await git(install, "checkout", "--detach", candidateSha);
  await transfer!.cleanup(step(install));
  if (failure === "configured-limit") {
    expect(packBytes).toBeGreaterThan(1024 * 1024);
    expect(await git(source, "config", "pack.packSizeLimit")).toBe("1m");
  }
  expect(fs.readFileSync(path.join(install, "base"))).toEqual(baseBytes);
  for (let index = 0; index < 250; index++) {
    expect(fs.readFileSync(path.join(install, `object-${index}`))).toEqual(
      fs.readFileSync(path.join(source, `object-${index}`)),
    );
  }
});
