import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ignore from "ignore";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { pnpmLockfileDocuments } from "../../scripts/lib/pnpm-lockfile-documents.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type WorkflowStep = {
  env?: Record<string, string>;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  name: string;
  on: Record<string, { types?: string[]; inputs?: Record<string, unknown> }>;
  permissions: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<
    string,
    { if?: string; permissions?: Record<string, string>; steps: WorkflowStep[] }
  >;
};

function readWorkflow(name: string): Workflow {
  return parse(readFileSync(`.github/workflows/${name}.yml`, "utf8")) as Workflow;
}

const reviewPermissions = {
  contents: "read",
  "pull-requests": "read",
  issues: "write",
  statuses: "write",
};
const runtimeActionPath = ".github/actions/setup-security-review";
const runtimeAction = parse(readFileSync(`${runtimeActionPath}/action.yml`, "utf8")) as {
  runs: { using: string; steps: WorkflowStep[] };
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("security review workflow trust boundaries", () => {
  it.each(["security-sensitive-guard", "dependency-guard"])(
    "%s executes trusted scripts with only metadata write permissions",
    (name) => {
      const workflow = readWorkflow(name);
      expect(workflow.permissions).toEqual(reviewPermissions);
      expect(Object.keys(workflow.jobs).length).toBeGreaterThan(0);
      for (const job of Object.values(workflow.jobs)) {
        expect(job.permissions ?? workflow.permissions).toEqual(reviewPermissions);
        const checkouts = job.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
        expect(checkouts).toHaveLength(1);
        expect(checkouts[0]?.with).toMatchObject({
          ref: "${{ github.workflow_sha }}",
          "persist-credentials": false,
        });
        const bootstrapSteps = job.steps.filter((step) => step.uses === `./${runtimeActionPath}`);
        expect(bootstrapSteps).toHaveLength(1);
        const bootstrapIndex = job.steps.indexOf(bootstrapSteps[0]!);
        expect(bootstrapIndex).toBeGreaterThan(job.steps.indexOf(checkouts[0]!));
        expect(bootstrapSteps[0]?.env).toBeUndefined();
        expect(bootstrapSteps[0]?.with).toBeUndefined();
        for (const step of job.steps) {
          if (step.uses && step.uses !== `./${runtimeActionPath}`) {
            // An unreviewed local action or artifact download could execute PR code
            // with the status/comment token, even if checkout itself remains safe.
            expect(step.uses).toMatch(
              name === "dependency-guard"
                ? /^actions\/(?:checkout|create-github-app-token)@[a-f0-9]{40}$/u
                : /^actions\/checkout@[a-f0-9]{40}$/u,
            );
          }
          if (step.uses?.startsWith("actions/create-github-app-token@") || step.run) {
            expect(job.steps.indexOf(step)).toBeGreaterThan(bootstrapIndex);
          }
          if (step.run) {
            expect(step.run).toBe(`node scripts/github/${name}.mjs`);
            expect(step.env?.GITHUB_TOKEN).toBe("${{ github.token }}");
          }
        }
        expect(job.steps.some((step) => step.run)).toBe(true);
      }
    },
  );

  it.each(["security-sensitive-guard", "dependency-guard"])(
    "%s reevaluates pushes and comment changes without canceling active work",
    (name) => {
      const workflow = readWorkflow(name);
      expect(workflow.on.pull_request_target?.types).toEqual(
        expect.arrayContaining(["opened", "reopened", "synchronize", "ready_for_review", "edited"]),
      );
      expect(workflow.on.issue_comment?.types).toEqual(["created", "edited", "deleted"]);
      expect(workflow.on.workflow_run).toBeUndefined();
      expect(workflow.on.pull_request_review).toBeUndefined();
      expect(workflow.on.workflow_dispatch?.inputs?.pr_number).toMatchObject({
        required: true,
        type: "string",
      });
      expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
    },
  );

  it.each([
    ["security-sensitive-guard", "/allow-security-sensitive-change"],
    ["dependency-guard", "/allow-dependencies-change"],
  ])("%s keeps ignored runs out of the pending PR evaluation group", (name, command) => {
    const workflow = readWorkflow(name);
    const condition = workflow.jobs[name]!.if!;
    const events = [
      { eventName: "pull_request_target", action: "synchronize", allowed: true },
      {
        eventName: "pull_request_target",
        action: "edited",
        draft: true,
        allowed: name !== "dependency-guard",
      },
      { action: "created", body: command, allowed: true },
      {
        action: "created",
        body: "/allow-security-sensitive-change\n/allow-dependencies-change",
        allowed: true,
      },
      {
        action: "created",
        body:
          command === "/allow-dependencies-change"
            ? "/allow-security-sensitive-change"
            : "/allow-dependencies-change",
        allowed: false,
      },
      { action: "created", body: "Thanks for the update", allowed: false },
      { action: "edited", body: "Command removed", allowed: true },
      { action: "deleted", body: command, allowed: true },
      { action: "created", body: command, isPullRequest: false, allowed: false },
      { action: "edited", body: command, isPullRequest: false, allowed: false },
      { action: "deleted", body: command, isPullRequest: false, allowed: false },
      { eventName: "workflow_dispatch", ref: "refs/heads/main", allowed: true },
      { eventName: "workflow_dispatch", ref: "refs/heads/feature", allowed: false },
    ];
    for (const event of events) {
      for (const runId of [201, 202]) {
        const eventName = event.eventName ?? "issue_comment";
        const context = {
          github: {
            event_name: eventName,
            run_id: runId,
            ref: event.ref ?? "refs/heads/main",
            event: {
              action: event.action,
              comment: { body: event.body ?? "" },
              issue: {
                number: eventName === "issue_comment" ? 123 : undefined,
                pull_request: event.isPullRequest === false ? null : {},
              },
              pull_request: {
                number: eventName === "pull_request_target" ? 123 : undefined,
                draft: event.draft,
              },
              repository: { default_branch: "main" },
            },
          },
          inputs: { pr_number: eventName === "workflow_dispatch" ? "123" : undefined },
          always: () => true,
          contains: (value: string, search: string) =>
            value.toLowerCase().includes(search.toLowerCase()),
          format: (pattern: string, value: string | number) =>
            pattern.replace("{0}", String(value)),
        };
        const result = runInNewContext(condition.replace(/^\$\{\{|\}\}$/gu, ""), context);
        expect(Boolean(result), JSON.stringify(event)).toBe(event.allowed);
        const group = workflow.concurrency!.group.replace(
          /\$\{\{(.*?)\}\}/gsu,
          (_, expression: string) => String(runInNewContext(expression, context)),
        );
        expect(group, JSON.stringify(event)).toBe(
          event.allowed ? `${name}-123` : `${name}-ignored-${runId}`,
        );
      }
    }
  });

  it("uses an explicit Node runtime without shared dependency caches or bootstrap credentials", () => {
    expect(runtimeAction.runs.using).toBe("composite");
    const setup = runtimeAction.runs.steps.filter((step) => step.uses);
    expect(setup).toHaveLength(1);
    expect(setup[0]?.uses).toMatch(/^actions\/setup-node@[a-f0-9]{40}$/u);
    expect(setup[0]?.with).toEqual({ "node-version": "24.x", "package-manager-cache": false });
    for (const step of runtimeAction.runs.steps) {
      expect(step.env).toBeUndefined();
      expect(JSON.stringify(step)).not.toMatch(/github\.token|secrets\.|github\.event/u);
    }
  });

  it.skipIf(process.platform === "win32")(
    "installs only the frozen trusted tooling project and makes its policy packages importable",
    () => {
      const root = tempDirs.make("openclaw-security-review-runtime-");
      const workspace = join(root, "workspace");
      const runnerTemp = join(root, "runner");
      const bin = join(root, "bin");
      for (const directory of [workspace, runnerTemp, bin]) {
        mkdirSync(directory, { recursive: true });
      }
      const installLog = join(root, "install.json");
      const packages = Object.fromEntries(
        ["yaml", "minimatch"].map((name) => [name, realpathSync(`node_modules/${name}`)]),
      );
      // The external installer is replaced; the composite's shell and Node's ESM
      // resolution run unchanged against the repository's real installed packages.
      writeFileSync(
        join(bin, "npm"),
        `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(${JSON.stringify(installLog)}, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  manifest: JSON.parse(fs.readFileSync("package.json", "utf8")),
  lock: JSON.parse(fs.readFileSync("package-lock.json", "utf8")),
}));
fs.mkdirSync("node_modules");
for (const [name, target] of Object.entries(${JSON.stringify(packages)})) {
  fs.symlinkSync(target, path.join("node_modules", name), "dir");
}
`,
        { mode: 0o700 },
      );
      const installSteps = runtimeAction.runs.steps.filter((step) => step.run);
      expect(installSteps).toHaveLength(1);
      expect(installSteps[0]?.shell).toBe("bash");
      execFileSync("bash", ["-c", installSteps[0]!.run!], {
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          GITHUB_ACTION_PATH: resolve(runtimeActionPath),
          GITHUB_WORKSPACE: workspace,
          RUNNER_TEMP: runnerTemp,
        },
      });
      const installed = JSON.parse(readFileSync(installLog, "utf8")) as {
        args: string[];
        cwd: string;
        manifest: unknown;
        lock: unknown;
      };
      expect(installed.args).toEqual(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
      expect(installed.cwd.startsWith(`${realpathSync(runnerTemp)}/`)).toBe(true);
      expect(installed.manifest).toEqual(
        JSON.parse(readFileSync(`${runtimeActionPath}/package.json`, "utf8")),
      );
      expect(installed.lock).toEqual(
        JSON.parse(readFileSync(`${runtimeActionPath}/package-lock.json`, "utf8")),
      );
      const probe = join(workspace, "scripts/github/probe.mjs");
      writeFileSync(
        probe,
        'import { parse } from "yaml"; import { minimatch } from "minimatch"; console.log(JSON.stringify([parse("category: secrets").category, minimatch("src/secrets/.store/key", "src/secrets/**", { dot: true })]));',
      );
      expect(JSON.parse(execFileSync(process.execPath, [probe], { encoding: "utf8" }))).toEqual([
        "secrets",
        true,
      ]);
    },
  );

  it("keeps the frozen runtime dependency closure on the canonical repository pins and integrity", () => {
    const manifest = JSON.parse(readFileSync(`${runtimeActionPath}/package.json`, "utf8")) as {
      dependencies: Record<string, string>;
      overrides: Record<string, string>;
    };
    const root = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    const workspace = parse(readFileSync("pnpm-workspace.yaml", "utf8")) as {
      overrides: Record<string, string>;
    };
    const canonical = parse(
      pnpmLockfileDocuments(readFileSync("pnpm-lock.yaml", "utf8")).dependencies,
    ) as {
      packages: Record<string, { resolution: { integrity: string } }>;
      snapshots: Record<string, { dependencies?: Record<string, string> }>;
    };
    const lock = JSON.parse(readFileSync(`${runtimeActionPath}/package-lock.json`, "utf8")) as {
      packages: Record<
        string,
        { version: string; integrity: string; dependencies?: Record<string, string> }
      >;
    };
    expect(manifest.dependencies).toEqual({
      yaml: root.dependencies.yaml,
      minimatch: root.dependencies.minimatch,
    });
    expect(lock.packages[""]?.dependencies).toEqual(manifest.dependencies);
    for (const [name, version] of Object.entries(manifest.overrides)) {
      expect(version).toBe(workspace.overrides[name]);
    }
    const pending = Object.entries(manifest.dependencies);
    const expectedPackages = new Set([""]);
    for (const [name, version] of pending) {
      const key = `${name}@${version}`;
      const path = `node_modules/${name}`;
      expectedPackages.add(path);
      expect(lock.packages[path]).toMatchObject({
        version,
        integrity: canonical.packages[key]?.resolution.integrity,
      });
      for (const dependency of Object.entries(canonical.snapshots[key]?.dependencies ?? {})) {
        if (!expectedPackages.has(`node_modules/${dependency[0]}`)) {
          pending.push(dependency);
        }
      }
    }
    expect(Object.keys(lock.packages).toSorted()).toEqual([...expectedPackages].toSorted());
  });
});

const ownerRules = readFileSync(".github/CODEOWNERS", "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => {
    const [pattern, ...owners] = line.split(/\s+/u);
    return { matches: ignore({ ignorecase: false }).add(pattern ?? ""), owners };
  });

function ownersFor(path: string) {
  // CODEOWNERS uses gitignore-style patterns with last matching ownership winning.
  return ownerRules.findLast((rule) => rule.matches.ignores(path))?.owners ?? [];
}

describe("security review ownership", () => {
  it.each([
    ".github/CODEOWNERS",
    "SECURITY.md",
    ".github/codeql/codeql-core-auth-secrets-critical-security.yml",
    ".github/codeql/openclaw-boundary/queries/managed-proxy-runtime-mutation.ql",
    ".github/workflows/codeql-macos-critical-security.yml",
    ".github/workflows/security-sensitive-guard.yml",
    ".github/workflows/dependency-guard.yml",
    ".github/security-review-policy.yml",
    ".github/actions/setup-security-review/action.yml",
    ".github/actions/setup-security-review/package.json",
    ".github/actions/setup-security-review/package-lock.json",
    "scripts/github/security-review-policy.mjs",
    "scripts/github/guard-review.mjs",
    "scripts/github/guard-shared.mjs",
    "scripts/lib/bounded-response.mjs",
  ])("requires SecOps alone for %s", (path) => {
    expect(ownersFor(path)).toEqual(["@openclaw/openclaw-secops"]);
  });

  it.each([
    "src/gateway/auth.ts",
    "src/secrets/store/secret-store.ts",
    "src/agents/sandbox.ts",
    "pnpm-lock.yaml",
    ".gitignore",
    "docs/gateway/secrets.md",
  ])("leaves maintainer review authority for %s", (path) => {
    expect(ownersFor(path)).toEqual([]);
  });

  it("preserves separate release-manager ownership", () => {
    expect(ownersFor(".github/workflows/openclaw-npm-release.yml")).toEqual([
      "@openclaw/openclaw-release-managers",
    ]);
  });
});
