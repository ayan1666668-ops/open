import { readFileSync } from "node:fs";
import ignore from "ignore";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type WorkflowStep = {
  env?: Record<string, string>;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  name: string;
  "run-name"?: string;
  on: Record<string, { types?: string[]; workflows?: string[]; inputs?: Record<string, unknown> }>;
  permissions: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, { permissions?: Record<string, string>; steps: WorkflowStep[] }>;
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
        for (const step of job.steps) {
          if (step.uses) {
            // An unreviewed local action or artifact download could execute PR code
            // with the status/comment token, even if checkout itself remains safe.
            expect(step.uses).toMatch(
              name === "dependency-guard"
                ? /^actions\/(?:checkout|create-github-app-token)@[a-f0-9]{40}$/u
                : /^actions\/checkout@[a-f0-9]{40}$/u,
            );
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
    "%s reevaluates pushes and review changes in the same PR concurrency group",
    (name) => {
      const workflow = readWorkflow(name);
      const signal = readWorkflow("security-review-events");
      expect(workflow.on.pull_request_target?.types).toEqual(
        expect.arrayContaining(["opened", "reopened", "synchronize", "ready_for_review", "edited"]),
      );
      expect(workflow.on.workflow_run).toEqual({
        workflows: [signal.name],
        types: ["completed"],
      });
      expect(signal["run-name"]).toBe("PR ${{ github.event.pull_request.number }}");
      expect(workflow.concurrency?.group).toContain(
        "github.event.pull_request.number && format('PR {0}', github.event.pull_request.number) || github.event.workflow_run.display_title",
      );
      expect(workflow.on.workflow_dispatch?.inputs?.pr_number).toMatchObject({
        required: true,
        type: "string",
      });
      expect(workflow.concurrency?.group).toContain("format('PR {0}', inputs.pr_number)");
      expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
    },
  );

  it("keeps the fork review signal credential-free and unable to execute contributor code", () => {
    const signal = readWorkflow("security-review-events");
    expect(signal.on).toEqual({
      pull_request_review: { types: ["submitted", "edited", "dismissed"] },
    });
    expect(signal.permissions).toEqual({});
    const jobs = Object.values(signal.jobs);
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job.permissions ?? signal.permissions).toEqual({});
      for (const step of job.steps) {
        expect(step.uses).toBeUndefined();
        expect(step.env).toBeUndefined();
        // The signal carries the PR number in run-name, never files or shell input.
        expect(step.run).toMatch(/^echo '[A-Za-z ]+'$/u);
      }
    }
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
    ".github/workflows/security-review-events.yml",
    ".github/workflows/dependency-guard.yml",
    "scripts/github/security-sensitive-policy.mjs",
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
